import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { callbackKey } from '../../src/webhooks/emit.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId'],
                properties: { orderId: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/subscriptions': {
      post: {
        operationId: 'subscribe',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '200': { description: 'ok' } } }
            }
          }
        }
      }
    },
    '/guarded': {
      post: {
        operationId: 'guarded',
        security: [{ bearer: [] }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '200': { description: 'ok' } } }
            }
          }
        }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
}

const api = loadApi(doc)

const subscribe = (path = '/subscriptions', headers: Record<string, string> = {}) =>
  new Request(`http://mock${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ callbackUrl: 'http://hooks.test/mine' })
  })

test('a subscribing request captures its callback url', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await handler.fetch(subscribe())
  assert.equal(
    await handler.store.get(callbackKey('onOrderShipped')),
    'http://hooks.test/mine'
  )
})

test('a rejected request captures nothing', async () => {
  // A 401 has not subscribed to anything. Capturing from it would let an
  // unauthenticated caller redirect another tenant's webhooks.
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(subscribe('/guarded'))
  assert.equal(response.status, 401)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an operation declaring no callbacks captures nothing', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await handler.fetch(new Request('http://mock/subscriptions', { method: 'GET' }))
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an unresolvable expression captures nothing and does not throw', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(
    new Request('http://mock/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ somethingElse: true })
    })
  )
  assert.equal(response.status, 201)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an unsupported expression warns once at construction and is skipped', async () => {
  const warnings: string[] = []
  const unsupported = loadApi({
    ...doc,
    paths: {
      '/subscriptions': {
        post: {
          operationId: 'subscribe',
          responses: { '201': { description: 'created' } },
          callbacks: {
            onOrderShipped: {
              '{$request.cookie.cb}': {
                post: { responses: { '200': { description: 'ok' } } }
              }
            }
          }
        }
      }
    }
  })

  const handler = createHandler(unsupported, {
    seed: 'hooks',
    onWarn: (message) => warnings.push(message)
  })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /\$request\.cookie\.cb/)
  assert.match(warnings[0]!, /onOrderShipped/)

  await handler.fetch(new Request('http://mock/subscriptions', { method: 'POST' }))
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('a mixed-template expression with one unresolvable token captures nothing', async () => {
  // `resolveExpression` returns { ok: false } if ANY token in a template
  // fails. A half-substituted URL must never be captured — it would be
  // delivered somewhere unintended, which is worse than not delivering.
  const mixed = loadApi({
    ...doc,
    paths: {
      '/subscriptions': {
        post: {
          operationId: 'subscribe',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } }
          },
          responses: { '201': { description: 'created' } },
          callbacks: {
            onOrderShipped: {
              '{$request.body#/callbackUrl}/{$request.body#/missingToken}': {
                post: { responses: { '200': { description: 'ok' } } }
              }
            }
          }
        }
      }
    }
  })

  const handler = createHandler(mixed, { seed: 'hooks' })
  const response = await handler.fetch(subscribe())
  assert.equal(response.status, 201)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('emit generates a conforming payload and records the delivery', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })

  const delivery = await handler.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'captured')
  assert.equal(typeof (JSON.parse(delivery.body) as { orderId: unknown }).orderId, 'string')
  assert.deepEqual(handler.deliveries().map((d) => d.webhook), ['onOrderShipped'])
})

test('emit honors an explicit destination and a body override', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })

  const delivery = await handler.emit('onOrderShipped', {
    to: 'http://explicit.test/x',
    body: { orderId: 'o_9' }
  })

  assert.equal(delivery.url, 'http://explicit.test/x')
  assert.equal((JSON.parse(delivery.body) as { orderId: string }).orderId, 'o_9')
})

test('emit uses a url captured from an earlier subscription', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.fetch(subscribe())

  const delivery = await handler.emit('onOrderShipped')

  assert.equal(delivery.url, 'http://hooks.test/mine')
})

test('emit resolves rather than rejecting when nothing addresses it', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  const delivery = await handler.emit('onOrderShipped')
  assert.equal(delivery.outcome, 'unresolved')
})

test('emit throws on an undeclared webhook name', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await assert.rejects(handler.emit('nope'), /nope/)
})

test('clearDeliveries empties the log', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.emit('onOrderShipped')
  handler.clearDeliveries()
  assert.deepEqual(handler.deliveries(), [])
})

test('reset clears the delivery log too', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.emit('onOrderShipped')
  await handler.reset()
  assert.deepEqual(handler.deliveries(), [])
})

test('two emissions of one webhook get different payloads, and a replay reproduces both', async () => {
  // Pins the design point that the payload rng is keyed by webhook name and a
  // per-name ordinal (identity plus an ordinal), not one shared advancing
  // stream. Neither property is exercised by the tests above: each of those
  // calls `emit` at most once per handler.
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  const first = await handler.emit('onOrderShipped')
  const second = await handler.emit('onOrderShipped')
  assert.notEqual(first.body, second.body)

  await handler.reset()
  const replay = [await handler.emit('onOrderShipped'), await handler.emit('onOrderShipped')]
  assert.equal(replay[0]!.body, first.body)
  assert.equal(replay[1]!.body, second.body)
})

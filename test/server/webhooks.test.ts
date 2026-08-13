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

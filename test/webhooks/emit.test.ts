import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { createRng } from '../../src/generate/rng.ts'
import {
  callbackKey, createDeliveryLog, emitWebhook, MAX_DELIVERIES, resolveWebhook
} from '../../src/webhooks/emit.ts'

const api = loadApi({
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId', 'status'],
                properties: {
                  orderId: { type: 'string' },
                  status: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {}
})

function harness(status = 200) {
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const fetchStub = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: String(init.body),
      headers: init.headers as Record<string, string>
    })
    return new Response('', { status })
  }) as unknown as typeof fetch
  return { sent, fetch: fetchStub, sleep: async () => {} }
}

const baseInput = {
  api,
  captureOnly: false,
  seed: 'plan6',
  generateOptions: { schemaNames: api.schemaNames },
  now: () => 1_700_000_000
}

test('an unknown webhook name throws, like every other target typo', async () => {
  const h = harness()
  await assert.rejects(
    emitWebhook({
      ...baseInput, name: 'nope', config: resolveWebhook(),
      store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
    }),
    /nope/
  )
})

test('the payload is generated from the declared schema', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput,
    name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  const body = JSON.parse(delivery.body) as Record<string, unknown>
  assert.equal(typeof body['orderId'], 'string')
  assert.equal(typeof body['status'], 'string')
  assert.equal(delivery.outcome, 'delivered')
})

test('a body override layers over the generated payload', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput,
    name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    bodyOverride: { orderId: 'o_1' },
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  const body = JSON.parse(delivery.body) as Record<string, unknown>
  assert.equal(body['orderId'], 'o_1')
  // The un-overridden property still comes from generation.
  assert.equal(typeof body['status'], 'string')
})

test('destination precedence: to beats a captured url beats config', async () => {
  const store = createMemoryStore()
  await store.set(callbackKey('onOrderShipped'), 'http://captured.test/x')
  const config = resolveWebhook({ url: 'http://config.test/x' })

  const first = harness()
  const withTo = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config, to: 'http://explicit.test/x',
    store, rng: createRng('t'), fetch: first.fetch, sleep: first.sleep
  })
  assert.equal(withTo.url, 'http://explicit.test/x')

  const second = harness()
  const withCapture = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config,
    store, rng: createRng('t'), fetch: second.fetch, sleep: second.sleep
  })
  assert.equal(withCapture.url, 'http://captured.test/x')

  const third = harness()
  const withConfig = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config,
    store: createMemoryStore(), rng: createRng('t'), fetch: third.fetch, sleep: third.sleep
  })
  assert.equal(withConfig.url, 'http://config.test/x')
})

test('nothing resolving is unresolved, not an error', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config: resolveWebhook(),
    store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
  })
  assert.equal(delivery.outcome, 'unresolved')
  assert.equal(delivery.url, undefined)
  assert.deepEqual(h.sent, [])
})

test('a secret adds the signature header over the exact body sent', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput,
    name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x', secret: 'topsecret' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  const header = delivery.headers['x-mockingham-signature']
  assert.ok(header, 'signature header missing')
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/)
  // The signature must cover the body that was actually transmitted.
  assert.equal(h.sent[0]?.body, delivery.body)
})

test('no secret means no signature header', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput, name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
  })
  assert.equal(delivery.headers['x-mockingham-signature'], undefined)
})

test('configured headers travel with the delivery', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput, name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x', headers: { 'x-source': 'mockingham' } }),
    store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
  })
  assert.equal(delivery.headers['x-source'], 'mockingham')
  assert.equal(delivery.headers['content-type'], 'application/json')
})

test('a header parameter declared on the webhook is generated', async () => {
  // The same treatment renderResponse gives spec-declared response headers.
  const withHeader = loadApi({
    openapi: '3.1.0',
    webhooks: {
      onPing: {
        post: {
          parameters: [
            { name: 'X-Topic', in: 'header', required: true, schema: { const: 'orders' } }
          ],
          responses: { '200': { description: 'ok' } }
        }
      }
    },
    paths: {}
  })
  const h = harness()

  const delivery = await emitWebhook({
    ...baseInput,
    api: withHeader,
    name: 'onPing',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  assert.equal(delivery.headers['x-topic'], 'orders')
})

test('a configured header beats a declared one of the same name', async () => {
  const withHeader = loadApi({
    openapi: '3.1.0',
    webhooks: {
      onPing: {
        post: {
          parameters: [
            { name: 'X-Topic', in: 'header', required: true, schema: { const: 'orders' } }
          ],
          responses: { '200': { description: 'ok' } }
        }
      }
    },
    paths: {}
  })
  const h = harness()

  const delivery = await emitWebhook({
    ...baseInput,
    api: withHeader,
    name: 'onPing',
    config: resolveWebhook({ url: 'http://hooks.test/x', headers: { 'X-Topic': 'explicit' } }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  assert.equal(delivery.headers['x-topic'], 'explicit')
})

test('the delivery log is bounded and drops oldest first', () => {
  const log = createDeliveryLog(2)
  const make = (webhook: string) => ({
    webhook, body: '', headers: {}, outcome: 'captured' as const, attempts: 0
  })
  log.record(make('a'))
  log.record(make('b'))
  log.record(make('c'))
  assert.deepEqual(log.all().map((d) => d.webhook), ['b', 'c'])
  log.clear()
  assert.deepEqual(log.all(), [])
})

test('MAX_DELIVERIES matches the documented bound (design §2.6)', () => {
  // Pins the constant itself: `createDeliveryLog`'s default argument means
  // nothing else in the suite exercises 1000 specifically, so a change to the
  // constant alone would leave every other test green.
  assert.equal(MAX_DELIVERIES, 1000)
})

test('a webhook declared with a non-POST method is delivered with that method (I5)', async () => {
  const withMethod = loadApi({
    openapi: '3.1.0',
    webhooks: {
      onInventorySync: {
        put: { responses: { '200': { description: 'ok' } } }
      }
    },
    paths: {}
  })
  const sent: Array<{ method: string }> = []
  const fetchStub = (async (_url: string, init: RequestInit) => {
    sent.push({ method: String(init.method) })
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch

  await emitWebhook({
    ...baseInput,
    api: withMethod,
    name: 'onInventorySync',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: fetchStub,
    sleep: async () => {}
  })

  assert.deepEqual(sent, [{ method: 'PUT' }])
})

test('a webhook declared get: delivers rather than failing (regression)', async () => {
  const withGet = loadApi({
    openapi: '3.1.0',
    webhooks: {
      onPing: {
        get: { responses: { '200': { description: 'ok' } } }
      }
    },
    paths: {}
  })
  const sent: Array<{ method: string; hasBody: boolean }> = []
  const fetchStub = (async (_url: string, init: RequestInit) => {
    sent.push({ method: String(init.method), hasBody: 'body' in init })
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch

  const delivery = await emitWebhook({
    ...baseInput,
    api: withGet,
    name: 'onPing',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: fetchStub,
    sleep: async () => {}
  })

  assert.equal(delivery.outcome, 'delivered')
  assert.deepEqual(sent, [{ method: 'GET', hasBody: false }])
})

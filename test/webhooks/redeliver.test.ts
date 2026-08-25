import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createDeliveryLog, redeliverWebhook, resolveWebhook } from '../../src/webhooks/emit.ts'
import { SIGNATURE_HEADER } from '../../src/webhooks/sign.ts'
import type { Delivery } from '../../src/webhooks/deliver.ts'
import { createMock } from '../../src/index.ts'

// Records every outbound call, so a redelivery is observable as a second one.
// A `redeliver` that returned the stored record without sending anything would
// pass every assertion about bytes and ids; only the call count catches it.
function recordingFetch(status = 200) {
  const calls: Request[] = []
  const fn: typeof fetch = async (input, init) => {
    calls.push(new Request(input as never, init))
    return new Response('ok', { status })
  }
  return Object.assign(fn, { calls })
}

const doc = {
  openapi: '3.1.0',
  webhooks: {
    w: {
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
  paths: {}
}

test('a redelivery reproduces bytes, signature and id', async () => {
  const fetchStub = recordingFetch()
  const mock = createMock(doc, {
    seed: 'fixed',
    webhooks: { w: { url: 'https://x.example/h', secret: 's' } },
    fetch: fetchStub,
    sleep: async () => {}
  })
  const first = await mock.emit('w')
  const again = await mock.redeliver(first.id)

  assert.equal(again.id, first.id)
  assert.equal(again.body, first.body)
  assert.equal(again.url, first.url)
  assert.equal(again.outcome, 'delivered')
  assert.equal(again.headers[SIGNATURE_HEADER], first.headers[SIGNATURE_HEADER])
  // The signature is replayed verbatim, not recomputed - design §7.3. Assert on
  // a real value, not merely on equality of two possibly-absent fields.
  assert.match(String(first.headers[SIGNATURE_HEADER]), /^t=\d+,v1=[0-9a-f]{64}$/)

  // It really went out again, and it went out with the same bytes on the wire.
  assert.equal(fetchStub.calls.length, 2)
  assert.equal(fetchStub.calls[1]!.url, 'https://x.example/h')
  assert.equal(await fetchStub.calls[1]!.text(), first.body)
  assert.equal(fetchStub.calls[1]!.headers.get(SIGNATURE_HEADER), first.headers[SIGNATURE_HEADER])

  // A second record in the log, sharing one id: two deliveries, one identity.
  const log = mock.deliveries().filter((d) => d.id === first.id)
  assert.equal(log.length, 2)
})

test('a redelivery replays the recorded destination rather than re-resolving it', async () => {
  const fetchStub = recordingFetch()
  const mock = createMock(doc, {
    seed: 'fixed',
    webhooks: { w: { url: 'https://configured.example/h' } },
    fetch: fetchStub,
    sleep: async () => {}
  })
  // An explicit `to` beats the configured url on the first send. If redelivery
  // re-resolved the destination it would fall back to the configured one.
  const first = await mock.emit('w', { to: 'https://explicit.example/h' })
  const again = await mock.redeliver(first.id)

  assert.equal(again.url, 'https://explicit.example/h')
  assert.equal(fetchStub.calls.length, 2)
  assert.equal(fetchStub.calls[1]!.url, 'https://explicit.example/h')
})

test('a redelivery does not regenerate the payload', async () => {
  const fetchStub = recordingFetch()
  const mock = createMock(doc, {
    seed: 'fixed',
    webhooks: { w: { url: 'https://x.example/h' } },
    fetch: fetchStub,
    sleep: async () => {}
  })
  const first = await mock.emit('w')
  // A second EMISSION draws a fresh ordinal and so generates different bytes.
  const second = await mock.emit('w')
  assert.notEqual(second.body, first.body, 'precondition: emissions differ')

  const again = await mock.redeliver(first.id)
  assert.equal(again.body, first.body)
  assert.notEqual(again.body, second.body)
})

test('a redelivery that fails is a recorded outcome, never a throw', async () => {
  const fetchStub = recordingFetch(500)
  const mock = createMock(doc, {
    seed: 'fixed',
    webhooks: { w: { url: 'https://x.example/h', retry: { attempts: 1 } } },
    fetch: fetchStub,
    sleep: async () => {}
  })
  const first = await mock.emit('w')
  const again = await mock.redeliver(first.id)
  assert.equal(again.outcome, 'failed')
  assert.equal(again.status, 500)
  assert.equal(again.id, first.id)
})

test('an unknown delivery id throws with an instructive message', async () => {
  const mock = createMock(doc, { captureOnly: true })
  await assert.rejects(
    () => mock.redeliver('nope'),
    (error: Error) => {
      assert.equal(
        error.message,
        'mockingham: no delivery with id "nope" is in the delivery log. ' +
          'Redeliver an id returned by emit() or listed by deliveries().'
      )
      return true
    }
  )
})

test('an id that has aged out of the log throws with a message naming the bound', async () => {
  // A two-entry log rather than 1001 emissions: the bound under test is the
  // log's own capacity, and the message must name whatever it is.
  const log = createDeliveryLog(2)
  const record = (id: string): Delivery => ({
    id, webhook: 'w', url: 'https://x.example/h', body: '{}', headers: {},
    outcome: 'delivered', status: 200, attempts: 1
  })
  log.record(record('aaa'))
  log.record(record('bbb'))
  log.record(record('ccc'))

  await assert.rejects(
    () => redeliverWebhook({
      id: 'aaa',
      api: loadApi(doc),
      log,
      configFor: () => resolveWebhook(),
      captureOnly: false,
      seed: 'fixed',
      fetch: recordingFetch(),
      sleep: async () => {}
    }),
    (error: Error) => {
      assert.equal(
        error.message,
        'mockingham: no delivery with id "aaa" is in the delivery log. ' +
          'The log keeps only the most recent 2 deliveries and 1 older one has ' +
          'been evicted, so this id may have aged out.'
      )
      return true
    }
  )
})

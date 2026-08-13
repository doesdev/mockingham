import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backoffFor, deliver, resolveRetry, shouldRetry
} from '../../src/webhooks/deliver.ts'

const retry = resolveRetry({ attempts: 3, baseMs: 250, maxDelayMs: 10_000 })

function harness(responses: Array<Response | Error>) {
  const slept: number[] = []
  const urls: string[] = []
  let call = 0
  const fetchStub = (async (input: Request | string) => {
    urls.push(typeof input === 'string' ? input : input.url)
    const next = responses[Math.min(call++, responses.length - 1)]!
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { slept, urls, fetch: fetchStub, sleep: async (ms: number) => { slept.push(ms) } }
}

const base = {
  webhook: 'onOrderShipped',
  url: 'http://hooks.test/x',
  body: '{"id":1}',
  headers: { 'content-type': 'application/json' },
  captureOnly: false,
  retry,
  seed: 'plan6'
}

test('resolveRetry fills the documented defaults', () => {
  assert.deepEqual(resolveRetry(), { attempts: 3, baseMs: 250, maxDelayMs: 10_000 })
})

test('shouldRetry covers 5xx, 408, and 429 only', () => {
  for (const status of [500, 502, 503, 408, 429]) {
    assert.equal(shouldRetry(status), true, String(status))
  }
  for (const status of [200, 201, 400, 401, 403, 404, 422]) {
    assert.equal(shouldRetry(status), false, String(status))
  }
})

test('backoff is deterministic, seeded, and capped', () => {
  const first = backoffFor({ seed: 'plan6', webhook: 'w', attempt: 0, retry })
  assert.equal(first, backoffFor({ seed: 'plan6', webhook: 'w', attempt: 0, retry }))
  assert.notEqual(first, backoffFor({ seed: 'plan6', webhook: 'w', attempt: 1, retry }))
  assert.notEqual(first, backoffFor({ seed: 'other', webhook: 'w', attempt: 0, retry }))
  // Jittered into [50%, 100%] of the doubling base, and never past the cap.
  assert.ok(first >= 125 && first <= 250, String(first))
  const late = backoffFor({ seed: 'plan6', webhook: 'w', attempt: 20, retry })
  assert.ok(late >= 5_000 && late <= 10_000, String(late))
})

test('a 2xx delivers on the first attempt with no sleeping', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.status, 200)
  assert.equal(delivery.attempts, 1)
  assert.deepEqual(h.slept, [])
})

test('a 500 retries to the attempt limit, sleeping the exact seeded sequence', async () => {
  // Asserting "it retried" would pass against a classifier that retries
  // everything, and asserting a sleep happened would pass against a constant
  // delay. Both the count and the sequence are pinned.
  const h = harness([new Response('', { status: 500 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })

  assert.equal(delivery.outcome, 'failed')
  assert.equal(delivery.status, 500)
  assert.equal(delivery.attempts, 3)
  // Literal rather than computed: deriving the expectation from backoffFor()
  // would make any mutation to it change both sides of this assertion equally,
  // and the test could never fail. These are the seeded values for
  // seed 'plan6', webhook 'onOrderShipped', attempts 0 and 1 — a change to the
  // seed, the jitter formula, or the PRNG is expected to change them.
  assert.deepEqual(h.slept, [243, 371])
})

test('a 404 does not retry', async () => {
  const h = harness([new Response('', { status: 404 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'failed')
  assert.equal(delivery.status, 404)
  assert.equal(delivery.attempts, 1)
  assert.deepEqual(h.slept, [])
})

test('a network error retries and is reported', async () => {
  const h = harness([new Error('econnrefused'), new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.attempts, 2)
  assert.equal(h.slept.length, 1)
})

test('an exhausted network failure reports the error and no status', async () => {
  const h = harness([new Error('econnrefused')])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'failed')
  assert.equal(delivery.status, undefined)
  assert.equal(delivery.error, 'econnrefused')
  assert.equal(delivery.attempts, 3)
})

test('captureOnly never calls fetch', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, captureOnly: true, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'captured')
  assert.equal(delivery.attempts, 0)
  assert.deepEqual(h.urls, [])
})

test('an absent url is unresolved and never calls fetch', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, url: undefined, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'unresolved')
  assert.equal(delivery.attempts, 0)
  assert.equal(delivery.status, undefined)
  assert.deepEqual(h.urls, [])
})

test('the delivery carries the body and headers it was given', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.body, '{"id":1}')
  assert.deepEqual(delivery.headers, { 'content-type': 'application/json' })
  assert.equal(delivery.webhook, 'onOrderShipped')
  assert.equal(delivery.url, 'http://hooks.test/x')
})

test('GET and HEAD never carry a body — undici throws otherwise', async () => {
  // Regression from I5's method plumbing: undici (and fetch generally) throws
  // "Request with GET/HEAD method cannot have body" rather than dropping it.
  // Before the fix, a webhook declared `get:` or `head:` burned every retry
  // attempt against a guaranteed throw and recorded `outcome: 'failed'` where
  // it previously (incorrectly) delivered as a POST.
  for (const method of ['GET', 'HEAD']) {
    const inits: RequestInit[] = []
    const fetchStub = (async (_url: string, init: RequestInit) => {
      inits.push(init)
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    const delivery = await deliver({
      ...base, method, fetch: fetchStub, sleep: async () => {}
    })

    assert.equal(delivery.outcome, 'delivered', method)
    assert.equal('body' in inits[0]!, false, method)
    assert.equal(inits[0]!.method, method)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'

/**
 * Two branches distinguished by a const property and nothing else, so the only
 * thing that can decide between them is the variant directive or the seeded
 * pick. `created` carries an extra property so a branch chosen by luck is
 * distinguishable from the branch actually walked.
 *
 * No `security` anywhere in this document on purpose: auth is pipeline stage 3,
 * so a declared scheme would 401 every unauthenticated request below and make
 * every assertion after it unreachable.
 */
const union = {
  oneOf: [
    {
      type: 'object',
      required: ['outcome', 'id'],
      properties: { outcome: { const: 'created' }, id: { type: 'string' } }
    },
    {
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { const: 'conflict' } }
    }
  ]
}

const unionDoc = {
  openapi: '3.1.0',
  info: { title: 'variants', version: '1' },
  webhooks: {
    onUpserted: {
      post: {
        requestBody: { content: { 'application/json': { schema: union } } },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/upsert': {
      post: {
        operationId: 'upsert',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: union } }
          }
        }
      }
    }
  }
}

const SEED = 'variants'

/**
 * The seeded pick for this document under this seed, pinned. Every test below
 * asks for the OTHER branch, which is the only way any of them can fail: the
 * plan's own draft asked for the branch the PRNG already returns, so it passed
 * before the feature existed. If the PRNG ever changes, this assertion breaks
 * loudly and names the reason rather than quietly hollowing out the file.
 */
const SEEDED_OUTCOME = 'created'
const REQUESTED_OUTCOME = 'conflict'

const upsert = (headers: Record<string, string> = {}): Request =>
  new Request('http://mock/upsert', { method: 'POST', headers })

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>

test('the seeded baseline is the branch these tests do NOT ask for', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  const body = await bodyOf(await mock.fetch(upsert()))
  assert.equal(
    body.outcome,
    SEEDED_OUTCOME,
    'the seeded pick must differ from the branch the tests below request, or ' +
      'none of them can fail'
  )
  assert.notEqual(SEEDED_OUTCOME, REQUESTED_OUTCOME)
})

test('Prefer: variant= selects the branch', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  const body = await bodyOf(await mock.fetch(upsert({ prefer: 'variant=conflict' })))
  assert.equal(body.outcome, 'conflict')
  // The branch, not just the discriminator: `conflict` declares no `id`.
  assert.equal(body.id, undefined)
})

test('a stored variant applies with no Prefer header', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  await mock.setVariant('upsert', 'conflict')
  const body = await bodyOf(await mock.fetch(upsert()))
  assert.equal(body.outcome, 'conflict')
})

test('Prefer beats the stored variant', async () => {
  // Two DIFFERENT names, so whichever wins is unambiguous. Storing and
  // requesting the same name would pass under either precedence.
  const mock = createMock(unionDoc, { seed: SEED })
  await mock.setVariant('upsert', 'created')
  const body = await bodyOf(await mock.fetch(upsert({ prefer: 'variant=conflict' })))
  assert.equal(body.outcome, 'conflict')
})

test('clearVariants removes the stored preference', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  await mock.setVariant('upsert', 'conflict')
  await mock.clearVariants('upsert')
  const first = await bodyOf(await mock.fetch(upsert()))

  const fresh = createMock(unionDoc, { seed: SEED })
  const baseline = await bodyOf(await fresh.fetch(upsert()))

  assert.deepEqual(first, baseline)
  // Guards against "cleared" and "never stored" both resolving to the stored
  // branch: the shared value must be the seeded one.
  assert.equal(baseline.outcome, SEEDED_OUTCOME)
})

test('clearVariants with no target clears every operation', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  await mock.setVariant('upsert', 'conflict')
  await mock.clearVariants()
  const body = await bodyOf(await mock.fetch(upsert()))
  assert.equal(body.outcome, SEEDED_OUTCOME)
})

test('reset clears a stored variant', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  await mock.setVariant('upsert', 'conflict')
  await mock.reset()
  const body = await bodyOf(await mock.fetch(upsert()))
  assert.equal(body.outcome, SEEDED_OUTCOME)
})

test('setVariant throws on a target that resolves to no operation', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  await assert.rejects(mock.setVariant('nosuchop', 'conflict'), /nosuchop/)
})

test('an unmatched variant name falls through rather than failing', async () => {
  const mock = createMock(unionDoc, { seed: SEED })
  const response = await mock.fetch(upsert({ prefer: 'variant=nonexistent' }))
  assert.equal(response.status, 200)
  assert.equal((await bodyOf(response)).outcome, SEEDED_OUTCOME)
})

test('a Prefer: variant= on the request does NOT steer a webhook payload', async () => {
  // Design section 5.4: `runEmit` builds its own generateOptions and must not
  // receive the request's variant — an emitted webhook has no request behind
  // it. The webhook body is the SAME union, so a leak would be visible.
  //
  // The request asks for `created`; the emission's own seeded pick is
  // `conflict`. Those differ, which is the only reason this can fail.
  const options = {
    seed: SEED,
    captureOnly: true,
    webhooks: { onUpserted: { url: 'http://hooks.test/u' } },
    operations: { upsert: { emits: [{ webhook: 'onUpserted' }] } }
  }

  const steered = createMock(unionDoc, options)
  const steeredBody = await bodyOf(await steered.fetch(upsert({ prefer: 'variant=created' })))
  assert.equal(steeredBody.outcome, 'created', 'the response itself must be steered')
  await steered.settled()

  const control = createMock(unionDoc, options)
  await control.fetch(upsert())
  await control.settled()

  const delivered = JSON.parse(steered.deliveries()[0]!.body) as Record<string, unknown>
  assert.equal(delivered.outcome, 'conflict')
  assert.equal(steered.deliveries()[0]!.body, control.deliveries()[0]!.body)
})

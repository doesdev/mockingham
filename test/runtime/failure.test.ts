import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFailure } from '../../src/runtime/failure.ts'
import type { FailureInput, FailurePolicy } from '../../src/runtime/failure.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { compileTarget } from '../../src/resolve/target.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { Operation } from '../../src/spec/types.ts'

const operation: Operation = {
  method: 'get', path: '/x', operationId: 'x', parameters: [], responses: []
}

/**
 * Compiles policies the way the handler does, but WITHOUT compilePolicies'
 * construction-time check that every target matches something — one test needs a
 * policy that deliberately matches nothing, and compilePolicies throws on those.
 */
function compile(policies: FailurePolicy[]) {
  return policies.map((policy, index) => ({
    id: `${index}|${policy.match}`,
    matches: compileTarget(policy.match).matches,
    policy
  }))
}

function input(
  overrides: Omit<Partial<FailureInput>, 'policies'> & { policies?: FailurePolicy[] } = {}
) {
  const slept: number[] = []
  const { policies, ...rest } = overrides
  const args: FailureInput = {
    operation,
    ctx: {} as Ctx,
    policies: compile(policies ?? []),
    store: createMemoryStore(),
    chaosSeed: 'chaos',
    requestKey: 'k',
    counter: () => 0,
    sleep: async (ms: number) => { slept.push(ms) },
    ...rest
  }
  return { slept, args }
}

test('no policies means no failure', async () => {
  const { args } = input()
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('a policy matching no operation is ignored', async () => {
  const { args } = input({
    policies: [{ match: 'GET /other', rate: 1, respond: 503 }]
  })
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('rate 1 always fails with the configured status', async () => {
  const { args } = input({ policies: [{ match: 'x', rate: 1, respond: 503 }] })
  const outcome = await checkFailure(args)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 503)
})

test('rate 0 never fails', async () => {
  const { args } = input({ policies: [{ match: 'x', rate: 0, respond: 503 }] })
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('decide wins over every policy', async () => {
  const { args } = input({
    policies: [{ match: 'x', rate: 0 }],
    decide: () => ({ status: 500 })
  })
  const outcome = await checkFailure(args)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 500)
})

test('a decide directive can set its own error code', async () => {
  const { args } = input({ decide: () => ({ status: 429, code: 'MY_CODE' }) })
  const outcome = await checkFailure(args)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.status, 429)
    assert.equal(outcome.code, 'MY_CODE')
  }
})

test('a decide directive without a code uses the default', async () => {
  const { args } = input({ decide: () => ({ status: 500 }) })
  const outcome = await checkFailure(args)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'MOCK_FAILURE_INJECTED')
})

test('decide returning undefined falls through', async () => {
  const { args } = input({ policies: [], decide: () => undefined })
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('failNext fires the configured number of times then stops', async () => {
  const store = createMemoryStore()
  await store.set('failnext|x', { times: 2, status: 500 })
  const { args } = input({ store })
  const first = await checkFailure(args)
  const second = await checkFailure(args)
  const third = await checkFailure(args)
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
  assert.equal(third.ok, true)
})

test('an outage fails until its deadline passes', async () => {
  let time = 0
  const store = createMemoryStore(() => time)
  await store.set('outage|x', { status: 503 }, 1000)
  const { args } = input({ store })
  assert.equal((await checkFailure(args)).ok, false)
  time = 1001
  assert.equal((await checkFailure(args)).ok, true)
})

test('latency is awaited even when the request succeeds', async () => {
  const { args, slept } = input({ policies: [{ match: 'x', latency: 250 }] })
  assert.deepEqual(await checkFailure(args), { ok: true })
  assert.deepEqual(slept, [250])
})

test('a latency function receives ctx', async () => {
  const { args, slept } = input({ policies: [{ match: 'x', latency: () => 42 }] })
  await checkFailure(args)
  assert.deepEqual(slept, [42])
})

test('the circuit opens after the configured failure count', async () => {
  const store = createMemoryStore()
  const { args } = input({
    store,
    policies: [{ match: 'x', rate: 1, respond: 500, circuit: { after: 2, openFor: 1000, then: 429 } }]
  })
  const first = await checkFailure(args)
  const second = await checkFailure(args)
  const third = await checkFailure(args)
  assert.equal(first.ok, false)
  if (!first.ok) assert.equal(first.status, 500)
  assert.equal(second.ok, false)
  // Once open, the circuit's own status takes over.
  assert.equal(third.ok, false)
  if (!third.ok) assert.equal(third.status, 429)
})

test('the same request sequence is reproducible across fresh instances', async () => {
  const run = async () => {
    let n = 0
    const { args } = input({
      policies: [{ match: 'x', rate: 0.5, respond: 503 }],
      counter: () => n++
    })
    const results: boolean[] = []
    for (let i = 0; i < 20; i++) results.push((await checkFailure(args)).ok)
    return results
  }
  assert.deepEqual(await run(), await run())
})

test('repeated identical calls do not all share one outcome', async () => {
  let n = 0
  const { args } = input({
    policies: [{ match: 'x', rate: 0.5, respond: 503 }],
    counter: () => n++
  })
  const results: boolean[] = []
  for (let i = 0; i < 20; i++) results.push((await checkFailure(args)).ok)
  // Seeding per invocation rather than per request identity is what makes a
  // rate behave like a rate instead of a permanent verdict.
  assert.ok(new Set(results).size > 1)
})

test('the circuit counter decays after its window', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 503, within: 500 } }
  ]

  const { args } = input({ policies, store, counter: () => 1 })
  await checkFailure(args)
  value += 600
  // The first failure aged out of the window, so this one starts a new count
  // and the circuit does not open.
  await checkFailure(input({ policies, store, counter: () => 2 }).args)

  assert.equal(await store.get('circuit-open|0|x'), undefined)
  assert.equal(await store.get('circuit-count|0|x'), 1)
})

test('the circuit opens inside its window', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 503, within: 500 } }
  ]

  await checkFailure(input({ policies, store, counter: () => 1 }).args)
  value += 100
  await checkFailure(input({ policies, store, counter: () => 2 }).args)

  assert.equal(await store.get('circuit-open|0|x'), true)
})

test('within defaults to openFor', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 400, then: 503 } }
  ]

  await checkFailure(input({ policies, store, counter: () => 1 }).args)
  value += 500
  await checkFailure(input({ policies, store, counter: () => 2 }).args)

  assert.equal(await store.get('circuit-open|0|x'), undefined)
})

test('two policies matching one operation keep separate circuits', async () => {
  const store = createMemoryStore()
  // NOTE the second target's spelling. A bare '*' has no space in it, so
  // `compileTarget` reads it as an operationId and it matches NOTHING — which
  // would make the second assertion below pass for entirely the wrong reason.
  // '* /x' is the match-any-method form. See src/resolve/target.ts.
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 503 } },
    { match: '* /x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 504 } }
  ]

  await checkFailure(input({ policies, store, counter: () => 1 }).args)

  // Both policies match this operation, but the first one fired and returned,
  // so only its counter moved — and it moved under its OWN key. Sharing one key
  // per operation is the bug: the second policy's failures would land on the
  // first policy's counter and open a circuit neither policy asked for.
  assert.equal(await store.get('circuit-count|0|x'), 1)
  assert.equal(await store.get('circuit-count|1|* /x'), undefined)
})

test('a bare star target matches nothing, so the fixture above is honest', () => {
  // Guards the note above: if compileTarget ever started treating a bare '*' as
  // a wildcard, the previous test would still pass but would stop proving what
  // it claims. This is the canary for that.
  assert.equal(compileTarget('*').matches(operation), false)
  assert.equal(compileTarget('* /x').matches(operation), true)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLinkTable, LINK_MAX } from '../../src/runtime/link.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { runCapture } from '../../src/runtime/capture.ts'
import type { CaptureRule } from '../../src/runtime/capture.ts'

const rules = [{ ttlMs: 1000, max: LINK_MAX }, { ttlMs: 1000, max: LINK_MAX }]

test('a recorded value recalls under its own rule index', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await table.record(0, 'ord_1', { id: 'ord_1', total: 9 })
  assert.deepEqual(await table.recall(0, 'ord_1'), { id: 'ord_1', total: 9 })
})

test('rule indices do not collide on the same key value', async () => {
  // Two rules recording the SAME key string; keyed by index, so they must
  // not overwrite each other. A one-rule fixture cannot prove this.
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await table.record(0, 'x', 'from-rule-0')
  await table.record(1, 'x', 'from-rule-1')
  assert.equal(await table.recall(0, 'x'), 'from-rule-0')
  assert.equal(await table.recall(1, 'x'), 'from-rule-1')
})

test('an unrecorded key recalls undefined', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  assert.equal(await table.recall(0, 'never-written'), undefined)
})

test('the oldest entry is evicted past max', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), [{ ttlMs: 1000, max: 2 }])
  await table.record(0, 'a', 1)
  await table.record(0, 'b', 2)
  await table.record(0, 'c', 3)
  assert.equal(await table.recall(0, 'a'), undefined)  // evicted
  assert.equal(await table.recall(0, 'b'), 2)
  assert.equal(await table.recall(0, 'c'), 3)
})

test('an entry past its ttl recalls undefined', async () => {
  // The TTL is the other half of the bound. A fixed advancing clock rather
  // than a real wait: the store expires lazily against the injected `now`.
  let clock = 0
  const table = createLinkTable(createMemoryStore(() => clock), [{ ttlMs: 1000, max: 10 }])
  await table.record(0, 'a', { id: 'a' })
  clock = 999
  assert.deepEqual(await table.recall(0, 'a'), { id: 'a' })
  clock = 1001
  assert.equal(await table.recall(0, 'a'), undefined)
})

function captureInput(rule: CaptureRule, responseBody: unknown, table: unknown) {
  return {
    rules: [rule],
    expr: {
      request: new Request('http://mock/orders', { method: 'POST' }),
      url: new URL('http://mock/orders'),
      method: 'POST',
      params: {},
      body: { hint: 'req' },
      result: { status: 201, headers: {}, body: responseBody }
    },
    store: createMemoryStore(() => 0),
    responseBody,
    requestBody: { hint: 'req' },
    link: table as ReturnType<typeof createLinkTable>
  }
}

test('a whole-body remember records the body as a VALUE, not a resolved string', async () => {
  // The sharp edge from design §4.2: `resolveExpression` funnels body values
  // through a scalar coercion, so `{$response.body}` resolves to a FAILURE for
  // an object. Recording nothing here would make the default configuration —
  // the one nearly every caller uses — silently never link.
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  const body = { id: 'ord_1', total: 9, nested: { deep: true } }
  await runCapture(captureInput(
    { kind: 'link', index: 0, keyExpr: '{$response.body#/id}', remember: '{$response.body}' },
    body,
    table
  ))
  assert.deepEqual(await table.recall(0, 'ord_1'), body)
})

test('a whole-request-body remember records the request body', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await runCapture(captureInput(
    { kind: 'link', index: 0, keyExpr: '{$response.body#/id}', remember: '{$request.body}' },
    { id: 'ord_2' },
    table
  ))
  assert.deepEqual(await table.recall(0, 'ord_2'), { hint: 'req' })
})

test('a pointer remember addressing a scalar goes through the expression', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await runCapture(captureInput(
    {
      kind: 'link',
      index: 0,
      keyExpr: '{$response.body#/id}',
      remember: '{$response.body#/total}'
    },
    { id: 'ord_3', total: 9 },
    table
  ))
  assert.equal(await table.recall(0, 'ord_3'), '9')
})

test('a key that does not resolve records nothing', async () => {
  // Not merely "no throw": recording under an empty key would make every
  // unkeyed write collide, and a later read of the empty key would recall a
  // body it has no business recalling.
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await runCapture(captureInput(
    { kind: 'link', index: 0, keyExpr: '{$response.body#/absent}', remember: '{$response.body}' },
    { id: 'ord_4' },
    table
  ))
  assert.equal(await table.recall(0, ''), undefined)
  assert.equal(await table.recall(0, 'ord_4'), undefined)
})

test('a recalled object is not the stored instance', async () => {
  // The recalled value is layered on and may be walked by the override
  // machinery. Handing out the stored reference would let one request's
  // rendering mutate what every later recall replays.
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await table.record(0, 'ord_1', { id: 'ord_1', nested: { n: 1 } })
  const first = await table.recall(0, 'ord_1') as { nested: { n: number } }
  first.nested.n = 99
  assert.deepEqual(await table.recall(0, 'ord_1'), { id: 'ord_1', nested: { n: 1 } })
})

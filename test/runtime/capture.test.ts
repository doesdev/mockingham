import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCapture } from '../../src/runtime/capture.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { callbackKey } from '../../src/webhooks/emit.ts'

function exprInput(body: unknown, resultBody: unknown) {
  return {
    request: new Request('http://mock/orders', { method: 'POST' }),
    url: new URL('http://mock/orders'),
    method: 'POST',
    params: {},
    body,
    result: { status: 201, headers: {}, body: resultBody }
  }
}

test('a callback rule stores the resolved destination', async () => {
  const store = createMemoryStore(() => 0)
  await runCapture({
    rules: [{ kind: 'callback', name: 'onOrder', expression: '{$request.body#/hook}' }],
    expr: exprInput({ hook: 'https://consumer.example/h' }, {}),
    store,
    responseBody: {},
    requestBody: { hook: 'https://consumer.example/h' }
  })
  assert.equal(await store.get(callbackKey('onOrder')), 'https://consumer.example/h')
})

test('an unresolvable callback expression stores nothing', async () => {
  const inner = createMemoryStore(() => 0)
  // `store.get` alone cannot carry this assertion: a failed `ExprResult` has no
  // `value` at all, so a capture that wrongly wrote it would store `undefined`
  // and read back identically to an absent key. The `set` call itself is the
  // only observable difference, so the spy is the assertion.
  const sets: string[] = []
  const store = {
    ...inner,
    set: async (key: string, value: unknown, ttlMs?: number) => {
      sets.push(key)
      await inner.set(key, value, ttlMs)
    }
  }
  await runCapture({
    rules: [{ kind: 'callback', name: 'onOrder', expression: '{$request.body#/absent}' }],
    expr: exprInput({}, {}),
    store,
    responseBody: {},
    requestBody: {}
  })
  // Not merely "no throw": the key must never be written, so a later emit falls
  // through to the next destination tier rather than to an empty or undefined
  // destination.
  assert.deepEqual(sets, [])
  assert.equal(await store.get(callbackKey('onOrder')), undefined)
})

test('the other rule kinds are inert until later tasks fill them in', async () => {
  const store = createMemoryStore(() => 0)
  await runCapture({
    rules: [
      { kind: 'register', webhook: 'onOrder', url: 'https://consumer.example/h' },
      { kind: 'unregister', webhook: 'onOrder' },
      { kind: 'link', index: 0, keyExpr: '{$response.body#/id}', remember: '$response.body' },
      { kind: 'callback', name: 'onOrder', expression: '{$request.body#/hook}' }
    ],
    expr: exprInput({ hook: 'https://consumer.example/h' }, {}),
    store,
    responseBody: {},
    requestBody: { hook: 'https://consumer.example/h' }
  })
  // The unimplemented kinds neither throw nor stop the pass: the callback rule
  // that follows them still captures.
  assert.equal(await store.get(callbackKey('onOrder')), 'https://consumer.example/h')
})

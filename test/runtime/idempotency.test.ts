import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import {
  comparesBody,
  fingerprint,
  isIdempotent,
  recordKey,
  resolveIdempotency
} from '../../src/runtime/idempotency.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }
        ],
        responses: { '201': { description: 'created' } }
      },
      get: { operationId: 'listOrders', responses: { '200': { description: 'ok' } } }
    },
    '/carts': {
      patch: { operationId: 'patchCart', responses: { '200': { description: 'ok' } } }
    }
  }
})

const find = (id: string) => api.operations.find((op) => op.operationId === id)!
const bytes = (text: string) => new TextEncoder().encode(text)

test('resolveIdempotency fills the master spec defaults', () => {
  assert.deepEqual(resolveIdempotency(), {
    header: 'Idempotency-Key',
    methods: [],
    ttlMs: 86_400_000,
    inFlightTtlMs: 30_000,
    scope: ['key', 'route', 'bodyHash'],
    conflictStatus: 409
  })
})

test('resolveIdempotency uppercases configured methods', () => {
  assert.deepEqual(resolveIdempotency({ methods: ['post', 'Patch'] }).methods, ['POST', 'PATCH'])
})

test('a declared Idempotency-Key header parameter enables an operation', () => {
  assert.equal(isIdempotent(find('createOrder'), resolveIdempotency()), true)
})

test('header matching is case-insensitive', () => {
  const config = resolveIdempotency({ header: 'idempotency-KEY' })
  assert.equal(isIdempotent(find('createOrder'), config), true)
})

test('an operation with no such parameter is not enabled by default', () => {
  assert.equal(isIdempotent(find('patchCart'), resolveIdempotency()), false)
})

test('config.methods enables an operation that declares nothing', () => {
  const config = resolveIdempotency({ methods: ['PATCH'] })
  assert.equal(isIdempotent(find('patchCart'), config), true)
  assert.equal(isIdempotent(find('listOrders'), config), false)
})

test('fingerprint is stable and byte-sensitive', () => {
  assert.equal(fingerprint(bytes('{"a":1}')), fingerprint(bytes('{"a":1}')))
  assert.notEqual(fingerprint(bytes('{"a":1}')), fingerprint(bytes('{"a":2}')))
})

test('fingerprint treats reordered keys as different bodies', () => {
  // Deliberate: hashing raw bytes errs toward a false conflict rather than a
  // false replay. A spurious 409 is visible and recoverable; a wrong replay
  // silently returns someone else's response.
  assert.notEqual(fingerprint(bytes('{"a":1,"b":2}')), fingerprint(bytes('{"b":2,"a":1}')))
})

test('an empty body has a fingerprint', () => {
  assert.match(fingerprint(new Uint8Array()), /^[0-9a-f]{8}$/)
})

test('recordKey composes the scope parts in order', () => {
  const operation = find('createOrder')
  assert.equal(
    recordKey({ key: 'abc', operation, scope: ['key', 'route', 'bodyHash'] }),
    'idem|key=abc|route=post /orders'
  )
})

test('recordKey leaves bodyHash out of the key', () => {
  // If the fingerprint were part of the key, a different body would compute a
  // different key, the lookup would miss, and §11's own mismatch rule would be
  // unreachable. `bodyHash` in the scope means "compare it" — see §2.7.
  const operation = find('createOrder')
  assert.equal(
    recordKey({ key: 'abc', operation, scope: ['key', 'route', 'bodyHash'] }),
    recordKey({ key: 'abc', operation, scope: ['key', 'route'] })
  )
})

test('recordKey honors a narrowed scope', () => {
  const operation = find('createOrder')
  assert.equal(recordKey({ key: 'abc', operation, scope: ['key'] }), 'idem|key=abc')
})

test('recordKey honors scope order', () => {
  const operation = find('createOrder')
  assert.notEqual(
    recordKey({ key: 'abc', operation, scope: ['key', 'route'] }),
    recordKey({ key: 'abc', operation, scope: ['route', 'key'] })
  )
})

test('recordKey uses the templated route, not a resolved path', () => {
  // Two calls to /pets/1 and /pets/2 differ only through params, which are in
  // neither the key nor the route. That is the point: an idempotency key is
  // meant to be unique per logical operation.
  const operation = find('createOrder')
  assert.match(recordKey({ key: 'k', operation, scope: ['route'] }), /\/orders$/)
})

test('comparesBody follows the scope', () => {
  assert.equal(comparesBody(resolveIdempotency()), true)
  assert.equal(comparesBody(resolveIdempotency({ scope: ['key', 'route'] })), false)
})

test('a scope with neither key nor route is rejected', () => {
  // Every request would then share one record. A typo throws at construction
  // rather than silently collapsing every caller onto one another's responses.
  assert.throws(() => resolveIdempotency({ scope: ['bodyHash'] }), /scope/)
})

import { createIdempotencyStage } from '../../src/runtime/idempotency.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { buildCtx, recordingFail } from '../helpers/ctx.ts'

const post = () => find('createOrder')

function stageFor(
  store = createMemoryStore(),
  raw = new TextEncoder().encode('{"a":1}'),
  config = resolveIdempotency()
) {
  const { fail, calls } = recordingFail()
  const claimed: Array<{ key: string; fingerprint: string }> = []
  const stage = createIdempotencyStage({
    operation: post(),
    config,
    store,
    raw,
    fail,
    claim: (key, print) => claimed.push({ key, fingerprint: print })
  })
  return { stage, store, calls, claimed, raw }
}

const keyed = (value?: string) =>
  new Request('http://mock/orders', {
    method: 'POST',
    headers: value === undefined ? {} : { 'idempotency-key': value }
  })

test('a request with no key header passes straight through', async () => {
  const { stage, claimed } = stageFor()
  const ctx = buildCtx({ request: keyed(), operation: post() })

  assert.equal(await stage(ctx), undefined)
  assert.deepEqual(claimed, [])
  assert.equal(ctx.decisions.idempotency, undefined)
})

test('a first request claims the key and writes an in-flight marker', async () => {
  const { stage, store, claimed, raw } = stageFor()
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })

  assert.equal(await stage(ctx), undefined)
  assert.equal(claimed.length, 1)
  assert.equal(ctx.decisions.idempotency, 'first')
  assert.deepEqual(await store.get(claimed[0]!.key), {
    state: 'in-flight',
    fingerprint: fingerprint(raw)
  })
})

test('a stored response replays with the Idempotent-Replay header', async () => {
  const { stage, store, raw } = stageFor()
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const key = recordKey({ key: 'k1', operation: post(), scope: ['key', 'route', 'bodyHash'] })
  await store.set(key, {
    state: 'done',
    fingerprint: fingerprint(raw),
    status: 201,
    headers: { 'content-type': 'application/json' },
    body: '{"id":7}'
  })

  const response = await stage(ctx)

  assert.equal(response?.status, 201)
  assert.equal(response?.headers.get('idempotent-replay'), 'true')
  assert.equal(response?.headers.get('content-type'), 'application/json')
  assert.equal(await response?.text(), '{"id":7}')
  assert.equal(ctx.decisions.idempotency, 'replayed')
})

test('a different body under the same key conflicts', async () => {
  const store = createMemoryStore()
  const first = stageFor(store, new TextEncoder().encode('{"a":1}'))
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  const second = stageFor(store, new TextEncoder().encode('{"a":2}'))
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const response = await second.stage(ctx)

  // Reachable under the DEFAULT scope because the fingerprint is compared
  // rather than keyed (§2.7). The in-flight marker carries a fingerprint too,
  // so a mismatch is reported as a mismatch rather than as mere concurrency —
  // and asserting the code, not just the 409, is what distinguishes them.
  assert.equal(response?.status, 409)
  assert.deepEqual(second.calls, [{ status: 409, code: 'MOCK_IDEMPOTENCY_MISMATCH' }])
  assert.equal(ctx.decisions.idempotency, 'mismatch')
})

test('a different body replays when the scope does not compare bodies', async () => {
  const store = createMemoryStore()
  const loose = resolveIdempotency({ scope: ['key', 'route'] })
  const first = stageFor(store, new TextEncoder().encode('{"a":1}'), loose)
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  const second = stageFor(store, new TextEncoder().encode('{"a":2}'), loose)
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const response = await second.stage(ctx)

  // Not a mismatch: the caller opted out of comparing bodies, so this is simply
  // a second request against a key still in flight.
  assert.deepEqual(second.calls, [{ status: 409, code: 'MOCK_IDEMPOTENCY_IN_FLIGHT' }])
  assert.equal(response?.status, 409)
  assert.equal(ctx.decisions.idempotency, 'in-flight')
})

test('a matching body against an unresolved marker is in-flight', async () => {
  const store = createMemoryStore()
  const first = stageFor(store)
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  const second = stageFor(store)
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const response = await second.stage(ctx)

  assert.equal(response?.status, 409)
  assert.deepEqual(second.calls, [{ status: 409, code: 'MOCK_IDEMPOTENCY_IN_FLIGHT' }])
  assert.equal(ctx.decisions.idempotency, 'in-flight')
})

test('conflictStatus is configurable', async () => {
  const store = createMemoryStore()
  const { fail } = recordingFail()
  const build = (raw: Uint8Array) =>
    createIdempotencyStage({
      operation: post(),
      config: resolveIdempotency({ conflictStatus: 422 }),
      store,
      raw,
      fail,
      claim: () => {}
    })
  await build(new TextEncoder().encode('a'))(buildCtx({ request: keyed('k'), operation: post() }))
  const response = await build(new TextEncoder().encode('b'))(
    buildCtx({ request: keyed('k'), operation: post() })
  )

  assert.equal(response?.status, 422)
})

test('the in-flight marker expires', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const first = stageFor(store)
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  value += 31_000
  const second = stageFor(store)
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })

  // Not a 409: the marker aged out, so the retry is a fresh first request.
  assert.equal(await second.stage(ctx), undefined)
  assert.equal(ctx.decisions.idempotency, 'first')
})

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

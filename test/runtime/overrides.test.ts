import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  overrideKey,
  assertSerializable,
  assertValidOverrideKeys,
  overrideAsResolved,
  readOverride,
  EMPTY_OVERRIDE
} from '../../src/runtime/overrides.ts'
import type { RuntimeOverride } from '../../src/runtime/overrides.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { targetKey } from '../../src/runtime/failure.ts'
import type { Operation } from '../../src/spec/types.ts'

const operation = {
  method: 'get',
  path: '/payments/{id}',
  operationId: 'getPayment',
  tags: [],
  parameters: [],
  responses: [],
  callbacks: []
} as unknown as Operation

test('the key is namespaced and built from the operation target key', () => {
  // The writing side and the reading side must never spell this
  // independently — the reason failure.ts exports its key builders.
  assert.equal(overrideKey(targetKey(operation)), 'override|getPayment')
})

test('a function anywhere in the value is rejected, naming its path', () => {
  assert.throws(
    () => assertSerializable({ 200: { body: { total: () => 1 } } }),
    /value\.200\.body\.total is a function/
  )
})

test('a non-plain object is rejected — it would change type through a store', () => {
  assert.throws(
    () => assertSerializable({ 200: { body: { at: new Date(0) } } }),
    /value\.200\.body\.at/
  )
})

test('plain JSON data of every shape is accepted', () => {
  assertSerializable({
    status: 201,
    200: { body: { a: 1, b: 'two', c: true, d: null, e: [1, { f: 2 }] } }
  })
})

test('a cyclic value throws rather than hanging', () => {
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  assert.throws(() => assertSerializable(cyclic), /cycle/)
})

test('undefined as an array element is rejected, naming its indexed path', () => {
  assert.throws(
    () => assertSerializable({ 200: { body: { list: [1, undefined, 3] } } }),
    /value\.200\.body\.list\[1\]/
  )
})

test('undefined as an object property value is accepted', () => {
  assertSerializable({ 200: { body: { a: undefined } } })
})

test('a non-status key is rejected, naming the offending key', () => {
  assert.throws(
    () => assertValidOverrideKeys(
      { notAStatus: { body: {} } } as unknown as RuntimeOverride
    ),
    /notAStatus/
  )
})

test('"status" and a numeric status key are both accepted', () => {
  assertValidOverrideKeys({ status: 404 })
  assertValidOverrideKeys({ 200: { body: {} } })
})

test('overrideAsResolved exposes body and headers scoped by status', () => {
  const resolved = overrideAsResolved({
    status: 201,
    200: { body: { ok: true }, headers: { 'x-a': '1' } }
  })
  assert.equal(resolved.status, 201)
  assert.deepEqual(resolved.bodies(200), [{ ok: true }])
  assert.deepEqual(resolved.headers(200), { 'x-a': '1' })
  assert.deepEqual(resolved.bodies(404), [], 'a different status contributes nothing')
  assert.deepEqual(resolved.headers(404), {})
})

test('readOverride returns the shared empty view when nothing is stored', async () => {
  const store = createMemoryStore()
  const resolved = await readOverride(store, operation)
  assert.equal(
    resolved,
    EMPTY_OVERRIDE,
    'identity matters: the handler uses it to decide whether an override applied'
  )
})

test('readOverride reads back what was written under the namespaced key', async () => {
  const store = createMemoryStore()
  await store.set(overrideKey(targetKey(operation)), { 200: { body: { ok: 1 } } })
  const resolved = await readOverride(store, operation)
  assert.notEqual(resolved, EMPTY_OVERRIDE)
  assert.deepEqual(resolved.bodies(200), [{ ok: 1 }])
})

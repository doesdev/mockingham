import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureKey, operationSlug } from '../../src/fixtures/key.ts'
import type { Operation } from '../../src/spec/types.ts'

const base = { method: 'get', path: '/users/{id}', params: { id: '42' } }

test('the key is eight lowercase hex characters', () => {
  assert.match(fixtureKey(base), /^[0-9a-f]{8}$/)
})

test('the key is a pure function of its input', () => {
  // The key input has no seed field at all - this is the amendment in design
  // section 2.1. A varied run must still read baked fixtures.
  assert.equal(fixtureKey(base), fixtureKey({ ...base }))
})

test('a different path param produces a different key', () => {
  assert.notEqual(fixtureKey(base), fixtureKey({ ...base, params: { id: '43' } }))
})

test('a different path produces a different key', () => {
  const users = { method: 'get', path: '/users/{id}', params: { id: '42' } }
  const orders = { method: 'get', path: '/orders/{id}', params: { id: '42' } }
  assert.notEqual(fixtureKey(users), fixtureKey(orders))
})

test('param order does not affect the key', () => {
  const a = { method: 'get', path: '/a/{x}/{y}', params: { x: '1', y: '2' } }
  const b = { method: 'get', path: '/a/{x}/{y}', params: { y: '2', x: '1' } }
  assert.equal(fixtureKey(a), fixtureKey(b))
})

test('the method is normalized', () => {
  assert.equal(fixtureKey(base), fixtureKey({ ...base, method: 'GET' }))
})

test('contributors change the key', () => {
  assert.notEqual(fixtureKey(base), fixtureKey({ ...base, contributors: { page: '2' } }))
})

test('operationSlug prefers operationId', () => {
  const operation = { method: 'get', path: '/users/{id}', operationId: 'getUser' }
  assert.equal(operationSlug(operation as Operation), 'getUser')
})

test('operationSlug falls back to a filesystem-safe method and path', () => {
  const operation = { method: 'get', path: '/users/{id}' }
  assert.equal(operationSlug(operation as Operation), 'get_users_id')
})

test('the key is pinned to its canonical form', () => {
  // A golden value on purpose. The key is a persistence contract: fixtures on
  // disk are addressed by it, so changing how it is derived must break a test
  // rather than silently orphan every stored fixture.
  assert.equal(
    fixtureKey({ method: 'get', path: '/users/{id}', params: { id: '42' } }),
    'e4102eeb'
  )
})

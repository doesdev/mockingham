import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScoped, narrow } from '../../src/fixtures/scope.ts'
import type { Schema } from '../../src/spec/types.ts'

const user: Schema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    bio: { type: 'string' },
    address: { type: 'object', properties: { city: { type: 'string' } } }
  }
}

test('an empty config is not scoped', () => {
  assert.equal(isScoped(undefined), false)
  assert.equal(isScoped({}), false)
  assert.equal(isScoped({ byName: [] }), false)
})

test('a config naming a field is scoped', () => {
  assert.equal(isScoped({ byName: ['bio'] }), true)
})

test('byName keeps only the named property', () => {
  const value = { id: 1, bio: 'hello', address: { city: 'Leeds' } }
  assert.deepEqual(narrow(value, user, { byName: ['bio'] }, new Map()), { bio: 'hello' })
})

test('byName reaches a nested property', () => {
  const value = { id: 1, bio: 'hello', address: { city: 'Leeds' } }
  assert.deepEqual(
    narrow(value, user, { byName: ['city'] }, new Map()),
    { address: { city: 'Leeds' } }
  )
})

test('bySchema keeps a whole named subschema', () => {
  const address = user.properties?.address as Schema
  const names = new Map<Schema, string>([[address, 'Address']])
  const value = { id: 1, bio: 'hello', address: { city: 'Leeds' } }
  assert.deepEqual(
    narrow(value, user, { bySchema: ['Address'] }, names),
    { address: { city: 'Leeds' } }
  )
})

test('narrowing an array applies per item', () => {
  const list: Schema = { type: 'array', items: user }
  const value = [{ id: 1, bio: 'a' }, { id: 2, bio: 'b' }]
  assert.deepEqual(narrow(value, list, { byName: ['bio'] }, new Map()), [
    { bio: 'a' },
    { bio: 'b' }
  ])
})

test('nothing in scope narrows to undefined rather than an empty object', () => {
  const value = { id: 1, bio: 'hello' }
  assert.equal(narrow(value, user, { byName: ['nope'] }, new Map()), undefined)
})

test('bySchema on an allOf-composed schema is still found by identity', () => {
  const addressBase: Schema = { properties: { city: { type: 'string' } } }
  const address: Schema = { allOf: [addressBase], type: 'object' }
  const withAllOf: Schema = {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      address
    }
  }
  const names = new Map<Schema, string>([[address, 'Address']])
  const value = { id: 1, address: { city: 'Leeds' } }
  assert.deepEqual(
    narrow(value, withAllOf, { bySchema: ['Address'] }, names),
    { address: { city: 'Leeds' } }
  )
})

test('sorted key order keeps narrowed object serialization deterministic', () => {
  const wide: Schema = {
    type: 'object',
    properties: {
      zeta: { type: 'string' },
      alpha: { type: 'string' },
      mu: { type: 'string' }
    }
  }
  const value = { zeta: 'z', alpha: 'a', mu: 'm' }
  const result = narrow(value, wide, { byName: ['zeta', 'alpha', 'mu'] }, new Map())
  assert.deepEqual(Object.keys(result as object), ['alpha', 'mu', 'zeta'])
})

test('a self-referencing schema does not recurse forever', () => {
  const node: Schema = { type: 'object', properties: {} }
  ;(node.properties as Record<string, Schema>)['child'] = node
  ;(node.properties as Record<string, Schema>)['label'] = { type: 'string' }
  const value: Record<string, unknown> = { label: 'root' }
  value['child'] = value
  const result = narrow(value, node, { byName: ['label'] }, new Map())
  assert.deepEqual(result, { label: 'root' })
})

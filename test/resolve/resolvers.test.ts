import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileResolvers } from '../../src/resolve/resolvers.ts'
import type { Ctx } from '../../src/runtime/types.ts'

const ctx = {} as Ctx

test('byFormat resolves on the schema format', () => {
  const lookup = compileResolvers({ byFormat: { email: () => 'x@y.z' } })
  const hit = lookup.resolve({ type: 'string', format: 'email' }, undefined, undefined, ctx)
  assert.deepEqual(hit, { hit: true, value: 'x@y.z' })
})

test('a format with no resolver is a miss', () => {
  const lookup = compileResolvers({ byFormat: { email: () => 'x@y.z' } })
  assert.deepEqual(
    lookup.resolve({ type: 'string', format: 'uuid' }, undefined, undefined, ctx),
    { hit: false }
  )
})

test('byName matches a property name as a glob', () => {
  const lookup = compileResolvers({ byName: [['*_id', () => 'ID']] })
  assert.deepEqual(lookup.resolve({}, 'user_id', undefined, ctx), { hit: true, value: 'ID' })
  assert.deepEqual(lookup.resolve({}, 'name', undefined, ctx), { hit: false })
})

test('byName accepts a RegExp', () => {
  const lookup = compileResolvers({ byName: [[/^user[A-Z]/, () => 'u_1']] })
  assert.deepEqual(lookup.resolve({}, 'userName', undefined, ctx), { hit: true, value: 'u_1' })
  assert.deepEqual(lookup.resolve({}, 'username', undefined, ctx), { hit: false })
})

test('byName is ordered and the first match wins', () => {
  const lookup = compileResolvers({
    byName: [['user_id', () => 'specific'], ['*_id', () => 'general']]
  })
  assert.deepEqual(lookup.resolve({}, 'user_id', undefined, ctx), { hit: true, value: 'specific' })
})

test('a glob does not match across a literal dot', () => {
  const lookup = compileResolvers({ byName: [['a.b', () => 'x']] })
  assert.deepEqual(lookup.resolve({}, 'axb', undefined, ctx), { hit: false })
})

test('bySchema matches a component name and property', () => {
  const lookup = compileResolvers({ bySchema: { User: { id: () => 'u_1' } } })
  assert.deepEqual(lookup.resolve({}, 'id', 'User', ctx), { hit: true, value: 'u_1' })
  assert.deepEqual(lookup.resolve({}, 'id', 'Pet', ctx), { hit: false })
})

test('precedence is bySchema over byName over byFormat', () => {
  const lookup = compileResolvers({
    byFormat: { email: () => 'format' },
    byName: [['email', () => 'name']],
    bySchema: { User: { email: () => 'schema' } }
  })
  const schema = { type: 'string', format: 'email' }
  assert.deepEqual(lookup.resolve(schema, 'email', 'User', ctx), { hit: true, value: 'schema' })
  assert.deepEqual(lookup.resolve(schema, 'email', 'Pet', ctx), { hit: true, value: 'name' })
  assert.deepEqual(lookup.resolve(schema, 'other', 'Pet', ctx), { hit: true, value: 'format' })
})

test('an empty resolver set always misses', () => {
  assert.deepEqual(compileResolvers().resolve({ format: 'email' }, 'id', 'User', ctx), { hit: false })
})

test('a resolver returning undefined still counts as a hit', () => {
  const lookup = compileResolvers({ byName: [['id', () => undefined]] })
  assert.deepEqual(lookup.resolve({}, 'id', undefined, ctx), { hit: true, value: undefined })
})

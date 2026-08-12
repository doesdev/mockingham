import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../src/generate/rng.ts'
import { generateValue } from '../../src/generate/generate.ts'
import type { Schema } from '../../src/spec/types.ts'
import { compileResolvers } from '../../src/resolve/resolvers.ts'

test('generates an object with all required properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      tag: { type: 'string' }
    }
  }
  const value = generateValue(schema, createRng('obj')) as Record<string, unknown>
  assert.equal(typeof value.id, 'number')
  assert.equal(typeof value.name, 'string')
})

test('generates arrays within item bounds', () => {
  const schema: Schema = { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 }
  const value = generateValue(schema, createRng('arr')) as unknown[]
  assert.ok(Array.isArray(value))
  assert.ok(value.length >= 2 && value.length <= 4)
  for (const item of value) assert.equal(typeof item, 'string')
})

test('prefers a spec example over generation', () => {
  const schema: Schema = { type: 'string', example: 'fixed-value' }
  assert.equal(generateValue(schema, createRng('ex')), 'fixed-value')
})

test('preferExamples false ignores the example', () => {
  const schema: Schema = { type: 'string', example: 'fixed-value' }
  const value = generateValue(schema, createRng('ex'), { preferExamples: false })
  assert.notEqual(value, 'fixed-value')
})

test('honors a length constraint declared inside allOf', () => {
  // Pre-fix, generation read constraints off the un-merged schema and produced a
  // default-length string, so a 40-character minimum was ignored.
  const value = generateValue(
    { allOf: [{ type: 'string', minLength: 40 }] }, createRng('allof'), {}
  ) as string
  assert.equal(typeof value, 'string')
  assert.ok(value.length >= 40, `expected at least 40 characters, got ${value.length}`)
})

test('uses default when no example is present', () => {
  assert.equal(generateValue({ type: 'string', default: 'dflt' }, createRng('d')), 'dflt')
})

test('picks from enum', () => {
  const schema: Schema = { type: 'string', enum: ['a', 'b', 'c'] }
  const value = generateValue(schema, createRng('en'))
  assert.ok(['a', 'b', 'c'].includes(value as string))
})

test('returns const verbatim', () => {
  assert.equal(generateValue({ const: 42 }, createRng('c')), 42)
})

test('picks a variant for a union', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  const value = generateValue(schema, createRng('un'))
  assert.ok(typeof value === 'string' || typeof value === 'number')
})

test('terminates on a recursive schema at maxDepth', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  const value = generateValue(node, createRng('rec'), { maxDepth: 2 })
  assert.equal(typeof value, 'object')
})

test('is deterministic for a given seed', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } }
  }
  const first = generateValue(schema, createRng('stable'))
  const second = generateValue(schema, createRng('stable'))
  assert.deepEqual(first, second)
})

test('an unknown schema generates null', () => {
  assert.equal(generateValue({}, createRng('unk')), null)
})

test('generation consults byFormat resolvers', () => {
  const value = generateValue(
    { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byFormat: { email: () => 'fixed@example.com' } }) }
  ) as Record<string, unknown>
  assert.equal(value['email'], 'fixed@example.com')
})

test('generation consults bySchema using the schema name table', () => {
  const user = {
    type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }
  }
  const schemaNames = new Map([[user, 'User']])
  const value = generateValue(user, createRng('resolvers'), {
    schemaNames,
    resolvers: compileResolvers({ bySchema: { User: { id: () => 42 } } })
  }) as Record<string, unknown>
  assert.equal(value['id'], 42)
  assert.equal(typeof value['name'], 'string')
})

test('a resolver beats a spec example', () => {
  const value = generateValue(
    { type: 'object', properties: { id: { type: 'string', example: 'from-spec' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byName: [['id', () => 'from-resolver']] }) }
  ) as Record<string, unknown>
  assert.equal(value['id'], 'from-resolver')
})

test('a resolver may return a promise, left unsettled for the override pass', () => {
  const value = generateValue(
    { type: 'object', properties: { id: { type: 'string' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byName: [['id', async () => 'later']] }) }
  ) as Record<string, unknown>
  assert.ok(value['id'] instanceof Promise)
})

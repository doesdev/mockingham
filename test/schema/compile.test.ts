import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import type { Schema } from '../../src/spec/types.ts'

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

test('compiles primitives', () => {
  assert.equal(parse({ type: 'string' }, 'x').success, true)
  assert.equal(parse({ type: 'string' }, 1).success, false)
  assert.equal(parse({ type: 'integer' }, 1).success, true)
  assert.equal(parse({ type: 'integer' }, 1.5).success, false)
  assert.equal(parse({ type: 'number' }, 1.5).success, true)
  assert.equal(parse({ type: 'boolean' }, true).success, true)
  assert.equal(parse({ type: 'null' }, null).success, true)
})

test('honors string length and pattern', () => {
  assert.equal(parse({ type: 'string', minLength: 2 }, 'a').success, false)
  assert.equal(parse({ type: 'string', maxLength: 2 }, 'abc').success, false)
  assert.equal(parse({ type: 'string', pattern: '^a+$' }, 'aaa').success, true)
  assert.equal(parse({ type: 'string', pattern: '^a+$' }, 'b').success, false)
})

test('honors numeric bounds and multipleOf', () => {
  assert.equal(parse({ type: 'integer', minimum: 5 }, 4).success, false)
  assert.equal(parse({ type: 'integer', maximum: 5 }, 6).success, false)
  assert.equal(parse({ type: 'integer', exclusiveMinimum: 5 }, 5).success, false)
  assert.equal(parse({ type: 'integer', exclusiveMaximum: 5 }, 5).success, false)
  assert.equal(parse({ type: 'integer', multipleOf: 3 }, 9).success, true)
  assert.equal(parse({ type: 'integer', multipleOf: 3 }, 8).success, false)
})

test('compiles objects with required and optional properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } }
  }
  assert.equal(parse(schema, { a: 'x' }).success, true)
  assert.equal(parse(schema, { b: 1 }).success, false)
  assert.equal(parse(schema, { a: 'x', b: 'no' }).success, false)
})

test('additionalProperties false rejects unknown keys', () => {
  const schema: Schema = {
    type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false
  }
  assert.equal(parse(schema, { a: 'x', extra: 1 }).success, false)
})

test('an unconstrained object accepts unknown keys', () => {
  const schema: Schema = { type: 'object', properties: { a: { type: 'string' } } }
  assert.equal(parse(schema, { a: 'x', extra: 1 }).success, true)
})

test('compiles arrays with item bounds', () => {
  const schema: Schema = { type: 'array', items: { type: 'integer' }, minItems: 2 }
  assert.equal(parse(schema, [1, 2]).success, true)
  assert.equal(parse(schema, [1]).success, false)
  assert.equal(parse(schema, ['x', 'y']).success, false)
})

test('compiles enum and const', () => {
  assert.equal(parse({ enum: ['a', 'b'] }, 'a').success, true)
  assert.equal(parse({ enum: ['a', 'b'] }, 'c').success, false)
  assert.equal(parse({ const: 7 }, 7).success, true)
  assert.equal(parse({ const: 7 }, 8).success, false)
})

test('compiles a union from oneOf', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  assert.equal(parse(schema, 'x').success, true)
  assert.equal(parse(schema, 1).success, true)
  assert.equal(parse(schema, true).success, false)
})

test('compiles a discriminated union', () => {
  const schema: Schema = {
    oneOf: [
      { type: 'object', required: ['kind'], properties: { kind: { const: 'a' }, a: { type: 'string' } } },
      { type: 'object', required: ['kind'], properties: { kind: { const: 'b' }, b: { type: 'integer' } } }
    ],
    discriminator: { propertyName: 'kind' }
  }
  assert.equal(parse(schema, { kind: 'a', a: 'x' }).success, true)
  assert.equal(parse(schema, { kind: 'b', b: 1 }).success, true)
  assert.equal(parse(schema, { kind: 'b', b: 'x' }).success, false)
})

test('merges allOf through the shared interpretation', () => {
  const schema: Schema = {
    allOf: [
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } }
    ]
  }
  assert.equal(parse(schema, { a: 'x', b: 1 }).success, true)
  assert.equal(parse(schema, { a: 'x' }).success, false)
})

test('honors nullable in both spellings', () => {
  assert.equal(parse({ type: 'string', nullable: true }, null).success, true)
  assert.equal(parse({ type: ['string', 'null'] }, null).success, true)
  assert.equal(parse({ type: 'string' }, null).success, false)
})

test('an empty schema accepts anything', () => {
  assert.equal(parse({}, { anything: true }).success, true)
})

test('compiles a recursive schema without overflowing', () => {
  const node: Schema = { type: 'object', properties: { name: { type: 'string' } } }
  node.properties!['children'] = { type: 'array', items: node }
  const compiled = createCompiler().compile(node)
  assert.equal(compiled.safeParse({ name: 'a', children: [{ name: 'b', children: [] }] }).success, true)
  assert.equal(compiled.safeParse({ name: 'a', children: [{ name: 1 }] }).success, false)
})

test('the same schema object compiles once', () => {
  const compiler = createCompiler()
  const schema: Schema = { type: 'string' }
  assert.strictEqual(compiler.compile(schema), compiler.compile(schema))
})

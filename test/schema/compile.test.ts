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

test('a usable discriminated union still parses correctly', () => {
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

test('a discriminated union with a variant missing the key falls back instead of throwing', () => {
  const schema: Schema = {
    oneOf: [
      { type: 'object', required: ['kind'], properties: { kind: { const: 'a' }, a: { type: 'string' } } },
      // `required: ['b']` is what keeps this variant mutually exclusive with
      // the first under the exactly-one check below - without it, this is a
      // loose object that matches everything, and the two assertions after
      // doesNotThrow would fail for the same reason oneOf now rejects an
      // ambiguous payload. Do not simplify this away.
      { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } }
    ],
    discriminator: { propertyName: 'kind' }
  }
  const compiled = createCompiler().compile(schema)
  assert.doesNotThrow(() => compiled.safeParse({ kind: 'a', a: 'x' }))
  assert.equal(compiled.safeParse({ kind: 'a', a: 'x' }).success, true)
  assert.equal(compiled.safeParse({ b: 1 }).success, true)
})

test('oneOf rejects a value matching more than one variant', () => {
  // Two loose object variants overlap: a value satisfying both is ambiguous, and
  // oneOf means EXACTLY one. This is stricter than the old union compilation and
  // is the behavior classify's `mode` field exists to express.
  const schema: Schema = {
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'integer' } } }
    ]
  }
  assert.equal(parse(schema, { a: 'x', b: 1 }).success, false)
  assert.equal(parse(schema, { a: 'x' }).success, false)
})

test('honors the 3.0 boolean spelling of exclusive bounds', () => {
  assert.equal(parse({ type: 'integer', minimum: 5, exclusiveMinimum: true }, 5).success, false)
  assert.equal(parse({ type: 'integer', minimum: 5, exclusiveMinimum: true }, 6).success, true)
  assert.equal(parse({ type: 'integer', maximum: 5, exclusiveMaximum: true }, 5).success, false)
})

test('honors a constraint declared inside allOf', () => {
  // allOf wrapping a primitive is the reproducing shape: classify() flattens it
  // structurally, but the constraint read used to go to the un-merged node, so
  // minLength was silently dropped. Object-level allOf does NOT reproduce this.
  assert.equal(parse({ allOf: [{ type: 'string', minLength: 5 }] }, 'ab').success, false)
  assert.equal(parse({ allOf: [{ type: 'string', minLength: 5 }] }, 'abcdef').success, true)
})

test('an uncompilable pattern is skipped rather than throwing', () => {
  // Generation serves a document with a broken `pattern` happily, so validation
  // must not be the stricter of the two and turn every request into a 500.
  const schema: Schema = { type: 'string', pattern: '([bad', minLength: 3 }
  const compiled = createCompiler()
  assert.doesNotThrow(() => compiled.compile(schema))
  // The rest of the constraints still apply.
  assert.equal(compiled.compile(schema).safeParse('ab').success, false)
  assert.equal(compiled.compile(schema).safeParse('abcd').success, true)
})

test('honors a numeric constraint declared inside allOf', () => {
  assert.equal(parse({ allOf: [{ type: 'integer', minimum: 21 }] }, 7).success, false)
  assert.equal(parse({ allOf: [{ type: 'integer', minimum: 21 }] }, 42).success, true)
})

test('additionalProperties as a schema constrains unknown keys', () => {
  const schema: Schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: { type: 'integer' }
  }
  assert.equal(parse(schema, { a: 'x', extra: 1 }).success, true)
  assert.equal(parse(schema, { a: 'x', extra: 'no' }).success, false)
})

test('oneOf requires exactly one variant to match', () => {
  // classify carries `mode` precisely so a validator can tell oneOf from anyOf.
  const schema: Schema = {
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } }
    ]
  }
  // Both variants are loose objects, so this matches BOTH - oneOf must reject it.
  assert.equal(parse(schema, { a: 'x', b: 'y' }).success, false)
})

test('anyOf accepts a value matching several variants', () => {
  const schema: Schema = {
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } }
    ]
  }
  assert.equal(parse(schema, { a: 'x', b: 'y' }).success, true)
})

test('oneOf still accepts a value matching exactly one variant', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  assert.equal(parse(schema, 'x').success, true)
  assert.equal(parse(schema, 1).success, true)
  assert.equal(parse(schema, true).success, false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { negationOf } from '../../src/schema/walk.ts'
import { generateValue } from '../../src/generate/generate.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Schema } from '../../src/spec/types.ts'

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

test('the negation is read once, beside the type it constrains', () => {
  const forbidden: Schema = { const: 'reserved' }
  assert.equal(negationOf({ type: 'string', not: forbidden }), forbidden)
  assert.equal(negationOf({ type: 'string' }), undefined)
  // A negation living on an allOf member is still the schema's negation.
  assert.equal(negationOf({ allOf: [{ not: forbidden }] }), forbidden)
})

test('validation rejects a value that satisfies `not`', () => {
  const schema: Schema = { type: 'string', not: { const: 'reserved' } }
  assert.equal(parse(schema, 'anything').success, true)
  assert.equal(parse(schema, 'reserved').success, false)
  // The type beside the negation still applies.
  assert.equal(parse(schema, 7).success, false)
})

test('`not` applies beside an object shape rather than instead of it', () => {
  const schema: Schema = {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string' } },
    not: { required: ['admin'] }
  }
  assert.equal(parse(schema, { role: 'reader' }).success, true)
  assert.equal(parse(schema, { role: 'reader', admin: true }).success, false)
  assert.equal(parse(schema, {}).success, false)
})

test('a bare `not` constrains a schema that declares nothing else', () => {
  const schema: Schema = { not: { type: 'string' } }
  assert.equal(parse(schema, 1).success, true)
  assert.equal(parse(schema, 'x').success, false)
})

test('`not` composes with `if`/`then`/`else` on the same schema', () => {
  const schema: Schema = {
    type: 'object',
    properties: { kind: { type: 'string' }, reason: { type: 'string' } },
    if: { required: ['kind'], properties: { kind: { const: 'denied' } } },
    then: { required: ['reason'] },
    not: { required: ['internal'] }
  }
  assert.equal(parse(schema, { kind: 'denied', reason: 'no' }).success, true)
  assert.equal(parse(schema, { kind: 'denied' }).success, false)
  assert.equal(
    parse(schema, { kind: 'denied', reason: 'no', internal: 'x' }).success,
    false
  )
})

test('generation avoids a value the negation forbids where it can', () => {
  const schema: Schema = {
    type: 'string',
    enum: ['keep', 'drop'],
    not: { const: 'drop' }
  }
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    assert.equal(generateValue(schema, createRng(seed)), 'keep', `seed ${seed}`)
  }
})

test('generation serves the closest value when the negation cannot be missed', () => {
  // A document whose `not` forbids the only value it declares. Refusing to
  // serve is wrong on every request (invariant 4); serving the const is wrong
  // on one keyword.
  const schema: Schema = { const: 'only', not: { const: 'only' } }
  assert.equal(generateValue(schema, createRng('repro')), 'only')
})

test('a schema with no negation generates byte-identical output', () => {
  const schema: Schema = {
    type: 'object',
    required: ['id', 'tags'],
    properties: {
      id: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 2 }
    }
  }
  const first = generateValue(schema, createRng('repro'))
  const second = generateValue(schema, createRng('repro'))
  assert.deepEqual(first, second)
})

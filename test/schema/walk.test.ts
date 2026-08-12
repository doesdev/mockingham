import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isNullable, mergeAllOf } from '../../src/schema/walk.ts'

test('classifies primitives', () => {
  assert.equal(classify({ type: 'string' }).kind, 'string')
  assert.equal(classify({ type: 'integer' }).kind, 'integer')
  assert.equal(classify({ type: 'number' }).kind, 'number')
  assert.equal(classify({ type: 'boolean' }).kind, 'boolean')
  assert.equal(classify({ type: 'null' }).kind, 'null')
})

test('const and enum win over type', () => {
  const asConst = classify({ type: 'string', const: 'x' })
  assert.equal(asConst.kind, 'const')
  const asEnum = classify({ type: 'string', enum: ['a', 'b'] })
  assert.equal(asEnum.kind, 'enum')
  if (asEnum.kind === 'enum') assert.deepEqual(asEnum.values, ['a', 'b'])
})

test('classifies objects with required and additionalProperties', () => {
  const kind = classify({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' } },
    additionalProperties: false
  })
  assert.equal(kind.kind, 'object')
  if (kind.kind === 'object') {
    assert.deepEqual(kind.required, ['a'])
    assert.equal(kind.additional, false)
    assert.equal(kind.properties.a?.type, 'string')
  }
})

test('infers object from properties when type is absent', () => {
  assert.equal(classify({ properties: { a: { type: 'string' } } }).kind, 'object')
})

test('infers array from items when type is absent', () => {
  assert.equal(classify({ items: { type: 'string' } }).kind, 'array')
})

test('classifies oneOf and anyOf as a union, carrying the discriminator', () => {
  const kind = classify({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    discriminator: { propertyName: 'kind' }
  })
  assert.equal(kind.kind, 'union')
  if (kind.kind === 'union') {
    assert.equal(kind.variants.length, 2)
    assert.equal(kind.discriminator, 'kind')
  }
})

test('treats a 3.1 type array as nullable plus the base type', () => {
  assert.equal(classify({ type: ['string', 'null'] }).kind, 'string')
  assert.equal(isNullable({ type: ['string', 'null'] }), true)
})

test('honors the 3.0 nullable keyword', () => {
  assert.equal(isNullable({ type: 'string', nullable: true }), true)
  assert.equal(isNullable({ type: 'string' }), false)
})

test('mergeAllOf combines properties and required', () => {
  const merged = mergeAllOf({
    allOf: [
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } }
    ]
  })
  assert.equal(merged.type, 'object')
  assert.deepEqual(merged.required?.sort(), ['a', 'b'])
  assert.equal(merged.properties?.a?.type, 'string')
  assert.equal(merged.properties?.b?.type, 'integer')
})

test('classify merges allOf before classifying', () => {
  const kind = classify({
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } }
    ]
  })
  assert.equal(kind.kind, 'object')
  if (kind.kind === 'object') {
    assert.deepEqual(Object.keys(kind.properties).sort(), ['a', 'b'])
  }
})

test('an empty schema is unknown', () => {
  assert.equal(classify({}).kind, 'unknown')
})

test('mergeAllOf carries constraint keywords from members', () => {
  const merged = mergeAllOf({
    allOf: [{ type: 'string', minLength: 3, pattern: '^a' }]
  })
  assert.equal(merged.type, 'string')
  assert.equal(merged.minLength, 3)
  assert.equal(merged.pattern, '^a')
})

test('the outer schema wins over an allOf member', () => {
  const merged = mergeAllOf({
    type: 'string',
    minLength: 10,
    allOf: [{ type: 'integer', minLength: 3 }]
  })
  assert.equal(merged.type, 'string')
  assert.equal(merged.minLength, 10)
})

test('a later allOf member overrides an earlier one', () => {
  const merged = mergeAllOf({
    allOf: [{ minLength: 3 }, { minLength: 7 }]
  })
  assert.equal(merged.minLength, 7)
})

test('union mode distinguishes oneOf from anyOf', () => {
  const one = classify({ oneOf: [{ type: 'string' }] })
  assert.equal(one.kind, 'union')
  if (one.kind === 'union') assert.equal(one.mode, 'one')
  const any = classify({ anyOf: [{ type: 'string' }] })
  assert.equal(any.kind, 'union')
  if (any.kind === 'union') assert.equal(any.mode, 'any')
})

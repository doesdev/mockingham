import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { classify } from '../../src/schema/walk.ts'
import type { Schema } from '../../src/spec/types.ts'

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

/**
 * The consumer report's "at least one of these two keys" idiom: a union whose
 * branches declare nothing but `required`, sitting beside the object whose
 * properties they constrain.
 */
const contact: Schema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' }
  },
  anyOf: [{ required: ['email'] }, { required: ['phone'] }]
}

test('a required-only union branch is enforced by validation', () => {
  assert.equal(parse(contact, { name: 'ada', email: 'ada@example.com' }).success, true)
  assert.equal(parse(contact, { name: 'ada', phone: '555' }).success, true)
  // Neither branch is satisfied: the sibling `required` must still bite.
  assert.equal(parse(contact, { name: 'ada' }).success, false)
  // The sibling shape's own `required` is not lost to the union either.
  assert.equal(parse(contact, { email: 'ada@example.com' }).success, false)
})

/**
 * The array counterpart of the sibling-object fix. `type: array` with `items`
 * beside a union describes the same instance the branches do - discarding it
 * left the branches classifying as `unknown`, so the whole schema accepted
 * anything at all.
 */
const bounded: Schema = {
  type: 'array',
  items: { type: 'string' },
  anyOf: [{ minItems: 2 }, { maxItems: 0 }]
}

test('an array shape declared beside a union survives classification', () => {
  const kind = classify(bounded)
  assert.equal(kind.kind, 'union')
  if (kind.kind !== 'union') return
  assert.ok(kind.base, 'the array sibling shape must be carried as the union base')
  assert.equal(kind.base?.type, 'array')
  assert.equal(kind.base?.anyOf, undefined)
})

test('an array shape declared beside a union is enforced by validation', () => {
  assert.equal(parse(bounded, ['a', 'b']).success, true)
  assert.equal(parse(bounded, []).success, true)
  // One item satisfies neither branch.
  assert.equal(parse(bounded, ['a']).success, false)
  // The item type comes from the sibling shape, which used to be discarded.
  assert.equal(parse(bounded, ['a', 1]).success, false)
  // And so does the array-ness itself.
  assert.equal(parse(bounded, 'nope').success, false)
})

test('a tuple declared beside a union survives classification', () => {
  const tuple: Schema = {
    prefixItems: [{ type: 'string' }, { type: 'integer' }],
    oneOf: [{ minItems: 2 }, { maxItems: 1 }]
  }
  const kind = classify(tuple)
  assert.equal(kind.kind, 'union')
  if (kind.kind !== 'union') return
  assert.equal(kind.base?.prefixItems?.length, 2)
  assert.equal(parse(tuple, ['a', 1]).success, true)
  assert.equal(parse(tuple, [1, 'a']).success, false)
})

test('a purely alternative union carries no sibling base', () => {
  // The common case, and the one that must not move: nothing is declared
  // beside the union, so there is no base to apply.
  const plain: Schema = {
    oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }]
  }
  const kind = classify(plain)
  assert.equal(kind.kind, 'union')
  if (kind.kind !== 'union') return
  assert.equal(kind.base, undefined)
  assert.equal(parse(plain, ['a']).success, true)
  assert.equal(parse(plain, 'a').success, true)
  assert.equal(parse(plain, 1).success, false)
})

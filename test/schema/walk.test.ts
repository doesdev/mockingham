import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classify, isNullable, mergeAllOf, variantName
} from '../../src/schema/walk.ts'
import type { Schema } from '../../src/spec/types.ts'

test('a self-referential allOf merges instead of overflowing the stack', () => {
  // `A: { allOf: [A] }` says A must satisfy A — a tautology that constrains
  // nothing. Ref resolution makes both references the same object, so merging
  // used to recurse forever. Skipping the member is correct, not lossy.
  const node: Schema = { type: 'object', properties: { id: { type: 'string' } } }
  node.allOf = [node]

  const merged = mergeAllOf(node)

  assert.equal(merged.type, 'object')
  assert.deepEqual(Object.keys(merged.properties ?? {}), ['id'])
})

test('mutual allOf composition keeps both members contributions', () => {
  // A composes B, B composes A. The skip must be scoped to the cycle: B's own
  // properties still have to reach A, or the guard has thrown away real data.
  const a: Schema = { type: 'object', properties: { a: { type: 'string' } } }
  const b: Schema = { type: 'object', properties: { b: { type: 'string' } } }
  a.allOf = [b]
  b.allOf = [a]

  const merged = mergeAllOf(a)

  assert.deepEqual(Object.keys(merged.properties ?? {}).sort(), ['a', 'b'])
})

test('a diamond keeps every branch properties', () => {
  // A schema reached through two SIBLING members is a diamond, not a cycle.
  //
  // Deliberately NOT a guard on the copy-vs-share choice below: `absorb` unions
  // properties into one map at every level, so a branch that skipped `shared`
  // still ends up with its properties via the other branch. This asserts the
  // union, which is a real behavior — it just cannot discriminate the two
  // implementations. The next test does that.
  const shared: Schema = { type: 'object', properties: { shared: { type: 'string' } } }
  const left: Schema = { type: 'object', properties: { left: { type: 'string' } }, allOf: [shared] }
  const right: Schema = { type: 'object', properties: { right: { type: 'string' } }, allOf: [shared] }

  const merged = mergeAllOf({ type: 'object', allOf: [left, right] })

  assert.deepEqual(
    Object.keys(merged.properties ?? {}).sort(),
    ['left', 'right', 'shared']
  )
})

test('a keyword from a shared member reaches a branch that does not override it', () => {
  // THE over-correction guard: it fails if `seen` is shared across siblings
  // instead of copied per path.
  //
  // Two details make it discriminating, and both were found by mutation after
  // a first attempt passed under either implementation. `shared` needs its OWN
  // allOf, or it returns before ever entering the set. And the assertion has to
  // be on a scalar keyword rather than properties, because property unions
  // recover a skipped branch while precedence does not: `right` inherits the
  // description from `shared` and, absorbed last, wins. Skip `shared` in
  // `right` and `left`'s value survives instead.
  const base: Schema = { type: 'object', properties: { base: { type: 'string' } } }
  const shared: Schema = { type: 'object', description: 'from shared', allOf: [base] }
  const left: Schema = { type: 'object', description: 'from left', allOf: [shared] }
  const right: Schema = { type: 'object', allOf: [shared] }

  const merged = mergeAllOf({ type: 'object', allOf: [left, right] })

  assert.equal(merged.description, 'from shared')
})

test('classify survives a self-referential allOf', () => {
  const node: Schema = { type: 'object', properties: { id: { type: 'string' } } }
  node.allOf = [node]

  const kind = classify(node)

  assert.equal(kind.kind, 'object')
  if (kind.kind === 'object') assert.ok('id' in kind.properties)
})

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

test('variantName reads a formal discriminator property', () => {
  const branch: Schema = {
    type: 'object', properties: { outcome: { const: 'created' } }
  }
  assert.equal(variantName(branch, 'outcome'), 'created')
})

test('variantName falls back to any const-valued property', () => {
  // No discriminator argument: the common shape, which carries no
  // `discriminator` object at all.
  const branch: Schema = {
    type: 'object', properties: { outcome: { const: 'conflict' } }
  }
  assert.equal(variantName(branch, undefined), 'conflict')
})

test('variantName ignores a non-const property', () => {
  const branch: Schema = {
    type: 'object', properties: { id: { type: 'string' } }
  }
  assert.equal(variantName(branch, 'id'), undefined)
})

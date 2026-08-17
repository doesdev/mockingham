import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScoped, narrow } from '../../src/fixtures/scope.ts'
import { applyOverrides } from '../../src/resolve/layer.ts'
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
  // Index-keyed object, not a literal array - this is the exact shape
  // overlay() in src/resolve/layer.ts merges into a base array per index.
  // A literal array override would replace the base array wholesale instead.
  assert.deepEqual(narrow(value, list, { byName: ['bio'] }, new Map()), {
    '0': { bio: 'a' },
    '1': { bio: 'b' }
  })
})

test('an array with only some items in scope omits the rest by index', () => {
  const list: Schema = { type: 'array', items: user }
  const value = [{ id: 1, bio: 'a' }, { id: 2 }, { id: 3, bio: 'c' }]
  const result = narrow(value, list, { byName: ['bio'] }, new Map())
  // Index 1 has no `bio`, so it must be OMITTED entirely - not present as
  // `undefined` or `null` - so overlay() leaves the generated item at that
  // index untouched rather than reading it as an explicit blank.
  assert.deepEqual(result, { '0': { bio: 'a' }, '2': { bio: 'c' } })
  assert.equal(Object.prototype.hasOwnProperty.call(result, '1'), false)
})

test('a narrowed array under an object key survives the recursion and merges correctly', async () => {
  const withList: Schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      users: { type: 'array', items: user }
    }
  }
  const generated = {
    name: 'org',
    users: [
      { id: 1, bio: 'generated-1', extra: 'keep-1' },
      { id: 2, bio: 'generated-2', extra: 'keep-2' }
    ]
  }
  const narrowed = narrow(generated, withList, { byName: ['bio'] }, new Map()) as {
    users: unknown
  }
  assert.deepEqual(narrowed.users, { '0': { bio: 'generated-1' }, '1': { bio: 'generated-2' } })

  const merged = await applyOverrides(generated, narrowed, undefined) as {
    name: string
    users: Array<{ id: number; bio: string; extra: string }>
  }
  assert.deepEqual(merged.users[0], { id: 1, bio: 'generated-1', extra: 'keep-1' })
  assert.deepEqual(merged.users[1], { id: 2, bio: 'generated-2', extra: 'keep-2' })
})

test('applying a narrowed array preserves every generated field outside scope', async () => {
  // This is the test that actually pins the defect closed: it feeds
  // narrow()'s REAL, UNMODIFIED return value through the real
  // overlay/applyOverrides pipeline (no hand-reconstruction of the override
  // in between - that would let a literal-array regression slip through,
  // since string-indexing into an array and looking up a key on an object
  // read identically at the single-index call site) and checks the merged
  // result still has every field the schema generator would have produced,
  // on both the matched and the entirely-unmatched item.
  const list: Schema = { type: 'array', items: user }
  const generated = [
    { id: 1, bio: 'generated-1', address: { city: 'Leeds' } },
    { id: 2, address: { city: 'York' } } // no `bio` at all: nothing in scope
  ]
  const narrowed = narrow(generated, list, { byName: ['bio'] }, new Map())

  const merged = (await applyOverrides(generated, narrowed, undefined)) as Array<{
    id: number
    bio?: string
    address: { city: string }
  }>

  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0], {
    id: 1,
    bio: 'generated-1',
    address: { city: 'Leeds' }
  })
  // The unmatched item must be untouched - every generated field intact,
  // not truncated or replaced.
  assert.deepEqual(merged[1], {
    id: 2,
    address: { city: 'York' }
  })
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOverrides } from '../../src/resolve/layer.ts'

const ctx = {} as never

test('an absent override returns the generated value', async () => {
  assert.deepEqual(await applyOverrides({ a: 1 }, undefined, ctx), { a: 1 })
})

test('a static leaf replaces the generated one', async () => {
  assert.deepEqual(await applyOverrides({ a: 1, b: 2 }, { a: 9 }, ctx), { a: 9, b: 2 })
})

test('a synchronous function receives ctx and replaces the value', async () => {
  const seen: unknown[] = []
  const out = await applyOverrides({ a: 1 }, { a: (c: unknown) => { seen.push(c); return 9 } }, ctx)
  assert.deepEqual(out, { a: 9 })
  assert.equal(seen[0], ctx)
})

test('an async function is awaited', async () => {
  assert.deepEqual(await applyOverrides({ a: 1 }, { a: async () => 9 }, ctx), { a: 9 })
})

test('nested objects merge rather than replace', async () => {
  const out = await applyOverrides(
    { user: { id: 1, name: 'gen' } }, { user: { name: 'set' } }, ctx
  )
  assert.deepEqual(out, { user: { id: 1, name: 'set' } })
})

test('a key absent from the generated value is added', async () => {
  assert.deepEqual(await applyOverrides({ a: 1 }, { b: 2 }, ctx), { a: 1, b: 2 })
})

test('a numeric key addresses one array index', async () => {
  assert.deepEqual(await applyOverrides(['x', 'y', 'z'], { 1: 'Y' }, ctx), ['x', 'Y', 'z'])
})

test('a star key applies to every array element', async () => {
  assert.deepEqual(await applyOverrides(['x', 'y'], { '*': 'Z' }, ctx), ['Z', 'Z'])
})

test('a numeric key beats the star for its index', async () => {
  assert.deepEqual(
    await applyOverrides(['x', 'y', 'z'], { '*': 'Z', 1: 'Y' }, ctx), ['Z', 'Y', 'Z']
  )
})

test('a star override receives each element', async () => {
  const out = await applyOverrides(
    [{ n: 1 }, { n: 2 }], { '*': { n: () => 0 } }, ctx
  )
  assert.deepEqual(out, [{ n: 0 }, { n: 0 }])
})

test('settles a promise the generator left in the tree', async () => {
  assert.deepEqual(
    await applyOverrides({ a: Promise.resolve(1) }, undefined, ctx), { a: 1 }
  )
})

test('every async leaf is started before any is awaited', async () => {
  const started: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })

  const promise = applyOverrides({ a: 0, b: 0, c: 0 }, {
    a: async () => { started.push('a'); await gate; return 1 },
    b: async () => { started.push('b'); await gate; return 2 },
    c: async () => { started.push('c'); await gate; return 3 }
  }, ctx)

  // All three ran to their first await before anything resolved, which is what
  // a single Promise.all buys over awaiting each leaf in turn.
  assert.deepEqual(started, ['a', 'b', 'c'])
  release?.()
  assert.deepEqual(await promise, { a: 1, b: 2, c: 3 })
})

test('a promise resolving to a value containing promises is settled too', async () => {
  // The inner promise only becomes visible after the outer one settles, so a
  // single-pass settle would leave it unresolved in the result.
  const out = await applyOverrides(
    { a: 0 }, { a: async () => ({ b: Promise.resolve(3), c: 4 }) }, ctx
  )
  assert.deepEqual(out, { a: { b: 3, c: 4 } })
})

test('an override at the root replaces everything', async () => {
  assert.equal(await applyOverrides({ a: 1 }, () => 'gone', ctx), 'gone')
})

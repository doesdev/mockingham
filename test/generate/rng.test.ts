import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng, fnv1a } from '../../src/generate/rng.ts'

test('the same seed produces the same sequence', () => {
  const a = createRng('seed-1')
  const b = createRng('seed-1')
  const left = [a.next(), a.next(), a.next()]
  const right = [b.next(), b.next(), b.next()]
  assert.deepEqual(left, right)
})

test('different seeds produce different sequences', () => {
  const a = createRng('seed-1')
  const b = createRng('seed-2')
  assert.notEqual(a.next(), b.next())
})

test('next stays within [0, 1)', () => {
  const rng = createRng('bounds')
  for (let i = 0; i < 1000; i++) {
    const value = rng.next()
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
  }
})

test('int is inclusive of both bounds and never exceeds them', () => {
  const rng = createRng('ints')
  const seen = new Set<number>()
  for (let i = 0; i < 1000; i++) {
    const value = rng.int(1, 3)
    assert.ok(value >= 1 && value <= 3, `out of range: ${value}`)
    seen.add(value)
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3])
})

test('int handles a single-value range', () => {
  const rng = createRng('single')
  assert.equal(rng.int(7, 7), 7)
})

test('pick returns a member of the array', () => {
  const rng = createRng('pick')
  const items = ['a', 'b', 'c'] as const
  for (let i = 0; i < 100; i++) assert.ok(items.includes(rng.pick(items)))
})

test('fnv1a is stable and differs across inputs', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'))
  assert.notEqual(fnv1a('abc'), fnv1a('abd'))
  assert.ok(Number.isInteger(fnv1a('abc')))
  assert.ok(fnv1a('abc') >= 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { generateValue } from '../../src/generate/generate.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Schema } from '../../src/spec/types.ts'

const SEEDS = Array.from({ length: 30 }, (_, index) => `s${index}`)

function generate(schema: Schema, seed: string): unknown[] {
  return generateValue(schema, createRng(seed), { maxDepth: 12 }) as unknown[]
}

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

function hasDuplicate(items: unknown[]): boolean {
  const seen = new Set<string>()
  for (const item of items) {
    const key = JSON.stringify(item)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

// The report's `tags`: two enum members, `minItems` 2, `maxItems` 3. There are
// only two distinct values to draw, so the array can never reach three.
const tags: Schema = {
  type: 'array',
  minItems: 2,
  maxItems: 3,
  uniqueItems: true,
  items: { type: 'string', enum: ['bulk', 'fragile'] }
}

test('generation draws without replacement', () => {
  for (const seed of SEEDS) {
    const value = generate(tags, seed)
    assert.equal(hasDuplicate(value), false, `seed ${seed}: ${JSON.stringify(value)}`)
  }
})

test('generation still reaches the requested length when it can', () => {
  const schema: Schema = {
    type: 'array',
    minItems: 3,
    maxItems: 3,
    uniqueItems: true,
    items: { type: 'integer', minimum: 0, maximum: 1000 }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.equal(value.length, 3, `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(hasDuplicate(value), false, `seed ${seed}: ${JSON.stringify(value)}`)
  }
})

test('generation yields what it can when distinct values run out', () => {
  // One possible value, five demanded. Yields the one, rather than hanging,
  // throwing, or repeating it.
  const schema: Schema = {
    type: 'array',
    minItems: 5,
    maxItems: 5,
    uniqueItems: true,
    items: { const: 'x' }
  }
  assert.deepEqual(generate(schema, 'exhausted'), ['x'])
  // And the report's own case: two members, up to three slots.
  for (const seed of SEEDS) {
    assert.ok(generate(tags, seed).length <= 2)
  }
})

test('unique generation is byte-identical for the same seed', () => {
  for (const seed of SEEDS) {
    assert.equal(
      JSON.stringify(generate(tags, seed)),
      JSON.stringify(generate(tags, seed))
    )
  }
})

test('validation rejects a repeated member', () => {
  assert.equal(parse(tags, ['bulk', 'bulk']).success, false)
  assert.equal(parse(tags, ['bulk', 'fragile']).success, true)
})

test('validation compares members by value, not by key order', () => {
  const schema: Schema = {
    type: 'array',
    uniqueItems: true,
    items: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } }
    }
  }
  assert.equal(parse(schema, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).success, false)
  assert.equal(parse(schema, [{ a: 1, b: 2 }, { a: 2, b: 1 }]).success, true)
})

test('uniqueItems false leaves an array alone', () => {
  const schema: Schema = {
    type: 'array',
    uniqueItems: false,
    items: { type: 'string', enum: ['bulk'] },
    minItems: 2,
    maxItems: 2
  }
  assert.equal(parse(schema, ['bulk', 'bulk']).success, true)
  assert.deepEqual(generate(schema, 'dup'), ['bulk', 'bulk'])
})

/**
 * `uniqueItems` and `prefixItems` were fixed by two people at once, and neither
 * could see this: both directions handle a tuple on a code path that returns
 * BEFORE the uniqueness handling. Generation drew every position from the tail
 * schema, so a tuple's declared positions were ignored outright; validation
 * skipped the uniqueness refinement entirely. Exactly the matched pair invariant
 * 1 predicts, produced by the integration rather than by either change.
 */
const pair: Schema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  uniqueItems: true,
  prefixItems: [
    { type: 'string', enum: ['bulk', 'fragile'] },
    { type: 'string', enum: ['bulk', 'fragile'] }
  ]
}

test('a unique tuple generates each position from its own schema', () => {
  for (const seed of SEEDS) {
    const value = generate(pair, seed)
    assert.equal(value.length, 2, `seed ${seed}: ${JSON.stringify(value)}`)
    for (const [index, entry] of value.entries()) {
      assert.equal(
        typeof entry,
        'string',
        `seed ${seed}: position ${index} of ${JSON.stringify(value)}`
      )
    }
  }
})

test('a unique tuple draws its positions without replacement', () => {
  for (const seed of SEEDS) {
    const value = generate(pair, seed)
    assert.equal(
      hasDuplicate(value),
      false,
      `seed ${seed}: ${JSON.stringify(value)}`
    )
  }
})

test('validation rejects a repeated member of a tuple', () => {
  assert.equal(parse(pair, ['bulk', 'fragile']).success, true)
  assert.equal(parse(pair, ['bulk', 'bulk']).success, false)
})

test('a unique tuple still validates each position against its own schema', () => {
  // The uniqueness fix must not cost the per-position checking that finding 4
  // added: these two differ, so uniqueness alone would accept them.
  assert.equal(parse(pair, ['bulk', 'crated']).success, false)
})

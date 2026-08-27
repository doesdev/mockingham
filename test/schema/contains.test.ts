import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { classify } from '../../src/schema/walk.ts'
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

function countMatching(items: unknown[], predicate: (item: unknown) => boolean): number {
  return items.filter(predicate).length
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const audited: Schema = {
  type: 'array',
  items: { type: 'string' },
  contains: { const: 'audited' }
}

test('validation rejects an array no member of which matches `contains`', () => {
  assert.equal(parse(audited, ['a', 'b']).success, false)
  assert.equal(parse(audited, ['a', 'audited']).success, true)
})

test('`contains` constrains only one member, not every member', () => {
  // The whole point of `contains` over `items`: the other members are
  // unconstrained by it.
  assert.equal(parse(audited, ['audited', 'anything', 'else']).success, true)
})

test('validation honors minContains', () => {
  const schema: Schema = { ...audited, minContains: 2 }
  assert.equal(parse(schema, ['audited', 'x']).success, false)
  assert.equal(parse(schema, ['audited', 'audited']).success, true)
})

test('validation honors maxContains', () => {
  const schema: Schema = { ...audited, maxContains: 1 }
  assert.equal(parse(schema, ['audited', 'audited']).success, false)
  assert.equal(parse(schema, ['audited', 'x']).success, true)
})

test('minContains 0 makes `contains` vacuously satisfiable', () => {
  const schema: Schema = { ...audited, minContains: 0 }
  assert.equal(parse(schema, ['a', 'b']).success, true)
  assert.equal(parse(schema, []).success, true)
})

test('minContains 0 with maxContains still enforces the upper bound', () => {
  const schema: Schema = { ...audited, minContains: 0, maxContains: 1 }
  assert.equal(parse(schema, []).success, true)
  assert.equal(parse(schema, ['audited', 'audited']).success, false)
})

test('`contains` composes with `items` - every member still satisfies items', () => {
  assert.equal(parse(audited, ['audited', 7]).success, false)
})

test('`contains` composes with a tuple - the tuple branch enforces it too', () => {
  const schema: Schema = {
    type: 'array',
    prefixItems: [{ const: 'head' }],
    items: { type: 'string' },
    contains: { const: 'tail' }
  }
  assert.equal(parse(schema, ['head', 'x']).success, false)
  assert.equal(parse(schema, ['head', 'tail']).success, true)
  // And the tuple position is still checked.
  assert.equal(parse(schema, ['nope', 'tail']).success, false)
})

test('`contains` composes with uniqueItems on a list', () => {
  const schema: Schema = {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string' },
    contains: { const: 'z' }
  }
  assert.equal(parse(schema, ['a', 'z']).success, true)
  assert.equal(parse(schema, ['a', 'a', 'z']).success, false)
  assert.equal(parse(schema, ['a', 'b']).success, false)
})

test('`contains` declared on an allOf member is still enforced', () => {
  const schema: Schema = {
    allOf: [{ type: 'array', items: { type: 'string' } }, { contains: { const: 'q' } }]
  }
  assert.equal(parse(schema, ['a']).success, false)
  assert.equal(parse(schema, ['a', 'q']).success, true)
})

// ---------------------------------------------------------------------------
// The shared interpretation
// ---------------------------------------------------------------------------

test('classify carries `contains` on the array kind', () => {
  const kind = classify(audited)
  assert.equal(kind.kind, 'array')
  assert.ok(kind.kind === 'array' && kind.contains !== undefined)
  assert.equal(kind.kind === 'array' && kind.contains?.min, 1)
})

test('classify defaults minContains to 1 and reads maxContains', () => {
  const kind = classify({ ...audited, minContains: 2, maxContains: 4 })
  assert.ok(kind.kind === 'array')
  assert.equal(kind.kind === 'array' && kind.contains?.min, 2)
  assert.equal(kind.kind === 'array' && kind.contains?.max, 4)
})

test('a bare `contains` schema reads as an array', () => {
  const kind = classify({ contains: { const: 'x' } })
  assert.equal(kind.kind, 'array')
  assert.ok(Array.isArray(generate({ contains: { const: 'x' } }, 'bare')))
})

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

test('generation produces an array that satisfies `contains`', () => {
  for (const seed of SEEDS) {
    const value = generate(audited, seed)
    assert.ok(
      value.includes('audited'),
      `seed ${seed}: ${JSON.stringify(value)}`
    )
    assert.equal(parse(audited, value).success, true, `seed ${seed}`)
  }
})

test('generation produces minContains matching members', () => {
  const schema: Schema = { ...audited, minContains: 2 }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.ok(
      countMatching(value, (item) => item === 'audited') >= 2,
      `seed ${seed}: ${JSON.stringify(value)}`
    )
    assert.equal(parse(schema, value).success, true, `seed ${seed}`)
  }
})

test('generation stays within maxContains', () => {
  const schema: Schema = {
    type: 'array',
    items: { type: 'string', enum: ['keep', 'drop'] },
    contains: { const: 'keep' },
    maxContains: 1
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.ok(
      countMatching(value, (item) => item === 'keep') <= 1,
      `seed ${seed}: ${JSON.stringify(value)}`
    )
    assert.equal(parse(schema, value).success, true, `seed ${seed}`)
  }
})

test('minContains 0 asks generation for nothing in particular', () => {
  const schema: Schema = { ...audited, minContains: 0, minItems: 0, maxItems: 0 }
  for (const seed of SEEDS) {
    assert.deepEqual(generate(schema, seed), [])
  }
})

test('maxItems wins over minContains when the two cannot both hold', () => {
  // Three matching members demanded, room for one. `maxItems` is an explicit
  // bound on what a consumer will accept; overshooting it produces a body the
  // document forbids outright, so `minContains` is what yields.
  const schema: Schema = {
    type: 'array',
    items: { type: 'string', enum: ['x', 'y'] },
    contains: { const: 'x' },
    minContains: 3,
    minItems: 1,
    maxItems: 1
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.equal(value.length, 1, `seed ${seed}: ${JSON.stringify(value)}`)
    assert.deepEqual(value, ['x'], `seed ${seed}`)
  }
})

test('a generated tuple extends past its positions to satisfy `contains`', () => {
  const schema: Schema = {
    type: 'array',
    prefixItems: [{ const: 'head' }],
    items: { type: 'string', enum: ['a', 'b'] },
    contains: { const: 'b' }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.equal(value[0], 'head', `seed ${seed}: ${JSON.stringify(value)}`)
    assert.ok(value.includes('b'), `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(parse(schema, value).success, true, `seed ${seed}`)
  }
})

test('a closed tuple satisfies `contains` from a tuple position', () => {
  // No position past the tuple is allowed, so the contains member has to be a
  // tuple member: the position's own schema and `contains` together.
  const schema: Schema = {
    type: 'array',
    prefixItems: [{ const: 'head' }, { type: 'string', enum: ['a', 'b'] }],
    items: false,
    contains: { const: 'b' }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.deepEqual(value, ['head', 'b'], `seed ${seed}`)
    assert.equal(parse(schema, value).success, true, `seed ${seed}`)
  }
})

test('uniqueItems and `contains` hold together on a list', () => {
  const schema: Schema = {
    type: 'array',
    uniqueItems: true,
    minItems: 2,
    maxItems: 3,
    items: { type: 'string', enum: ['a', 'b', 'c'] },
    contains: { const: 'c' }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.equal(hasDuplicate(value), false, `seed ${seed}: ${JSON.stringify(value)}`)
    assert.ok(value.includes('c'), `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(parse(schema, value).success, true, `seed ${seed}`)
  }
})

test('uniqueItems, a tuple and `contains` hold together', () => {
  const schema: Schema = {
    type: 'array',
    uniqueItems: true,
    prefixItems: [{ const: 'head' }],
    items: { type: 'string', enum: ['x', 'y', 'z'] },
    contains: { const: 'z' }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.equal(value[0], 'head', `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(hasDuplicate(value), false, `seed ${seed}: ${JSON.stringify(value)}`)
    assert.ok(value.includes('z'), `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(parse(schema, value).success, true, `seed ${seed}`)
  }
})

test('generation with `contains` is byte-identical for the same seed', () => {
  for (const seed of SEEDS) {
    assert.equal(
      JSON.stringify(generate(audited, seed)),
      JSON.stringify(generate(audited, seed))
    )
  }
})

test('a `contains` floor makes depth truncation worth reporting', () => {
  // `minItems: 0` means the length alone would report nothing when the depth
  // budget truncates this array - but `minContains: 2` still declares content
  // that the empty array drops, exactly as a `minItems` array does.
  const schema: Schema = {
    type: 'array',
    minItems: 0,
    items: { type: 'string' },
    contains: { const: 'audited' },
    minContains: 2
  }
  const seen: string[] = []
  const value = generateValue(schema, createRng('depth'), {
    maxDepth: 0,
    onDepthExhausted: (path) => seen.push(path)
  })
  assert.deepEqual(value, [])
  assert.deepEqual(seen, ['$[]'])
})

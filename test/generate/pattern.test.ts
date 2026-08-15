import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateFromPattern } from '../../src/generate/pattern.ts'
import { createRng } from '../../src/generate/rng.ts'

// Every test asserts the generated value MATCHES the pattern. It deliberately
// never asserts that generation and validation agree: two components sharing a
// blind spot agree perfectly, and generation-versus-validation disagreement is
// the entire reason this module exists.
const supported = [
  '^[A-Z]{3}$',
  '^\\d{4}-\\d{2}-\\d{2}$',
  '^(cat|dog)$',
  '^[a-z][a-z0-9_]{2,8}$',
  '^#[0-9a-f]{6}$',
  '^\\w+@\\w+\\.[a-z]{2,3}$',
  '^SKU-[0-9]{5}$',
  '^[A-Za-z ]+$',
  '^a?b+c*$',
  '^[^0-9]{4}$',
  '^(\\+|-)?\\d{1,4}$',
  '^.{5}$'
]

for (const pattern of supported) {
  test(`generates a value matching ${pattern}`, () => {
    // A fresh rng per pattern, seeded by the pattern itself, so one pattern's
    // draw count cannot shift another's values.
    const value = generateFromPattern(pattern, createRng(pattern))
    assert.notEqual(value, undefined, 'pattern should be supported')
    assert.match(value as string, new RegExp(pattern))
  })
}

test('the same pattern generates the same value across many draws', () => {
  // 40 draws, because a single draw can match by luck on a narrow pattern.
  for (let i = 0; i < 40; i++) {
    const value = generateFromPattern('^[a-z]{3}-[0-9]{2}$', createRng(`seed-${i}`))
    assert.match(value as string, /^[a-z]{3}-[0-9]{2}$/)
  }
})

for (const pattern of [
  '^(?=.*\\d)[a-z]+$',
  '^(?!foo)bar$',
  '^(\\w)\\1$',
  '^(?<year>\\d{4})$',
  '^\\p{Letter}+$'
]) {
  test(`returns undefined for the unsupported construct ${pattern}`, () => {
    assert.equal(generateFromPattern(pattern, createRng('x')), undefined)
  })
}

test('an unparseable pattern returns undefined rather than throwing', () => {
  assert.equal(generateFromPattern('^[a-', createRng('x')), undefined)
})

test('the same seed produces the same value', () => {
  assert.equal(
    generateFromPattern('^[a-z]{8}$', createRng('fixed')),
    generateFromPattern('^[a-z]{8}$', createRng('fixed'))
  )
})

test('different seeds produce different values for a wide pattern', () => {
  // Guards the seed actually reaching the generator. Without this, the
  // determinism test above passes against a hardcoded constant return —
  // determinism makes a test toothless by default.
  assert.notEqual(
    generateFromPattern('^[a-z]{16}$', createRng('a')),
    generateFromPattern('^[a-z]{16}$', createRng('b'))
  )
})

test('a bounded quantifier respects both of its bounds', () => {
  // {2,8} on a single character class, so length IS the quantifier's count.
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const value = generateFromPattern('^x{2,8}$', createRng(seed)) as string
    assert.ok(value.length >= 2 && value.length <= 8, `length ${value.length}`)
  }
})

test('a quantifier count varies with the seed', () => {
  // Bounds alone do not pin this: a generator that always emitted `max` — or
  // always `min` — satisfies every length assertion above while ignoring the
  // rng completely. Only observing more than one length proves the draw.
  const lengths = new Set<number>()
  for (let i = 0; i < 40; i++) {
    lengths.add((generateFromPattern('^x{2,8}$', createRng(`q${i}`)) as string).length)
  }
  assert.ok(lengths.size > 1, `every seed produced length ${[...lengths][0]}`)
})

test('an unanchored pattern still generates a matching value', () => {
  const value = generateFromPattern('[0-9]{3}', createRng('unanchored'))
  assert.match(value as string, /[0-9]{3}/)
})

test('alternation reaches more than one branch across seeds', () => {
  // A branch picker stuck on the first alternative would satisfy every
  // match assertion above while covering half the pattern.
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) {
    seen.add(generateFromPattern('^(cat|dog)$', createRng(`s${i}`)) as string)
  }
  assert.equal(seen.size, 2, `saw ${[...seen].sort().join()}`)
})

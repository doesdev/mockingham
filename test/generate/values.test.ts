import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../src/generate/rng.ts'
import {
  generateBoolean, generateInteger, generateNumber, generateString
} from '../../src/generate/values.ts'
import {
  createVirtualClock, DEFAULT_SEED_TIME, TICKS_PER_ALLOCATION
} from '../../src/generate/clock.ts'

test('strings respect length bounds', () => {
  const rng = createRng('strings')
  for (let i = 0; i < 200; i++) {
    const value = generateString({ minLength: 3, maxLength: 6 }, rng)
    assert.ok(value.length >= 3 && value.length <= 6, `bad length: ${value}`)
  }
})

test('email format produces a plausible address', () => {
  const value = generateString({ type: 'string', format: 'email' }, createRng('e'))
  assert.match(value, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/)
})

test('uuid format produces a v4-shaped uuid', () => {
  const value = generateString({ type: 'string', format: 'uuid' }, createRng('u'))
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
})

test('date-time format parses as a date', () => {
  const value = generateString({ type: 'string', format: 'date-time' }, createRng('d'))
  assert.ok(!Number.isNaN(Date.parse(value)))
})

test('date format is calendar-only', () => {
  const value = generateString({ type: 'string', format: 'date' }, createRng('d2'))
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/)
})

test('ipv4 format produces four octets in range', () => {
  const value = generateString({ type: 'string', format: 'ipv4' }, createRng('ip'))
  const octets = value.split('.').map(Number)
  assert.equal(octets.length, 4)
  for (const octet of octets) assert.ok(octet >= 0 && octet <= 255)
})

test('generation is deterministic for a given seed', () => {
  const schema = { type: 'string', format: 'email' }
  const first = generateString(schema, createRng('same'))
  const second = generateString(schema, createRng('same'))
  assert.equal(first, second)
})

test('integers respect bounds and are whole numbers', () => {
  const rng = createRng('ints')
  for (let i = 0; i < 200; i++) {
    const value = generateInteger({ minimum: 10, maximum: 12 }, rng)
    assert.ok(Number.isInteger(value))
    assert.ok(value >= 10 && value <= 12, `out of range: ${value}`)
  }
})

test('integers respect multipleOf', () => {
  const rng = createRng('multiples')
  for (let i = 0; i < 100; i++) {
    const value = generateInteger({ minimum: 0, maximum: 100, multipleOf: 5 }, rng)
    assert.equal(value % 5, 0)
  }
})

test('numbers respect bounds', () => {
  const rng = createRng('numbers')
  for (let i = 0; i < 200; i++) {
    const value = generateNumber({ minimum: 1.5, maximum: 2.5 }, rng)
    assert.ok(value >= 1.5 && value <= 2.5, `out of range: ${value}`)
  }
})

test('integers stay within bounds when no integer fits the range', () => {
  const rng = createRng('fractional')
  for (let i = 0; i < 50; i++) {
    const value = generateInteger({ minimum: 1.2, maximum: 1.8 }, rng)
    assert.ok(Number.isInteger(value))
    assert.ok(value <= 2, `overshot the range: ${value}`)
  }
})

test('number rounding never escapes the declared bounds', () => {
  // The spec's suggested first loop used minimum 1.504 with maximum 1.237 -
  // an inverted, contradictory range. numberBounds() collapses that to a
  // single point (max is forced up to min), and the assertion
  // `value >= 1.237 || value <= 1.504` is a tautology that passes for any
  // number, so it exercises nothing. This loop replaces it with bounds whose
  // hundredths digit genuinely forces a rounding overshoot: a raw value like
  // 1.2369999 rounds to 1.24, above the 1.237 maximum, which is exactly the
  // case the clamp-after-round fix guards against.
  const rng = createRng('rounding')
  for (let i = 0; i < 500; i++) {
    const value = generateNumber({ minimum: 1.2, maximum: 1.237 }, rng)
    assert.ok(value >= 1.2 && value <= 1.237, `out of range: ${value}`)
  }
  for (let i = 0; i < 500; i++) {
    const value = generateNumber({ minimum: 0.001, maximum: 0.004 }, rng)
    assert.ok(value >= 0.001 && value <= 0.004, `out of range: ${value}`)
  }
})

test('booleans are booleans', () => {
  assert.equal(typeof generateBoolean(createRng('b')), 'boolean')
})

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// One reserved block, which is what a single request or emission gets.
const clock = () => createVirtualClock().allocate()

test('format uuid7 produces a well-formed v7', () => {
  const value = generateString(
    { type: 'string', format: 'uuid7' }, createRng('s'), { clock: clock() })
  assert.match(value, V7)
})

test('the uuidv7 and uuid-v7 spellings are recognized too', () => {
  assert.match(
    generateString({ type: 'string', format: 'uuidv7' }, createRng('s'), { clock: clock() }),
    V7
  )
  assert.match(
    generateString({ type: 'string', format: 'uuid-v7' }, createRng('s'), { clock: clock() }),
    V7
  )
})

test('successive v7 values sort by generation order', () => {
  const c = clock()
  const rng = createRng('s')
  const ids = Array.from(
    { length: 20 },
    () => generateString({ type: 'string', format: 'uuid7' }, rng, { clock: c })
  )
  // The whole point of v7. Sorting must be lexicographic on the raw string.
  assert.deepEqual([...ids].sort(), ids)
})

test('the same seed and seedTime reproduce the same ids', () => {
  const one = generateString(
    { type: 'string', format: 'uuid7' }, createRng('s'), { clock: clock() })
  const two = generateString(
    { type: 'string', format: 'uuid7' }, createRng('s'), { clock: clock() })
  assert.equal(one, two)
})

test('x-mock-format wins over a plain uuid format', () => {
  const value = generateString(
    { type: 'string', format: 'uuid', 'x-mock-format': 'uuid7' },
    createRng('s'),
    { clock: clock() }
  )
  assert.match(value, V7)
})

test('a pattern outranks a uuid7 format, the way it outranks any other', () => {
  // master §3: a `pattern` beats a conflicting `format`, and `uuid7` is
  // selected by `format`/`x-mock-format` like any other. Pinned because the
  // two features were built on separate branches and met in a merge - nothing
  // else records which one wins.
  const value = generateString(
    { type: 'string', format: 'uuid7', pattern: '^[A-Z]{3}$' },
    createRng('pu'),
    { clock: clock() }
  )
  assert.match(value, /^[A-Z]{3}$/)
})

test('plain uuid is still v4', () => {
  // The existing behavior must not move.
  const value = generateString(
    { type: 'string', format: 'uuid' }, createRng('s'), { clock: clock() })
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('the virtual clock starts at seedTime and reset returns it there', () => {
  const c = createVirtualClock(1735689600000)
  const first = c.allocate()
  assert.equal(first.next(), 1735689600000)
  assert.equal(first.next(), 1735689600001)
  c.reset()
  assert.equal(c.allocate().next(), 1735689600000)
})

test('the default seed time is a fixed constant, never the wall clock', () => {
  const c = createVirtualClock()
  assert.equal(c.allocate().next(), DEFAULT_SEED_TIME)
  assert.equal(DEFAULT_SEED_TIME, Date.parse('2025-01-01T00:00:00.000Z'))
})

test('each allocation gets its own block, in the order allocate was called', () => {
  // The mechanism the async-ordering fix rests on: a block is fixed when it is
  // RESERVED, so a ticker allocated first sorts before one allocated second no
  // matter which one draws first. Drawing out of allocation order here is the
  // whole point — it models a delayed emission generating after a later
  // request has already generated.
  const c = createVirtualClock(0)
  const first = c.allocate()
  const second = c.allocate()
  assert.equal(second.next(), TICKS_PER_ALLOCATION)
  assert.equal(first.next(), 0)
  assert.ok(first.next() < second.next(), 'the first block stays below the second')
})

test('a patterned string generates a value matching its pattern', () => {
  const rng = createRng('patterned')
  for (let i = 0; i < 50; i++) {
    const value = generateString({ type: 'string', pattern: '^[A-Z]{3}$' }, rng)
    assert.match(value, /^[A-Z]{3}$/)
  }
})

test('pattern wins over format', () => {
  // compile.ts enforces the declared pattern on incoming requests, so an
  // `email`-shaped value that fails the pattern is exactly the asymmetry this
  // closes: a body the mock emits but would reject.
  const value = generateString(
    { type: 'string', format: 'email', pattern: '^[A-Z]{3}$' },
    createRng('pf')
  )
  assert.match(value, /^[A-Z]{3}$/)
})

test('fitLength does not run on a pattern-generated value', () => {
  // minLength 20 would append `-${word}` and break the match; maxLength 2
  // would slice it. Neither may touch a pattern-generated value.
  const long = generateString(
    { type: 'string', pattern: '^[A-Z]{3}$', minLength: 20 },
    createRng('fl')
  )
  assert.match(long, /^[A-Z]{3}$/)
  assert.equal(long.length, 3)

  const short = generateString(
    { type: 'string', pattern: '^[A-Z]{3}$', maxLength: 2 },
    createRng('fs')
  )
  assert.match(short, /^[A-Z]{3}$/)
})

test('an unsupported pattern reports itself and falls back', () => {
  const seen: string[] = []
  const value = generateString(
    { type: 'string', pattern: '^(?=.*\\d)[a-z]+$' },
    createRng('unsup'),
    { onUnsupportedPattern: (pattern) => seen.push(pattern) }
  )
  assert.deepEqual(seen, ['^(?=.*\\d)[a-z]+$'])
  // Falls back to the ordinary placeholder rather than emitting nothing.
  assert.ok(value.length > 0)
})

test('a supported pattern reports nothing', () => {
  const seen: string[] = []
  generateString(
    { type: 'string', pattern: '^[A-Z]{3}$' },
    createRng('sup'),
    { onUnsupportedPattern: (pattern) => seen.push(pattern) }
  )
  assert.deepEqual(seen, [])
})

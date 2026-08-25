import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../src/generate/rng.ts'
import {
  generateBoolean, generateInteger, generateNumber, generateString
} from '../../src/generate/values.ts'
import { createVirtualClock, DEFAULT_SEED_TIME } from '../../src/generate/clock.ts'

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
  // The spec's suggested first loop used minimum 1.504 with maximum 1.237 —
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

const clock = () => createVirtualClock()

test('format uuid7 produces a well-formed v7', () => {
  const value = generateString({ type: 'string', format: 'uuid7' }, createRng('s'), clock())
  assert.match(value, V7)
})

test('the uuidv7 and uuid-v7 spellings are recognized too', () => {
  assert.match(
    generateString({ type: 'string', format: 'uuidv7' }, createRng('s'), clock()),
    V7
  )
  assert.match(
    generateString({ type: 'string', format: 'uuid-v7' }, createRng('s'), clock()),
    V7
  )
})

test('successive v7 values sort by generation order', () => {
  const c = clock()
  const rng = createRng('s')
  const ids = Array.from(
    { length: 20 },
    () => generateString({ type: 'string', format: 'uuid7' }, rng, c)
  )
  // The whole point of v7. Sorting must be lexicographic on the raw string.
  assert.deepEqual([...ids].sort(), ids)
})

test('the same seed and seedTime reproduce the same ids', () => {
  const one = generateString({ type: 'string', format: 'uuid7' }, createRng('s'), clock())
  const two = generateString({ type: 'string', format: 'uuid7' }, createRng('s'), clock())
  assert.equal(one, two)
})

test('x-mock-format wins over a plain uuid format', () => {
  const value = generateString(
    { type: 'string', format: 'uuid', 'x-mock-format': 'uuid7' }, createRng('s'), clock())
  assert.match(value, V7)
})

test('plain uuid is still v4', () => {
  // The existing behavior must not move.
  const value = generateString({ type: 'string', format: 'uuid' }, createRng('s'), clock())
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('the virtual clock starts at seedTime and reset returns it there', () => {
  const c = createVirtualClock(1735689600000)
  assert.equal(c.next(), 1735689600000)
  assert.equal(c.next(), 1735689600001)
  c.reset()
  assert.equal(c.next(), 1735689600000)
})

test('the default seed time is a fixed constant, never the wall clock', () => {
  const c = createVirtualClock()
  assert.equal(c.next(), DEFAULT_SEED_TIME)
  assert.equal(DEFAULT_SEED_TIME, Date.parse('2025-01-01T00:00:00.000Z'))
})

import type { Schema } from '../spec/types.ts'
import type { Rng } from './rng.ts'
import { applyMultipleOf, numberBounds, stringLength } from './constraints.ts'
import { DEFAULT_SEED_TIME } from './clock.ts'
import type { Ticker } from './clock.ts'
import { generateFromPattern } from './pattern.ts'

export interface StringOptions {
  /**
   * Called with a `pattern` the generator's subset cannot express. Reported
   * every time here - deduplication is the caller's job, because "once" is a
   * property of a mock's lifetime rather than of one value.
   */
  onUnsupportedPattern?: (pattern: string) => void
  /**
   * This request's reserved block of UUIDv7 timestamps. Absent for a call site
   * outside a mock, which still generates a well-formed v7 - every value just
   * carries the same constant timestamp, so it loses an ordering there is
   * nothing to order.
   */
  clock?: Ticker
}

const WORDS = [
  'alder', 'basalt', 'cedar', 'dune', 'ember', 'fjord', 'gale', 'harbor',
  'ivory', 'juniper', 'kelp', 'larch', 'marsh', 'nimbus', 'onyx', 'pine',
  'quarry', 'ridge', 'slate', 'thicket', 'umber', 'vale', 'willow', 'zephyr'
] as const

const GIVEN = ['cara', 'neil', 'ada', 'omar', 'ines', 'raul', 'thea', 'yuki'] as const
const FAMILY = ['whitfield', 'ashford', 'nakamura', 'olsen', 'pereira', 'quinn'] as const
const TLDS = ['com', 'io', 'dev', 'eu'] as const
const HEX = '0123456789abcdef'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Fixed epoch so generated dates are reproducible across runs. */
const EPOCH_MS = Date.parse('2024-01-01T00:00:00.000Z')
const YEAR_MS = 365 * 24 * 60 * 60 * 1000

function word(rng: Rng): string {
  return rng.pick(WORDS)
}

function hex(rng: Rng, count: number): string {
  let out = ''
  for (let i = 0; i < count; i++) out += HEX[rng.int(0, 15)]
  return out
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function fitLength(value: string, schema: Schema, rng: Rng): string {
  const { min, max } = stringLength(schema)
  let out = value
  while (out.length < min) out += `-${word(rng)}`
  if (out.length > max) out = out.slice(0, max)
  return out
}

function generateDate(rng: Rng): Date {
  return new Date(EPOCH_MS + rng.int(0, YEAR_MS))
}

/**
 * `format: "uuid7"` plus the RFC-adjacent spellings. `format` is an open string
 * in JSON Schema, so recognizing these is a legal extension rather than a
 * redefinition of the registered `uuid` format - which stays v4, unchanged.
 *
 * An array rather than a Set: membership is all that is needed, and invariant 2
 * forbids iteration over an unordered Set in a generation path.
 */
const UUID7_FORMATS = ['uuid7', 'uuidv7', 'uuid-v7'] as const

function normalizeFormat(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined
}

/**
 * `x-mock-format` wins over `format`, so a document that cannot change `format`
 * without breaking another consumer's validation can still ask for a v7.
 */
function wantsUuid7(schema: Schema): boolean {
  const requested = normalizeFormat(schema['x-mock-format'])
    ?? normalizeFormat(schema.format)
  return requested !== undefined
    && (UUID7_FORMATS as readonly string[]).includes(requested)
}

/**
 * RFC 9562 layout: 48 bits of millisecond timestamp, version `7`, 12 random
 * bits, variant `10`, then 62 more random bits. The timestamp comes from the
 * seeded virtual clock and the random bits from the existing seeded PRNG, so
 * the value is reproducible across processes despite carrying a time.
 *
 * With no clock supplied - a call site that generates outside a mock - every
 * value carries the same constant timestamp. Still deterministic, still a
 * well-formed v7; it simply loses the ordering, which is nothing to order.
 */
function generateUuid7(rng: Rng, clock?: Ticker): string {
  const ms = clock ? clock.next() : DEFAULT_SEED_TIME
  const stamp = ms.toString(16).padStart(12, '0').slice(-12)
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${hex(rng, 3)}-${
    HEX[rng.int(8, 11)]
  }${hex(rng, 3)}-${hex(rng, 12)}`
}

export function generateString(
  schema: Schema,
  rng: Rng,
  options: StringOptions = {}
): string {
  // Before `format`, because `pattern` is what request validation enforces
  // (`schema/compile.ts`) - a format-shaped value that fails the declared
  // pattern is a body the mock emits and would then reject.
  //
  // This is also why it precedes the `uuid7` check below rather than following
  // it: master §3 says a `pattern` outranks a conflicting `format`, and
  // `uuid7` is selected by `format`/`x-mock-format` like any other. A schema
  // declaring both gets the pattern-conforming value.
  if (schema.pattern !== undefined) {
    const value = generateFromPattern(schema.pattern, rng)
    // Returned directly, never through `fitLength`: appending to reach
    // `minLength` or slicing to `maxLength` breaks the match, which would
    // trade one silently wrong value for another.
    if (value !== undefined) return value
    options.onUnsupportedPattern?.(schema.pattern)
    // Falls through. `example` and `default` were already consulted by
    // `generateValue` before this was ever called, so what follows is the
    // placeholder that master §3 names as the last step of the chain.
  }

  if (wantsUuid7(schema)) return generateUuid7(rng, options.clock)

  switch (schema.format) {
    case 'email':
      return `${rng.pick(GIVEN)}.${rng.pick(FAMILY)}@${word(rng)}.${rng.pick(TLDS)}`
    case 'uuid':
      return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${
        HEX[rng.int(8, 11)]
      }${hex(rng, 3)}-${hex(rng, 12)}`
    case 'uri':
    case 'url':
      return `https://${word(rng)}.${rng.pick(TLDS)}/${word(rng)}`
    case 'hostname':
      return `${word(rng)}.${rng.pick(TLDS)}`
    case 'ipv4':
      return `${rng.int(1, 254)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`
    case 'ipv6':
      return `${hex(rng, 4)}:${hex(rng, 4)}:${hex(rng, 4)}:${hex(rng, 4)}`
    case 'date':
      return generateDate(rng).toISOString().slice(0, 10)
    case 'date-time':
      return generateDate(rng).toISOString()
    case 'time':
      return `${pad(rng.int(0, 23), 2)}:${pad(rng.int(0, 59), 2)}:${pad(rng.int(0, 59), 2)}`
    case 'duration':
      return `P${rng.int(1, 30)}D`
    case 'byte': {
      let out = ''
      for (let i = 0; i < 12; i++) out += B64[rng.int(0, 63)]
      return `${out}==`
    }
    case 'password':
      return `${word(rng)}-${hex(rng, 6)}`
    default:
      return fitLength(word(rng), schema, rng)
  }
}

export function generateInteger(schema: Schema, rng: Rng): number {
  const { min, max } = numberBounds(schema)
  const low = Math.ceil(min)
  const high = Math.floor(max)
  // No integer exists in [min, max] - e.g. minimum 1.2 with maximum 1.8. The
  // schema is unsatisfiable for an integer, so any value violates something.
  // Return the nearest integer to the range rather than one derived from an
  // inverted rng.int call, which would land above the maximum.
  if (low > high) return applyMultipleOf(Math.round(min), schema)
  return applyMultipleOf(rng.int(low, high), schema)
}

export function generateNumber(schema: Schema, rng: Rng): number {
  const { min, max } = numberBounds(schema)
  const raw = min + rng.next() * (max - min)
  const rounded = Math.round(raw * 100) / 100
  // Rounding for readability must not escape the declared range, so clamp
  // after rounding rather than before.
  const clamped = rounded < min ? min : rounded > max ? max : rounded
  return applyMultipleOf(clamped, schema)
}

export function generateBoolean(rng: Rng): boolean {
  return rng.bool()
}

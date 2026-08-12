import type { Schema } from '../spec/types.ts'
import type { Rng } from './rng.ts'
import { applyMultipleOf, numberBounds, stringLength } from './constraints.ts'

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

export function generateString(schema: Schema, rng: Rng): string {
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
  return applyMultipleOf(rng.int(Math.ceil(min), Math.floor(max)), schema)
}

export function generateNumber(schema: Schema, rng: Rng): number {
  const { min, max } = numberBounds(schema)
  const raw = min + rng.next() * (max - min)
  const rounded = Math.round(raw * 100) / 100
  return applyMultipleOf(rounded, schema)
}

export function generateBoolean(rng: Rng): boolean {
  return rng.bool()
}

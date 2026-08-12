import type { Schema } from '../spec/types.ts'
import { classify } from '../schema/walk.ts'
import { arrayLength } from './constraints.ts'
import type { Rng } from './rng.ts'
import {
  generateBoolean, generateInteger, generateNumber, generateString
} from './values.ts'

export interface GenerateOptions {
  maxDepth?: number
  preferExamples?: boolean
}

const DEFAULT_MAX_DEPTH = 3

export function generateValue(
  schema: Schema,
  rng: Rng,
  options: GenerateOptions = {}
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const preferExamples = options.preferExamples ?? true

  function walk(current: Schema, depth: number): unknown {
    if (preferExamples && current.example !== undefined) return current.example
    if (current.default !== undefined) return current.default

    const kind = classify(current)

    switch (kind.kind) {
      case 'const':
        return kind.value
      case 'enum':
        return rng.pick(kind.values)
      case 'string':
        return generateString(current, rng)
      case 'integer':
        return generateInteger(current, rng)
      case 'number':
        return generateNumber(current, rng)
      case 'boolean':
        return generateBoolean(rng)
      case 'null':
        return null
      case 'union':
        return depth >= maxDepth ? null : walk(rng.pick(kind.variants), depth + 1)
      case 'array': {
        if (depth >= maxDepth) return []
        const { min, max } = arrayLength(current)
        const count = rng.int(min, max)
        const items: unknown[] = []
        for (let i = 0; i < count; i++) items.push(walk(kind.items, depth + 1))
        return items
      }
      case 'object': {
        if (depth >= maxDepth) return {}
        const out: Record<string, unknown> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          out[name] = walk(property, depth + 1)
        }
        return out
      }
      default:
        return null
    }
  }

  return walk(schema, 0)
}

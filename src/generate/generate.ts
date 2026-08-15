import type { Schema } from '../spec/types.ts'
import { classify, mergeAllOf } from '../schema/walk.ts'
import { arrayLength } from './constraints.ts'
import type { Rng } from './rng.ts'
import type { ResolverLookup } from '../resolve/resolvers.ts'
import {
  generateBoolean, generateInteger, generateNumber, generateString
} from './values.ts'

export interface GenerateOptions {
  maxDepth?: number
  preferExamples?: boolean
  resolvers?: ResolverLookup
  schemaNames?: Map<Schema, string>
  /** Passed through to resolver callbacks. Typed loosely to avoid a cycle. */
  ctx?: unknown
  /**
   * Called with a `pattern` value generation cannot express, every time one is
   * generated. The handler deduplicates and routes it to `onWarn`.
   */
  onUnsupportedPattern?: (pattern: string) => void
}

const DEFAULT_MAX_DEPTH = 3

export function generateValue(
  schema: Schema,
  rng: Rng,
  options: GenerateOptions = {}
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const preferExamples = options.preferExamples ?? true

  function walk(
    current: Schema,
    depth: number,
    propertyName?: string,
    containerName?: string
  ): unknown {
    const hook = options.resolvers?.resolve(
      current, propertyName, containerName, options.ctx
    )
    // A resolver may legitimately return undefined, so hit is checked rather
    // than the value. A returned promise is left in the tree for the override
    // pass to settle — generation itself stays synchronous.
    if (hook?.hit) return hook.value

    if (preferExamples && current.example !== undefined) return current.example
    if (current.default !== undefined) return current.default

    const kind = classify(current)
    // `classify` merges `allOf` internally to decide the shape, but the
    // constraint readers below (`generateString`, `generateInteger`, ...)
    // still need the merged view — otherwise a bound that lives only on an
    // `allOf` member is silently dropped even though `classify` saw it. This
    // must mirror `src/schema/compile.ts` exactly, or generation and
    // validation drift on precisely the schemas that need them to agree most.
    const merged = mergeAllOf(current)

    switch (kind.kind) {
      case 'const':
        return kind.value
      case 'enum':
        return rng.pick(kind.values)
      case 'string':
        // `GenerateOptions` already satisfies `StringOptions` structurally, so
        // this passes through rather than rebuilding a one-field object for
        // every string generated.
        return generateString(merged, rng, options)
      case 'integer':
        return generateInteger(merged, rng)
      case 'number':
        return generateNumber(merged, rng)
      case 'boolean':
        return generateBoolean(rng)
      case 'null':
        return null
      case 'union':
        return depth >= maxDepth ? null : walk(rng.pick(kind.variants), depth + 1)
      case 'array': {
        if (depth >= maxDepth) return []
        const { min, max } = arrayLength(merged)
        const count = rng.int(min, max)
        const items: unknown[] = []
        for (let i = 0; i < count; i++) {
          items.push(walk(kind.items, depth + 1, propertyName, containerName))
        }
        return items
      }
      case 'object': {
        if (depth >= maxDepth) return {}
        const out: Record<string, unknown> = {}
        // The container name is this schema's own component name, so a
        // bySchema entry for `User` addresses the properties declared on User.
        const name = options.schemaNames?.get(current)
        for (const [property, schema] of Object.entries(kind.properties)) {
          out[property] = walk(schema, depth + 1, property, name)
        }
        return out
      }
      default:
        return null
    }
  }

  return walk(schema, 0)
}

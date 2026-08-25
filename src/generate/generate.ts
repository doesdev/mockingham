import type { Schema } from '../spec/types.ts'
import { classify, matchesVariant, mergeAllOf } from '../schema/walk.ts'
import { arrayLength } from './constraints.ts'
import type { Rng } from './rng.ts'
import type { VirtualClock } from './clock.ts'
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
   * Selects a union branch by its discriminator value, at every union in the
   * tree. A name matching no branch falls through to the seeded pick.
   */
  variant?: string
  /**
   * The per-mock seeded virtual clock UUIDv7 generation reads. Per-mock rather
   * than per-request, so ids from successive requests sort correctly.
   */
  clock?: VirtualClock
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
        return generateString(merged, rng, options.clock)
      case 'integer':
        return generateInteger(merged, rng)
      case 'number':
        return generateNumber(merged, rng)
      case 'boolean':
        return generateBoolean(rng)
      case 'null':
        return null
      case 'union': {
        if (depth >= maxDepth) return null
        // A requested variant selects its branch directly, which deliberately
        // skips the `rng.pick` call — so a request with a variant produces a
        // different byte stream than one without. The same variant always
        // produces the same bytes, which is what invariant 2 requires.
        const requested = options.variant
        const chosen =
          requested === undefined
            ? undefined
            : kind.variants.find(
                (branch) => matchesVariant(branch, kind.discriminator, requested)
              )
        // An unmatched name falls through to the seeded pick rather than
        // failing, matching `Prefer: status` (src/runtime/select.ts).
        return walk(chosen ?? rng.pick(kind.variants), depth + 1)
      }
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

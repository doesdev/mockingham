import type { Schema } from '../spec/types.ts'
import { classify, matchesVariant, mergeAllOf } from '../schema/walk.ts'
import { arrayLength } from './constraints.ts'
import type { Rng } from './rng.ts'
import type { Ticker } from './clock.ts'
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
   * The block of seeded timestamps UUIDv7 generation draws from. One per
   * request and one per emission, reserved SYNCHRONOUSLY by
   * `VirtualClock.allocate()` before any await - so ids still sort by request
   * order without generation order deciding anything. See `clock.ts` for why a
   * single shared counter broke invariant 2.
   */
  clock?: Ticker
  /**
   * Called with a `pattern` value generation cannot express, every time one is
   * generated. The handler deduplicates and routes it to `onWarn`.
   */
  onUnsupportedPattern?: (pattern: string) => void
}

const DEFAULT_MAX_DEPTH = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    containerName?: string,
    /**
     * The schema whose component name this node answers to, when it is not
     * `current` itself. Only a union's sibling base passes it: the base is a
     * derived copy, so a `bySchema` resolver would otherwise stop finding the
     * component the properties were declared on.
     */
    identity?: Schema
  ): unknown {
    const hook = options.resolvers?.resolve(
      current, propertyName, containerName, options.ctx
    )
    // A resolver may legitimately return undefined, so hit is checked rather
    // than the value. A returned promise is left in the tree for the override
    // pass to settle - generation itself stays synchronous.
    if (hook?.hit) return hook.value

    if (preferExamples && current.example !== undefined) return current.example
    if (current.default !== undefined) return current.default

    const kind = classify(current)
    // `classify` merges `allOf` internally to decide the shape, but the
    // constraint readers below (`generateString`, `generateInteger`, ...)
    // still need the merged view - otherwise a bound that lives only on an
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
        // `GenerateOptions` already satisfies `StringOptions` structurally -
        // `clock` and `onUnsupportedPattern` both live on it - so this passes
        // through rather than rebuilding an object for every string generated.
        return generateString(merged, rng, options)
      case 'integer':
        return generateInteger(merged, rng)
      case 'number':
        return generateNumber(merged, rng)
      case 'boolean':
        return generateBoolean(rng)
      case 'null':
        return null
      case 'union': {
        // A sibling shape makes this node an object as much as a union, so an
        // exhausted budget yields the empty object the object case would.
        const base = kind.base
        if (depth >= maxDepth) return base === undefined ? null : {}
        // A requested variant selects its branch directly, which deliberately
        // skips the `rng.pick` call - so a request with a variant produces a
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
        const branch = chosen ?? rng.pick(kind.variants)
        if (base === undefined) return walk(branch, depth + 1)

        // With a sibling shape both constrain the same instance: generate the
        // declared object, then lay the chosen branch's own contribution over
        // it. `identity` keeps bySchema resolvers pointed at the component,
        // whose name the derived base is not registered under.
        const value = walk(base, depth, propertyName, containerName, current)
        // A branch declaring only `required` - the usual "at least one of
        // these" idiom - adds nothing: every declared property is generated
        // anyway. Only a branch with a shape of its own contributes.
        if (classify(branch).kind !== 'object') return value
        const extra = walk(branch, depth, propertyName, containerName)
        if (!isRecord(value)) return extra
        if (!isRecord(extra)) return value
        return { ...value, ...extra }
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
        const name = options.schemaNames?.get(identity ?? current)
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

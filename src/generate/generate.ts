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
  /**
   * Called with the schema path of a container the depth budget truncated -
   * `$.result.payload`, `$.rows[]` - every time one is truncated. The handler
   * deduplicates and routes it to `onWarn`, exactly as `onUnsupportedPattern`
   * is routed.
   *
   * Truncation is otherwise indistinguishable from success at the HTTP layer:
   * the status is 200, the media type is right, the body parses, and the top
   * level keys are present - only the declared `required` properties further
   * down are missing. This is the only signal that it happened.
   *
   * Reporting must never change what is generated. It reads no randomness and
   * is called after the truncated value is already decided, so invariant 2 is
   * untouched whether a handler is supplied or not.
   */
  onDepthExhausted?: (path: string) => void
}

/**
 * The nesting depth generation walks before it truncates.
 *
 * This was 3, which is reached by envelope structure alone: three wrapper
 * levels around a payload exhaust the budget before the payload's own nesting
 * begins, and the truncated body then violates the document's own `required`
 * list while answering 200. Twelve leaves recursion protection fully intact -
 * a cyclic schema still terminates, which is the only thing the budget exists
 * for - while clearing every ordinary document. It is a bound on runaway
 * recursion, not a size limit on honest documents.
 */
export const DEFAULT_MAX_DEPTH = 12

/**
 * How many unions may be resolved in a row before generation gives up.
 *
 * Resolving a union no longer spends a level of the depth budget - choosing a
 * branch is a decision about what this node is, not a step down the tree - so
 * `maxDepth` alone no longer bounds a schema whose union branch is the union
 * itself (`Node: { oneOf: [Node, ...] }`). Every other kind still descends
 * through `depth + 1`, so this only ever bounds a chain of bare unions, and any
 * non-union resets it.
 */
const MAX_UNION_HOPS = 32

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
    path = '$',
    unionHops = 0
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
        // Only a chain of bare unions can reach this - see MAX_UNION_HOPS.
        if (unionHops >= MAX_UNION_HOPS) return null
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
        //
        // `depth`, NOT `depth + 1`: resolving a union is a decision about what
        // this node is, not a step down the tree. Spending a level here made an
        // otherwise identical document truncate one level earlier whenever a
        // union appeared in it. Passing the depth through also removes the old
        // `return null` at exhaustion - the chosen branch now hits its own
        // guard and truncates in kind, `{}` for an object and `[]` for an
        // array, instead of handing a consumer a null where an object is
        // declared.
        return walk(
          chosen ?? rng.pick(kind.variants),
          depth,
          // Deliberately not forwarded, as before: a resolver already saw this
          // property name at the union node itself.
          undefined,
          undefined,
          path,
          unionHops + 1
        )
      }
      case 'array': {
        const { min, max } = arrayLength(merged)
        if (depth >= maxDepth) {
          if (min > 0) options.onDepthExhausted?.(`${path}[]`)
          return []
        }
        const count = rng.int(min, max)
        const items: unknown[] = []
        for (let i = 0; i < count; i++) {
          items.push(
            walk(kind.items, depth + 1, propertyName, containerName, `${path}[]`)
          )
        }
        return items
      }
      case 'object': {
        if (depth >= maxDepth) {
          // An object with nothing declared on it generates `{}` at any depth,
          // so there is nothing to report - only a truncation that actually
          // drops declared properties is worth a warning.
          if (Object.keys(kind.properties).length > 0) {
            options.onDepthExhausted?.(path)
          }
          return {}
        }
        const out: Record<string, unknown> = {}
        // The container name is this schema's own component name, so a
        // bySchema entry for `User` addresses the properties declared on User.
        const name = options.schemaNames?.get(current)
        for (const [property, schema] of Object.entries(kind.properties)) {
          out[property] = walk(
            schema, depth + 1, property, name, `${path}.${property}`
          )
        }
        return out
      }
      default:
        return null
    }
  }

  return walk(schema, 0)
}

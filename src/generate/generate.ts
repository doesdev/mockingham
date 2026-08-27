import type { Schema } from '../spec/types.ts'
import {
  classify, conditionalOf, matchesVariant, mergeAllOf, normalizeNode
} from '../schema/walk.ts'
import type { Conditional } from '../schema/walk.ts'
// Not a second interpretation: `compileSchema` is `classify` wearing zod, and
// it is the only thing in the project that can answer "does this value satisfy
// this schema". Asking it is what keeps the branch generation TOOK and the
// branch validation SEES the same branch. Pure - zod pulls in no Node API, so
// invariant 3 is untouched.
import { compileSchema } from '../schema/compile.ts'
import { canonicalKey } from '../schema/equal.ts'
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

    // `identity` and `origin` are the same idea reached from two directions: a
    // union's sibling base and a conditional's effective schema are both
    // derived copies that `schemaNames` would never match. Whichever one this
    // node arrived through, the component name is answered by the schema the
    // document actually declared.
    const origin = identity ?? current
    const conditional = conditionalOf(current)
    if (conditional !== undefined) {
      return branch(conditional, origin, depth, propertyName, containerName)
    }
    return shape(current, origin, depth, propertyName, containerName)
  }

  /**
   * Generates a value for a schema carrying `if`/`then`/`else`.
   *
   * Which branch to aim for is a seeded coin, so a conditional document still
   * produces both shapes across seeds rather than one forever. Merging `if`
   * into the `then` branch's effective schema is what makes that branch
   * reachable - but merging `else` in cannot make a value MISS `if`, since the
   * property `if` tests still draws from its own declared values. So the aim
   * is CHECKED against `if` and a miss falls through to the other branch,
   * whose effective schema the value was then generated against by
   * construction.
   *
   * The check runs through `compileSchema`, the same reading of `if` that
   * request validation uses - "did this take the then branch" is asked once,
   * in one place, by both halves.
   *
   * One level deep: the effective schema is generated through `shape`, which
   * does not re-enter here, so a conditional nested directly inside a `then`
   * is not applied. A conditional on a nested PROPERTY is, because properties
   * go back through `walk`.
   */
  function branch(
    conditional: Conditional,
    origin: Schema,
    depth: number,
    propertyName?: string,
    containerName?: string
  ): unknown {
    const takeThen = rng.bool()
    const when = compileSchema(conditional.when)

    const first = takeThen ? conditional.whenTrue : conditional.whenFalse
    const candidate = shape(first, origin, depth, propertyName, containerName)
    if (when.safeParse(candidate).success === takeThen) return candidate

    const second = takeThen ? conditional.whenFalse : conditional.whenTrue
    const retry = shape(second, origin, depth, propertyName, containerName)
    if (when.safeParse(retry).success !== takeThen) return retry

    // Neither aim landed: a document whose `if` can be neither hit nor missed
    // from the values it declares. Serving the first candidate is wrong on one
    // keyword; refusing to serve is wrong on every request (invariant 4's
    // reasoning - a schema we cannot fully satisfy is not an error).
    return candidate
  }

  /**
   * Everything below the conditional: the schema's own shape. `origin` is the
   * schema as the document declared it, kept separate because `current` may be
   * a merged effective schema a `schemaNames` lookup would never match.
   */
  function shape(
    current: Schema,
    origin: Schema,
    depth: number,
    propertyName?: string,
    containerName?: string
  ): unknown {
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
        // Named for the variant, not the conditional `branch()` above, which it
        // would otherwise shadow inside this block.
        const variant = chosen ?? rng.pick(kind.variants)
        if (base === undefined) return walk(variant, depth + 1)

        // With a sibling shape both constrain the same instance: generate the
        // declared object, then lay the chosen branch's own contribution over
        // it. `identity` keeps bySchema resolvers pointed at the component,
        // whose name the derived base is not registered under.
        const value = walk(base, depth, propertyName, containerName, current)
        // Only a branch with an object shape of its own can contribute. A
        // branch declaring only `required` - the usual "at least one of these"
        // idiom - now classifies as an object too, since a bare `required` is
        // an object constraint, and it correctly contributes nothing: it
        // declares no properties, and every property the base declares is
        // generated anyway.
        if (classify(variant).kind !== 'object') return value
        const extra = walk(variant, depth, propertyName, containerName)
        if (!isRecord(value)) return extra
        if (!isRecord(extra)) return value
        return { ...value, ...extra }
      }
      case 'array': {
        if (depth >= maxDepth) return []
        const { min, max } = arrayLength(merged)
        const count = rng.int(min, max)
        const items: unknown[] = []
        if (merged.uniqueItems === true) {
          // Drawn WITHOUT replacement. `seen` is only ever probed with `.has`
          // and never iterated, so no unordered traversal enters a generation
          // path (invariant 2) - the emitted order is `items`' own insertion
          // order, and the draws themselves come from the seeded rng, so the
          // result is byte-identical for a given seed.
          const seen = new Set<string>()
          // Bounded, so an item schema with fewer distinct values than `count`
          // - two enum members for a three-slot array - yields as many as it
          // can rather than looping forever.
          const attempts = count * 8 + 16
          for (let i = 0; i < attempts && items.length < count; i++) {
            const item = walk(kind.items, depth + 1, propertyName, containerName)
            const key = canonicalKey(item)
            if (seen.has(key)) continue
            seen.add(key)
            items.push(item)
          }
          return items
        }
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
        const name = options.schemaNames?.get(origin)
        for (const [property, node] of Object.entries(kind.properties)) {
          const child = normalizeNode(node)
          // `false` forbids the key outright - `else: { properties: { x:
          // false } }` is how a branch says "x must be absent" - so it is
          // omitted rather than emitted with some placeholder.
          if (child === 'never') continue
          out[property] = walk(child, depth + 1, property, name)
        }
        return out
      }
      default:
        return null
    }
  }

  return walk(schema, 0)
}

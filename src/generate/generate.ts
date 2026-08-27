import type { Schema } from '../spec/types.ts'
import {
  classify, conditionalOf, foldBranch, matchesVariant, mergeAllOf, negationOf,
  normalizeNode
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

/**
 * How many times generation redraws when the value it produced lands inside a
 * schema's `not` subschema.
 *
 * A bounded effort by design. Generation draws from what the schema DECLARES,
 * so a negation it can escape - one enum member forbidden of several, one
 * const forbidden of a range - is escaped within a draw or two, and one it
 * cannot escape (`{ const: 'x', not: { const: 'x' } }`, or a `not` over a
 * property no declared value can dodge) would never be escaped by any number
 * of redraws. Twelve clears the first kind and gives up quickly on the second,
 * which is served anyway rather than raised (invariant 4). Validation is exact
 * either way: a value inside the negation is a 400.
 */
const MAX_NEGATION_REDRAWS = 12

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
    identity?: Schema,
    /** The schema path of this node, for the truncation warning. */
    path = '$',
    /** See MAX_UNION_HOPS. Any non-union descent resets it by defaulting. */
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

    // `identity` and `origin` are the same idea reached from two directions: a
    // union's sibling base and a conditional's effective schema are both
    // derived copies that `schemaNames` would never match. Whichever one this
    // node arrived through, the component name is answered by the schema the
    // document actually declared.
    const origin = identity ?? current
    const conditional = conditionalOf(current)
    const produce = (): unknown =>
      conditional === undefined
        ? shape(
            current, origin, depth, propertyName, containerName, path, unionHops
          )
        : branch(
            conditional, origin, depth, propertyName, containerName, path,
            unionHops
          )

    // The overwhelmingly common case: no negation, and the bytes are exactly
    // what they were before `not` was read at all.
    const negation = negationOf(current)
    if (negation === undefined) return produce()

    // A bounded redraw, through the same compiled reading of `not` that
    // request validation uses - "does this value satisfy the negation" is
    // asked once, in one place, by both halves (invariant 1). Every redraw
    // draws from the seeded rng in sequence, so the result is byte-identical
    // for a given seed (invariant 2).
    const forbidden = compileSchema(negation)
    let candidate = produce()
    for (
      let attempt = 0;
      attempt < MAX_NEGATION_REDRAWS && forbidden.safeParse(candidate).success;
      attempt++
    ) {
      candidate = produce()
    }
    // Still inside the negation: a document whose `not` forbids the only
    // values it declares. Serving the candidate is wrong on one keyword;
    // refusing to serve is wrong on every request (invariant 4).
    return candidate
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
    containerName?: string,
    path = '$',
    unionHops = 0
  ): unknown {
    const takeThen = rng.bool()
    const when = compileSchema(conditional.when)

    // At the parent's own depth, for the same reason a union is: choosing a
    // branch says what this node IS, it does not descend into it. `shape` does
    // not re-enter here, so a conditional chain is bounded by construction and
    // needs no counterpart to MAX_UNION_HOPS.
    const first = takeThen ? conditional.whenTrue : conditional.whenFalse
    const candidate = shape(
      first, origin, depth, propertyName, containerName, path, unionHops
    )
    if (when.safeParse(candidate).success === takeThen) return candidate

    const second = takeThen ? conditional.whenFalse : conditional.whenTrue
    const retry = shape(
      second, origin, depth, propertyName, containerName, path, unionHops
    )
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
    containerName?: string,
    path = '$',
    unionHops = 0
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
        // Only a chain of bare unions can reach this - see MAX_UNION_HOPS.
        if (unionHops >= MAX_UNION_HOPS) return null
        // No `depth >= maxDepth` guard here at all, in either shape. Resolving
        // a union is a decision about what this node is, not a step down the
        // tree, so the chosen branch - or the sibling base - hits its own guard
        // and truncates in kind: `{}` for an object, `[]` for an array, and the
        // warning reported by whichever case actually truncated. The old guard
        // returned `null` where the document declared an object, which is a
        // harder failure for a consumer than an empty one.
        const base = kind.base
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
        // `depth`, NOT `depth + 1`: spending a level here made an otherwise
        // identical document truncate one level earlier whenever a union
        // appeared in it.
        // An ARRAY sibling shape cannot take the object path's overlay below:
        // there is nothing to spread one array over another with, and the
        // branches that make this idiom worth supporting (`anyOf: [{minItems:
        // 2}, {maxItems: 0}]`) declare bounds rather than content. So base and
        // branch are folded into one effective schema through `foldBranch`,
        // the same fold the compiler applies to an array base's branches - so
        // a bound generation honors here is a bound validation enforces there
        // (invariant 1) - and generated once.
        //
        // `depth`, NOT `depth + 1`, for the same reason the object path uses
        // `depth`: resolving a union is a decision about what this node is,
        // not a step down the tree. Spending a level here would truncate an
        // array-with-union one level earlier than the identical document
        // without one. `identity` keeps bySchema resolvers pointed at the
        // component, whose name the folded schema is not registered under.
        if (base !== undefined && classify(base).kind !== 'object') {
          return walk(
            foldBranch(base, variant),
            depth,
            propertyName,
            containerName,
            current,
            path,
            unionHops + 1
          )
        }

        if (base === undefined) {
          return walk(
            variant,
            depth,
            // Deliberately not forwarded, as before: a resolver already saw
            // this property name at the union node itself.
            undefined,
            undefined,
            undefined,
            path,
            unionHops + 1
          )
        }

        // With a sibling shape both constrain the same instance: generate the
        // declared object, then lay the chosen branch's own contribution over
        // it. `identity` keeps bySchema resolvers pointed at the component,
        // whose name the derived base is not registered under.
        const value = walk(
          base, depth, propertyName, containerName, current, path, unionHops + 1
        )
        // Only a branch with an object shape of its own can contribute. A
        // branch declaring only `required` - the usual "at least one of these"
        // idiom - now classifies as an object too, since a bare `required` is
        // an object constraint, and it correctly contributes nothing: it
        // declares no properties, and every property the base declares is
        // generated anyway.
        if (classify(variant).kind !== 'object') return value
        const extra = walk(
          variant,
          depth,
          propertyName,
          containerName,
          undefined,
          path,
          unionHops + 1
        )
        if (!isRecord(value)) return extra
        if (!isRecord(extra)) return value
        return { ...value, ...extra }
      }
      case 'array': {
        const { min, max } = arrayLength(merged)
        // A tuple position is the document saying that position exists, so the
        // generated array covers the whole tuple where `maxItems` allows it.
        // It stops there unless `items` says what a further position holds -
        // inventing unconstrained values past a tuple only produces nulls.
        const tupleLength = kind.prefix.length
        const open = !kind.closed && Object.keys(kind.items).length > 0
        const low =
          tupleLength > 0 ? Math.min(Math.max(min, tupleLength), max) : min
        const high = tupleLength > 0 && !open ? low : Math.max(low, max)
        if (depth >= maxDepth) {
          // `low`, not `min`: a tuple with no `minItems` still declares its
          // positions, so truncating one drops declared content and is worth
          // reporting exactly as a `minItems` array is.
          if (low > 0) options.onDepthExhausted?.(`${path}[]`)
          return []
        }
        const count = rng.int(low, high)
        // A tuple position gets its own path so two positions truncating are
        // two warnings rather than one - the handler dedupes by path, and
        // `[]` for every position would silence all but the first.
        const pathAt = (index: number): string =>
          index < tupleLength ? `${path}[${index}]` : `${path}[]`
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
            // Keyed on the position being FILLED, not the attempt number, so a
            // rejected duplicate redraws from the same tuple position rather
            // than sliding down the tuple.
            const position = items.length
            const at = kind.prefix[position] ?? kind.items
            const item = walk(
              at, depth + 1, propertyName, containerName, undefined,
              pathAt(position)
            )
            const key = canonicalKey(item)
            if (seen.has(key)) continue
            seen.add(key)
            items.push(item)
          }
          return items
        }
        for (let i = 0; i < count; i++) {
          const at = kind.prefix[i] ?? kind.items
          items.push(
            walk(
              at, depth + 1, propertyName, containerName, undefined, pathAt(i)
            )
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
        const name = options.schemaNames?.get(origin)
        for (const [property, node] of Object.entries(kind.properties)) {
          const child = normalizeNode(node)
          // `false` forbids the key outright - `else: { properties: { x:
          // false } }` is how a branch says "x must be absent" - so it is
          // omitted rather than emitted with some placeholder.
          if (child === 'never') continue
          out[property] = walk(
            child, depth + 1, property, name, undefined, `${path}.${property}`
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

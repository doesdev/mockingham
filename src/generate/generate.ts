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
    if (conditional !== undefined) {
      return branch(
        conditional, origin, depth, propertyName, containerName, path, unionHops
      )
    }
    return shape(
      current, origin, depth, propertyName, containerName, path, unionHops
    )
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
        const contains = kind.contains
        // How many members are drawn specifically to MATCH `contains`.
        //
        // `maxContains` wins when a document declares the pair crossed
        // (`minContains: 3, maxContains: 1`, which nothing can satisfy):
        // overshooting a declared ceiling puts members in the body the document
        // forbids outright, where falling short of the floor leaves it merely
        // incomplete. `minContains: 0` asks for nothing in particular, which is
        // what makes `contains` vacuous there.
        const wanted =
          contains === undefined
            ? 0
            : contains.max === undefined
              ? contains.min
              : Math.min(contains.min, contains.max)
        // A closed tuple has no position past its own to put a contains member
        // in, so its floor stays at the tuple length and a tuple position
        // carries the member instead - see `schemaAt`.
        const floor = kind.closed ? tupleLength : tupleLength + wanted
        const low = floor > 0 ? Math.min(Math.max(min, floor), max) : min
        // `maxContains` also pins the length: every extra member drawn from
        // `items` is another chance to match `contains` incidentally, and the
        // shortest array that still clears `minContains` is the one least
        // likely to overshoot the ceiling.
        const high =
          (tupleLength > 0 && !open) || contains?.max !== undefined
            ? low
            : Math.max(low, max)
        if (depth >= maxDepth) {
          // `low`, not `min`: a tuple with no `minItems` still declares its
          // positions, and a `contains` floor still declares members, so
          // truncating either drops declared content and is worth reporting
          // exactly as a `minItems` array is.
          if (low > 0) options.onDepthExhausted?.(`${path}[]`)
          return []
        }
        const count = rng.int(low, high)
        // A tuple position gets its own path so two positions truncating are
        // two warnings rather than one - the handler dedupes by path, and
        // `[]` for every position would silence all but the first.
        const pathAt = (index: number): string =>
          index < tupleLength ? `${path}[${index}]` : `${path}[]`
        // The positions drawn to match `contains`: the LAST `wanted` of them.
        // Taking them from the end puts every carrier past the tuple whenever
        // the array reaches that far - which `floor` arranges unless the tuple
        // is closed or `maxItems` leaves no room - so a declared tuple position
        // is only ever pressed into service when nothing else can be.
        const carrierFrom = wanted > 0 ? count - wanted : count
        // Merged once per array, not once per member: `mergeAllOf` returns a
        // fresh object, and a new identity on every draw would defeat the
        // compiler's identity cache and `conditionalOf`'s. Probed by key and
        // never iterated, so no unordered traversal enters a generation path.
        const carriers = new Map<Schema, Schema>()
        const baseAt = (index: number): Schema => kind.prefix[index] ?? kind.items
        const schemaAt = (index: number): Schema => {
          const base = baseAt(index)
          if (contains === undefined || index < carrierFrom) return base
          const member = normalizeNode(contains.schema)
          // `contains: false` is satisfied by no member at all. Serving the
          // position's own schema is wrong on one keyword; refusing to serve is
          // wrong on every request - invariant 4's reasoning, that a schema we
          // cannot fully satisfy is not an error.
          if (member === 'never') return base
          const cached = carriers.get(base)
          if (cached) return cached
          // Both constrain the same member and so both must hold: a contains
          // member still has to satisfy `items`, or its tuple position. Folded
          // by the same `allOf` merge every other composition goes through.
          const both = mergeAllOf({ allOf: [base, member] })
          carriers.set(base, both)
          return both
        }
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
          // Positions whose `contains` draw collided with a member already in
          // the array. A collision means an identical member is ALREADY there,
          // and an identical member matches `contains` by construction - so the
          // count is met without this position, and redrawing the carrier
          // schema forever (a `contains` with one possible value would do
          // exactly that) would only cost the array its length. Probed with
          // `.has`, never iterated.
          const met = new Set<number>()
          for (let i = 0; i < attempts && items.length < count; i++) {
            // Keyed on the position being FILLED, not the attempt number, so a
            // rejected duplicate redraws from the same tuple position rather
            // than sliding down the tuple.
            const position = items.length
            const at = met.has(position) ? baseAt(position) : schemaAt(position)
            const item = walk(
              at, depth + 1, propertyName, containerName, undefined,
              pathAt(position)
            )
            const key = canonicalKey(item)
            if (seen.has(key)) {
              met.add(position)
              continue
            }
            seen.add(key)
            items.push(item)
          }
          return items
        }
        for (let i = 0; i < count; i++) {
          const at = schemaAt(i)
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

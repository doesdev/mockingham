import { classify, matchesVariant } from '../schema/walk.ts'
import type { Schema } from '../spec/types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Combines two claims over the same node. Reached only from the union branch,
 * where a sibling base and a variant both describe the one instance, so both
 * their claims belong in the narrowed result.
 *
 * Keys are emitted in sorted order for the same reason the object branch sorts
 * them: the narrowed value is serialized to disk and must be byte-identical
 * across processes (invariant 2). A non-record on either side is a whole-node
 * claim or a scalar, which cannot be merged - the earlier claim stands.
 */
function mergeClaims(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return left
  const keys = Object.keys(left)
    .concat(Object.keys(right).filter((key) => !(key in left)))
    .sort()
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    out[key] =
      key in left && key in right
        ? mergeClaims(left[key], right[key])
        : key in left
          ? left[key]
          : right[key]
  }
  return out
}

export interface ScopeConfig {
  byName?: string[]
  bySchema?: string[]
}

export function isScoped(config?: ScopeConfig): boolean {
  return (config?.byName?.length ?? 0) > 0 || (config?.bySchema?.length ?? 0) > 0
}

/**
 * Reduces a full value to only the parts the scope config claims, so a scoped
 * fixture stores prose and nothing else and the rest stays seeded and fast.
 *
 * Walks THROUGH `classify()` - the same reading generation and compilation use.
 * A second interpretation of a schema here is the worst bug class in this
 * project, and "what we asked the model for" diverging from "what we generate"
 * is exactly that bug wearing a different hat.
 *
 * Returns `undefined` when nothing is in scope, which the caller reads as
 * "no fixture" rather than "an empty fixture".
 */
export function narrow(
  value: unknown,
  schema: Schema,
  config: ScopeConfig,
  schemaNames: Map<Schema, string>
): unknown {
  const names = new Set(config.byName ?? [])
  const schemas = new Set(config.bySchema ?? [])

  const walk = (node: unknown, current: Schema, seen: Set<Schema>): unknown => {
    // A named schema in scope claims its whole subtree, checked before
    // recursing so `bySchema: ['Address']` keeps every field of an Address.
    // Looked up BEFORE classify() so this checks the original schema
    // identity, not a merged allOf copy classify() may have produced.
    const name = schemaNames.get(current)
    if (name !== undefined && schemas.has(name)) return node

    // Recursion guard. A recursive schema is excluded from the content path
    // anyway, but narrow() is also called on generated values during bake and
    // must not spin.
    if (seen.has(current)) return undefined
    const nested = new Set(seen)
    nested.add(current)

    const kind = classify(current)

    if (kind.kind === 'array') {
      if (!Array.isArray(node)) return undefined
      // Index-keyed object, not a literal array. `overlay()` in
      // `src/resolve/layer.ts` only merges an override into a base array
      // per index when the override node is a plain object keyed by index
      // (or '*') - a literal array override replaces the base wholesale. An
      // omitted index means "nothing in scope here", which overlay() then
      // reads as "leave the generated item at this index alone" rather than
      // blanking it.
      const out: Record<string, unknown> = {}
      let kept = false
      // Iterated in ascending index order (the array's own order) so the
      // narrowed object serializes identically across processes.
      node.forEach((item, index) => {
        // `prefix[index] ?? items` - the same positional reading generation
        // (generate.ts) and coercion (runtime/validate.ts) use, so a tuple is
        // narrowed against the schema that actually governs that position. A
        // position past a CLOSED tuple lands on `items`, which classify()
        // reports as `{}` in that case and so claims nothing - the document
        // says no such position exists.
        const narrowed = walk(item, kind.prefix[index] ?? kind.items, nested)
        if (narrowed !== undefined) {
          out[String(index)] = narrowed
          kept = true
        }
      })
      return kept ? out : undefined
    }

    if (kind.kind === 'object') {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        return undefined
      }
      const source = node as Record<string, unknown>
      const out: Record<string, unknown> = {}
      let kept = false
      // Sorted so the narrowed object serializes identically across processes.
      for (const property of Object.keys(kind.properties).sort()) {
        if (!(property in source)) continue
        const child = kind.properties[property] as Schema
        if (names.has(property)) {
          out[property] = source[property]
          kept = true
          continue
        }
        const narrowed = walk(source[property], child, nested)
        if (narrowed !== undefined) {
          out[property] = narrowed
          kept = true
        }
      }
      return kept ? out : undefined
    }

    if (kind.kind === 'union') {
      // A union is a decision about what this node IS, not a step down the
      // tree, so its branches are narrowed at `current`'s own level and their
      // claims combined - the same reading generation uses when it lays a
      // chosen branch's contribution over the sibling base.
      //
      // The base comes first because it is unconditional: a shape declared
      // BESIDE a oneOf/anyOf constrains the same instance as the branch does,
      // so a scoped field living on the base is in scope whichever branch the
      // value took.
      const candidates: Schema[] = kind.base === undefined ? [] : [kind.base]
      // With a formal discriminator the value names its own branch, so only
      // that branch is consulted. Without one there is no in-scope way to ask
      // which branch a value took - narrow() has no compiler and building one
      // here would be a second interpretation - so every branch is offered the
      // value and only what it actually finds there is kept. Order is the
      // document's declaration order, which is deterministic.
      const tag =
        kind.discriminator !== undefined && isRecord(node)
          ? node[kind.discriminator]
          : undefined
      const named =
        typeof tag === 'string' || typeof tag === 'number' || typeof tag === 'boolean'
          ? kind.variants.filter((variant) =>
              matchesVariant(variant, kind.discriminator, String(tag))
            )
          : []
      // An unmatched or absent discriminator value falls back to offering the
      // value to every branch, the way generation falls back to its seeded
      // pick rather than failing on a name no branch answers to.
      candidates.push(...(named.length > 0 ? named : kind.variants))

      let claim: unknown
      for (const candidate of candidates) {
        const narrowed = walk(node, candidate, nested)
        if (narrowed === undefined) continue
        // A bySchema hit on a branch claims the whole node; nothing a later
        // branch could add is not already inside it.
        if (narrowed === node) return node
        claim = claim === undefined ? narrowed : mergeClaims(claim, narrowed)
      }
      return claim
    }

    return undefined
  }

  return walk(value, schema, new Set())
}

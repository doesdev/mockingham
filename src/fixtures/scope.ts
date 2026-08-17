import { classify } from '../schema/walk.ts'
import type { Schema } from '../spec/types.ts'

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
        const narrowed = walk(item, kind.items, nested)
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

    return undefined
  }

  return walk(value, schema, new Set())
}

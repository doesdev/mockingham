import type { OverrideNode } from '../runtime/types.ts'
import { markCallback } from '../runtime/errors.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Pass one. Builds the result tree, calling override functions as it goes and
 * leaving whatever they return - including promises - in place.
 *
 * Containers are always freshly built, never mutated, so a spec `example`
 * object reachable from the generated tree is never written through.
 */
function overlay(base: unknown, node: OverrideNode, ctx: unknown): unknown {
  if (node === undefined) return base
  if (typeof node === 'function') {
    try {
      return (node as (context: unknown) => unknown)(ctx)
    } catch (error) {
      // Tagged so the boundary catch can tell a user's throw from our own bug.
      throw markCallback(error)
    }
  }

  if (isPlainObject(node)) {
    if (Array.isArray(base)) {
      const wildcard = node['*']
      return base.map((item, index) => {
        const byIndex = node[String(index)]
        const chosen = byIndex !== undefined ? byIndex : wildcard
        return chosen === undefined ? item : overlay(item, chosen, ctx)
      })
    }

    const source = isPlainObject(base) ? base : {}
    // '*' addresses every key the base already has, mirroring how it addresses
    // every index of an array. An explicit key beats it, exactly as a numeric
    // index beats it for arrays.
    const wildcard = node['*']
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      const byKey = node[key]
      const chosen = byKey !== undefined ? byKey : wildcard
      out[key] = chosen === undefined ? value : overlay(value, chosen, ctx)
    }
    // Keys the override adds are appended in declaration order, so the result
    // is deterministic. '*' is never one of them - it selects existing keys and
    // must never surface as a literal property.
    for (const [key, value] of Object.entries(node)) {
      if (key === '*') continue
      if (key in out) continue
      out[key] = overlay(undefined, value, ctx)
    }
    return out
  }

  return node
}

interface Slot {
  promise: Promise<unknown>
  assign(value: unknown): void
}

/**
 * Pass two. Collects every pending leaf and awaits them in one batch, so fifty
 * async overrides cost one tick rather than fifty.
 *
 * The loop repeats because a promise may resolve to a value containing further
 * promises. Each nesting level costs one additional batch, not one per leaf.
 *
 * `scan` mutates in place whatever container it is handed - including
 * containers `overlay` did not build itself (an untouched subtree is `base`
 * returned by reference, per `node === undefined` above). That is safe today
 * only because a live value can never reach a `Schema.example`: `src/generate/
 * generate.ts` returns `current.example` BY REFERENCE into the generated
 * tree, but `resolveDocument`'s `walk()` in `src/spec/refs.ts` rebuilds every
 * object node via `Object.entries()` when loading the document, and a
 * `Promise` has no own enumerable properties - so nothing a resolver or
 * override writes can ever end up embedded in a schema's `example` by the
 * time it reaches this function. If `refs.ts` ever stops rebuilding every
 * node on load (e.g. an optimization that passes `example` through
 * unchanged), this mutation would start corrupting the loaded document in
 * place, and the corruption would be silent - it would only show up on the
 * SECOND request that reuses the same schema.
 */
async function settle(root: unknown): Promise<unknown> {
  let result = root

  for (;;) {
    const slots: Slot[] = []

    const scan = (value: unknown, assign: (settled: unknown) => void): void => {
      if (value instanceof Promise) {
        slots.push({ promise: value, assign })
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          scan(item, (settled) => {
            value[index] = settled
          })
        })
        return
      }
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        for (const key of Object.keys(record)) {
          scan(record[key], (settled) => {
            record[key] = settled
          })
        }
      }
    }

    scan(result, (settled) => {
      result = settled
    })

    if (slots.length === 0) return result
    let settled: unknown[]
    try {
      settled = await Promise.all(slots.map((slot) => slot.promise))
    } catch (error) {
      throw markCallback(error)
    }
    slots.forEach((slot, index) => slot.assign(settled[index]))
  }
}

export async function applyOverrides(
  generated: unknown,
  override: OverrideNode | undefined,
  ctx: unknown
): Promise<unknown> {
  return settle(overlay(generated, override, ctx))
}

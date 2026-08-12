import type { OverrideNode } from '../runtime/types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Pass one. Builds the result tree, calling override functions as it goes and
 * leaving whatever they return — including promises — in place.
 *
 * Containers are always freshly built, never mutated, so a spec `example`
 * object reachable from the generated tree is never written through.
 */
function overlay(base: unknown, node: OverrideNode, ctx: unknown): unknown {
  if (node === undefined) return base
  if (typeof node === 'function') {
    return (node as (context: unknown) => unknown)(ctx)
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
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = key in node ? overlay(value, node[key], ctx) : value
    }
    // Keys the override adds are appended in declaration order, so the result
    // is deterministic.
    for (const [key, value] of Object.entries(node)) {
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
    const settled = await Promise.all(slots.map((slot) => slot.promise))
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

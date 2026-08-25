import type { Operation } from '../spec/types.ts'
import { resolveTarget } from '../resolve/target.ts'
import type { Store } from './store.ts'

/**
 * Response linking: a recall table, not a CRUD engine.
 *
 * A write records its generated response against a key it minted; a read whose
 * key matches replays those recorded bytes; a miss falls through to ordinary
 * generation. That is the entire feature — no mutation, no partial update, no
 * lifecycle, no delete semantics, no list endpoint reflecting what was created.
 * The master spec's non-goals list "stateful CRUD persistence" and this does
 * not become one: the only claim is that an identifier the mock itself minted
 * resolves to the thing it minted it for. See the refinements design §4.1.
 *
 * Determinism, per design §4.5: invariant 2 is refined to SEQUENCE
 * determinism. Recall makes a `GET` depend on whether a `POST` ran earlier,
 * which is the same shape as request ordinals, the webhook counter,
 * idempotency replay, and `failNext` — every one of those already makes a
 * response depend on what came before it. Replaying an identical sequence
 * against a fresh process with the same seed still produces identical bytes.
 */

export interface LinkRule {
  from: { target: string; key: string }
  to: { target: string; key: string }
  /**
   * Defaults to the whole response body. `resolveExpression` funnels body
   * values through a scalar coercion, so the whole-body forms are special-cased
   * by the capture pass rather than resolved — design §4.2.
   */
  remember?: string
  ttlMs?: number
  max?: number
}

/** The bounds the table itself needs. Everything else is the handler's. */
export interface ResolvedLinkRule {
  ttlMs: number
  max: number
}

export interface LinkTable {
  record(index: number, key: string, value: unknown): Promise<void>
  recall(index: number, key: string): Promise<unknown | undefined>
  /**
   * Drops the eviction index. `reset()` clears the Store, which drops the
   * values; without this the index would keep phantom keys and the next
   * recorded entry could evict a live one to stay under `max`.
   */
  clear(): void
}

/** One hour. */
export const LINK_TTL_MS = 3_600_000

/**
 * Matching `MAX_DELIVERIES`'s precedent as a documented constant rather than an
 * open-ended knob. A recall table is unbounded by construction — every POST
 * mints a new id and adds an entry — so both bounds are required, not optional.
 * Without them a long-lived mock leaks until the process dies, which is
 * invisible in a test suite and obvious in production.
 */
export const LINK_MAX = 1000

export const REMEMBER_RESPONSE_BODY = '{$response.body}'
export const REMEMBER_REQUEST_BODY = '{$request.body}'

export function linkKey(index: number, key: string): string {
  return `link|${index}|${key}`
}

/**
 * A deep copy on the way out. The recalled value is layered on by the override
 * machinery, whose second pass mutates containers in place to settle promises —
 * handing out the stored reference would let one request's rendering rewrite
 * what every later recall replays. Link values are parsed JSON by construction,
 * so a structured clone is total over them.
 */
function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}

export function createLinkTable(store: Store, rules: ResolvedLinkRule[]): LinkTable {
  // The Store has no enumeration primitive, so eviction order is tracked here,
  // the same wall `createDeliveryLog` hit. Insertion-ordered arrays rather than
  // a Set iteration feeding anything observable — determinism forbids the
  // latter. Process-local, like the delivery log's index.
  const order: string[][] = rules.map(() => [])

  return {
    async record(index, key, value) {
      const rule = rules[index]
      if (rule === undefined) return
      const keys = order[index] ?? []
      const storeKey = linkKey(index, key)
      await store.set(storeKey, value, rule.ttlMs)
      if (!keys.includes(key)) keys.push(key)
      while (keys.length > rule.max) {
        const oldest = keys.shift()
        if (oldest !== undefined) await store.delete(linkKey(index, oldest))
      }
    },

    async recall(index, key) {
      if (rules[index] === undefined) return undefined
      return copy(await store.get(linkKey(index, key)))
    },

    clear() {
      for (const keys of order) keys.length = 0
    }
  }
}

/** A link rule with its targets resolved and its bounds defaulted. */
export interface CompiledLinkRule {
  index: number
  from: Operation[]
  fromKey: string
  to: Operation[]
  toKey: string
  remember: string
  ttlMs: number
  max: number
}

/**
 * Targets are resolved at construction, so a typo throws rather than silently
 * never linking — the same contract every other control-plane target in the
 * system has.
 */
export function compileLinkRules(
  rules: LinkRule[] | undefined,
  operations: Operation[]
): CompiledLinkRule[] {
  return (rules ?? []).map((rule, index) => ({
    index,
    from: resolveTarget(rule.from.target, operations),
    fromKey: rule.from.key,
    to: resolveTarget(rule.to.target, operations),
    toKey: rule.to.key,
    remember: rule.remember ?? REMEMBER_RESPONSE_BODY,
    ttlMs: rule.ttlMs ?? LINK_TTL_MS,
    max: rule.max ?? LINK_MAX
  }))
}

import type { Store } from '../runtime/store.ts'

/**
 * The cross-operation webhook destination registry — refinements design §3.
 *
 * A destination registered by one operation is read back by an emission that
 * shares no request context with it. That is the whole point: the captured
 * callback tier can only carry a URL that arrived on the triggering request,
 * and a document with a `PUT /subscriptions/{name}` control plane has no such
 * request at emission time.
 *
 * No `node:` imports: the handler reaches this, and the core is pure.
 */

export interface Registration {
  webhook: string
  url: string
  scope: string
}

/**
 * Exported for the same reason `callbackKey` is: the capture pass WRITES the
 * key an emission READS, and two independent spellings of one convention drift
 * silently with both test suites green in isolation.
 */
export function registrationKey(webhook: string, scope: string): string {
  return `registration|${webhook}|${scope}`
}

export interface Registry {
  register(webhook: string, url: string, scope?: string): Promise<void>
  unregister(webhook: string, scope?: string): Promise<void>
  lookup(webhook: string, scope: string): Promise<string | undefined>
  /** Sorted by webhook, then scope. */
  all(webhook?: string): Promise<Registration[]>
}

/**
 * The Store holds the authoritative value; an in-process index holds the known
 * keys so they can be enumerated at all. `Store` has no enumeration primitive
 * (`runtime/store.ts`), which is the same wall `createDeliveryLog` hit and
 * solved the same way. The consequence is documented in design §13.1: with a
 * shared Store, a registration written by another process is not enumerated
 * here, though a value written there IS reflected, because `all()` reads every
 * key back through the Store rather than trusting a local copy.
 *
 * `all()` SORTS. Invariant 2 forbids letting an unordered iteration decide
 * anything observable, and this method is observable through `mock.registrations()`
 * and through the MCP read tool.
 */
export function createRegistry(store: Store): Registry {
  // Map rather than Set: recovering the webhook and scope by splitting the key
  // would be wrong for any name containing the separator.
  const index = new Map<string, { webhook: string; scope: string }>()

  return {
    async register(webhook, url, scope = '') {
      const key = registrationKey(webhook, scope)
      index.set(key, { webhook, scope })
      await store.set(key, url)
    },

    async unregister(webhook, scope = '') {
      const key = registrationKey(webhook, scope)
      index.delete(key)
      await store.delete(key)
    },

    async lookup(webhook, scope) {
      const value = await store.get(registrationKey(webhook, scope))
      return typeof value === 'string' ? value : undefined
    },

    async all(webhook) {
      const found: Registration[] = []
      for (const [key, entry] of index) {
        const value = await store.get(key)
        if (typeof value !== 'string') {
          // The Store no longer holds it — `reset()` clears the Store without
          // going through this module, and an entry can expire. Drop the key
          // rather than letting the index resurrect a dead registration.
          index.delete(key)
          continue
        }
        if (webhook !== undefined && entry.webhook !== webhook) continue
        found.push({ webhook: entry.webhook, url: value, scope: entry.scope })
      }
      return found.sort((a, b) =>
        a.webhook === b.webhook
          ? (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)
          : (a.webhook < b.webhook ? -1 : 1)
      )
    }
  }
}

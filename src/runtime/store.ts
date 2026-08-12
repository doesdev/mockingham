export interface Store {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  incr(key: string, by?: number): Promise<number>
  clear(): Promise<void>
}

interface Entry {
  value: unknown
  expiresAt?: number
}

/**
 * The in-process `Store`.
 *
 * `now` is injected because determinism forbids scattering wall-clock reads
 * through the runtime — tests drive expiry with a fake clock rather than by
 * waiting. The default is a FUNCTION called fresh on every operation; the
 * invariant is that this parameter is the only `Date.now()` call site in the
 * runtime, not that it is read once. Snapshotting it at construction would
 * freeze the clock and disable expiry altogether.
 *
 * Expiry is lazy: an entry is dropped when read after its deadline, not on a
 * timer. That keeps the store free of scheduling and of `node:` imports.
 */
export function createMemoryStore(now: () => number = () => Date.now()): Store {
  const entries = new Map<string, Entry>()

  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && now() > entry.expiresAt) {
      entries.delete(key)
      return undefined
    }
    return entry
  }

  return {
    async get(key) {
      return live(key)?.value
    },

    async set(key, value, ttlMs) {
      entries.set(key, {
        value,
        expiresAt: ttlMs === undefined ? undefined : now() + ttlMs
      })
    },

    async delete(key) {
      entries.delete(key)
    },

    async incr(key, by = 1) {
      const current = live(key)?.value
      // A non-numeric or expired value restarts the counter rather than
      // producing NaN, which would poison every later increment.
      const base = typeof current === 'number' ? current : 0
      const next = base + by
      const existing = entries.get(key)
      // If the entry was live, preserve its deadline; if expired or absent,
      // produce an entry with no deadline, because incr has no way to re-arm one.
      // A caller wanting a decaying counter must set() it with a TTL rather than
      // relying on incr alone.
      entries.set(key, { value: next, expiresAt: existing?.expiresAt })
      return next
    },

    async clear() {
      entries.clear()
    }
  }
}

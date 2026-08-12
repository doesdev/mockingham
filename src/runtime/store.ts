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
 * `now` is injected because determinism forbids reading the clock inside the
 * runtime — tests drive expiry with a fake clock rather than by waiting. The
 * default reads `Date.now` once, at construction, which is the single boundary
 * where that is allowed.
 *
 * Expiry is lazy: an entry is dropped when it is read after its deadline, not on
 * a timer. That keeps the store free of scheduling and of `node:` imports.
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
      entries.set(key, { value: next, expiresAt: existing?.expiresAt })
      return next
    },

    async clear() {
      entries.clear()
    }
  }
}

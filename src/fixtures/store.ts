export interface FixtureMeta {
  /** The provider that produced it: 'openai-compatible', 'anthropic', 'recorded'. */
  source?: string
  model?: string
  /** Detects drift when the document changes. Absent on hand-written fixtures. */
  schemaHash?: string
  promptVersion?: number
  generatedAt?: string
  /**
   * Set by `bake()` when the stored value was narrowed by a scope config —
   * `narrow()` in `scope.ts` — so `resolve()`'s `shape()` can tell a whole
   * body from a layer by reading the ENTRY rather than the ambient llm.scope
   * config at serve time. Ambient config is the wrong source of truth: a
   * fixture baked with a scope can later be served under a config with no
   * scope at all (the design's mode table allows it), and reading ambient
   * config there would misread the narrowed, index-keyed partial value as a
   * whole body. Absent (never `false`) on a hand-written or unscoped-baked
   * fixture, which is what keeps the whole-body default for those.
   */
  scoped?: boolean
}

export interface FixtureEntry {
  value: unknown
  /**
   * Absent on a hand-written fixture, which is why it is optional. A fixture
   * with no meta is never reported stale — design section 2.13.
   */
  meta?: FixtureMeta
}

export interface FixtureRecord {
  operationId: string
  status: number
  key: string
  entry: FixtureEntry
}

export interface FixtureStore {
  get(operationId: string, status: number, key: string): FixtureEntry | undefined
  set(operationId: string, status: number, key: string, entry: FixtureEntry): void
  /** Sorted, so persistence writes byte-identical files across processes. */
  records(): FixtureRecord[]
  clear(): void
}

function id(operationId: string, status: number, key: string): string {
  return JSON.stringify([operationId, status, key])
}

export function createMemoryFixtureStore(): FixtureStore {
  const entries = new Map<string, FixtureRecord>()

  return {
    get: (operationId, status, key) =>
      entries.get(id(operationId, status, key))?.entry,

    set(operationId, status, key, entry) {
      entries.set(id(operationId, status, key), { operationId, status, key, entry })
    },

    // An explicit ordinal comparator, not localeCompare: collation with no
    // locale argument varies with the process ICU environment, and these
    // records are written to disk as a committed, diffable artifact. Status is
    // compared numerically so ordering never depends on digit width.
    records: () =>
      [...entries.values()].sort((a, b) => {
        if (a.operationId !== b.operationId) {
          return a.operationId < b.operationId ? -1 : 1
        }
        if (a.status !== b.status) return a.status - b.status
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      }),

    clear: () => entries.clear()
  }
}

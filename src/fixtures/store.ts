export interface FixtureMeta {
  /** The provider that produced it: 'openai-compatible', 'anthropic', 'recorded'. */
  source?: string
  model?: string
  /** Detects drift when the document changes. Absent on hand-written fixtures. */
  schemaHash?: string
  promptVersion?: number
  generatedAt?: string
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
  return `${operationId}|${status}|${key}`
}

export function createMemoryFixtureStore(): FixtureStore {
  const entries = new Map<string, FixtureRecord>()

  return {
    get: (operationId, status, key) =>
      entries.get(id(operationId, status, key))?.entry,

    set(operationId, status, key, entry) {
      entries.set(id(operationId, status, key), { operationId, status, key, entry })
    },

    // Sorted rather than insertion-ordered. Insertion order depends on the order
    // requests arrived, which would make the file on disk differ between two
    // runs that produced identical content — against the determinism invariant
    // in the one place it reaches a committed artifact.
    records: () =>
      [...entries.values()].sort((a, b) =>
        id(a.operationId, a.status, a.key).localeCompare(
          id(b.operationId, b.status, b.key)
        )
      ),

    clear: () => entries.clear()
  }
}

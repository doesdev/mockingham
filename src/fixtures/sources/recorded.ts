import type { ContentSource, FixtureRequest, FixtureResult } from '../source.ts'

export interface RecordedEntry {
  operationId: string
  status: number
  value: unknown
  /** When set, matches only that request. Otherwise matches any request. */
  key?: string
}

/**
 * Answers from responses recorded upstream. No network, no dependency - this
 * source only ever reads what it was handed.
 */
export function createRecordedSource(entries: RecordedEntry[]): ContentSource {
  const answer = (request: FixtureRequest): FixtureResult | null => {
    const matches = entries.filter(
      (entry) => entry.operationId === request.operationId && entry.status === request.status
    )
    // A key-specific entry wins over a general one, so a recording can pin one
    // request without losing the fallback for the rest. Checking the
    // key-specific match first is load-bearing: if a general entry were
    // checked first it would shadow every specific one whenever both exist
    // for the same operation and status.
    const chosen =
      matches.find((entry) => entry.key === request.key) ??
      matches.find((entry) => entry.key === undefined)
    if (!chosen) return null

    // Validated like every other source. A recording taken before the
    // document changed is a miss, not an off-contract body.
    const checked = request.zodSchema.safeParse(chosen.value)
    if (!checked.success) return null
    return { value: checked.data, meta: { source: 'recorded' } }
  }

  return {
    async generate(reqs) {
      return reqs.map(answer)
    }
  }
}

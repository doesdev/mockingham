import { createRng } from '../generate/rng.ts'

export type DeliveryOutcome = 'delivered' | 'failed' | 'captured' | 'unresolved'

/**
 * One outbound attempt's record. `emit()` resolves with this rather than
 * rejecting in every case, including `unresolved` and an exhausted retry —
 * master spec §13's "an emit never hard-fails" is a property of the return
 * type, not merely of the implementation.
 */
export interface Delivery {
  webhook: string
  /** Absent when nothing resolved a destination. */
  url?: string
  /** The serialized payload, exactly as sent and as signed. */
  body: string
  headers: Record<string, string>
  outcome: DeliveryOutcome
  /** Absent for `unresolved`, `captured`, and a network-level failure. */
  status?: number
  attempts: number
  error?: string
}

export interface RetryConfig {
  attempts?: number
  /** Only `'exponential'`; §13 names no other strategy. */
  backoff?: 'exponential'
  baseMs?: number
  maxDelayMs?: number
}

export interface ResolvedRetry {
  attempts: number
  baseMs: number
  maxDelayMs: number
}

export function resolveRetry(config: RetryConfig = {}): ResolvedRetry {
  return {
    attempts: config.attempts ?? 3,
    // §13's retry block never names a base delay, which would leave the
    // doubling sequence undefined. See the webhooks design §2.2.
    baseMs: config.baseMs ?? 250,
    maxDelayMs: config.maxDelayMs ?? 10_000
  }
}

/**
 * Design §2.5, stated precisely because §13's two sentences narrow each other
 * and admit two implementations: retry a 5xx, a 408, and a 429; do not retry
 * any other 4xx or any 2xx. A 3xx never reaches here — `fetch` follows
 * redirects itself.
 */
export function shouldRetry(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

/**
 * Seeded jitter, keyed by webhook and attempt — design §2.2. Invariant 2
 * forbids `Math.random()`, and keying by attempt rather than advancing one
 * stream means a delivery's delays do not depend on how many other deliveries
 * came first. That is what keeps a run replayable and a failing test
 * reproducible.
 */
export function backoffFor(input: {
  seed: string
  webhook: string
  attempt: number
  retry: ResolvedRetry
}): number {
  const rng = createRng(`${input.seed}|webhook|${input.webhook}|${input.attempt}`)
  const base = Math.min(input.retry.baseMs * 2 ** input.attempt, input.retry.maxDelayMs)
  return Math.round(base * (0.5 + rng.next() * 0.5))
}

export interface DeliverInput {
  webhook: string
  url?: string
  body: string
  headers: Record<string, string>
  captureOnly: boolean
  retry: ResolvedRetry
  seed: string
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}

export async function deliver(input: DeliverInput): Promise<Delivery> {
  const record: Delivery = {
    webhook: input.webhook,
    url: input.url,
    body: input.body,
    headers: input.headers,
    outcome: 'unresolved',
    attempts: 0
  }

  // captureOnly wins over an unresolved destination: nothing is ever sent in
  // capture mode regardless of whether a url was found, so recording it as
  // 'captured' rather than 'unresolved' is what makes capture mode fully
  // testable with no receiver AND no subscription/config wired up yet.
  if (input.captureOnly) return { ...record, outcome: 'captured' }
  if (input.url === undefined) return record

  let lastError: string | undefined
  let lastStatus: number | undefined

  for (let attempt = 0; attempt < input.retry.attempts; attempt++) {
    record.attempts = attempt + 1
    let status: number | undefined
    try {
      const response = await input.fetch(input.url, {
        method: 'POST',
        headers: input.headers,
        body: input.body
      })
      status = response.status
      lastStatus = status
      lastError = undefined
      if (response.ok) {
        return { ...record, outcome: 'delivered', status }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastStatus = undefined
    }

    const retryable = status === undefined || shouldRetry(status)
    const remaining = attempt < input.retry.attempts - 1
    if (!retryable || !remaining) break
    await input.sleep(backoffFor({ ...input, attempt }))
  }

  return { ...record, outcome: 'failed', status: lastStatus, error: lastError }
}

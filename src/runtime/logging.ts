import { fnv1a } from '../generate/rng.ts'
import type { Ctx, Decisions } from './types.ts'

/**
 * `hash(requestKey, ordinal)` rather than a random id.
 *
 * A random id would be the obvious choice and is wrong here: `requestId` is the
 * natural value to echo on a response header for correlation, and the moment it
 * does, a random id breaks the determinism invariant. Hashing request identity
 * plus an ordinal gives an id that is stable across processes and still distinct
 * across repeated identical calls.
 *
 * The ordinal MUST come from its own counter, not the chaos counter — the
 * failure stage increments that one per policy evaluation, and sharing it would
 * shift every subsequent chaos roll the moment logging was switched on. See the
 * phases 7-9 design §2.2.
 *
 * Two hashes, because one fnv1a is 32 bits and 8 hex characters collide often
 * enough to be annoying in a log search.
 */
export function requestIdFor(requestKey: string, ordinal: number): string {
  const head = fnv1a(`${requestKey}|${ordinal}`).toString(16).padStart(8, '0')
  const tail = fnv1a(`${requestKey}|${ordinal}|mockingham`).toString(16).padStart(8, '0')
  return `${head}${tail}`
}

/**
 * Master spec §12, shaped for direct mapping onto Datadog/OTel-style sinks:
 * low-cardinality fields (`route`, `status`, `operationId`) are safe as tags,
 * high-cardinality ones (`path`, `params`, `query`, `requestId`) are not.
 *
 * `ts` and `durationMs` come from the injected clock. They sit outside the
 * determinism invariant because a log record is an observational side channel
 * that never enters a response — see the phases 7-9 design §2.1.
 */
export interface LogRecord {
  ts: number
  durationMs: number
  requestId: string
  method: string
  /** The TEMPLATED path — a bounded tag. `'<unmatched>'` when no route matched. */
  route: string
  /** The resolved path — high cardinality, never a tag. */
  path: string
  status: number
  bytesIn: number
  /** The serialized body length. Headers are not counted. */
  bytesOut: number
  params: Record<string, string>
  query: Record<string, string | string[]>
  seed: string
  operationId?: string
  decisions: Decisions
  error?: string
  /** `ctx.log` contributions. */
  custom: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void | Promise<void>
export type ErrorSink = (error: unknown, ctx?: Ctx) => void

/** An error sink that itself throws must not become the failure it reports. */
export function reportError(sink: ErrorSink | undefined, error: unknown, ctx?: Ctx): void {
  if (sink === undefined) return
  try {
    sink(error, ctx)
  } catch {
    // Nowhere left to report to.
  }
}

/**
 * Fire-and-forget with error isolation: a throwing or rejecting logger must
 * never affect the response. The explicit `.catch()` matters — a bare floating
 * promise turns a logger's rejection into an unhandled rejection, which can take
 * the process down.
 */
export function emitLog(sink: LogSink | undefined, record: LogRecord, onError?: ErrorSink): void {
  if (sink === undefined) return
  try {
    const result = sink(record)
    if (result !== undefined && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch((error) => reportError(onError, error))
    }
  } catch (error) {
    reportError(onError, error)
  }
}

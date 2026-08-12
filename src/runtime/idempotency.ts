import type { Operation } from '../spec/types.ts'
import { fnv1aBytes } from '../generate/rng.ts'

export type ScopePart = 'key' | 'route' | 'bodyHash'

/** The `idempotency` option, master spec §11. */
export interface IdempotencyConfig {
  header?: string
  /** Methods to enable even when the document declares no key parameter. */
  methods?: string[]
  ttlMs?: number
  /**
   * How long an in-flight marker survives. §11 does not say what happens when a
   * request never completes; without an answer the key wedges permanently and
   * every retry sees a marker that will never resolve. Two mechanisms cover it:
   * this TTL for a process that dies mid-request, and the handler's boundary
   * catch for a throw.
   */
  inFlightTtlMs?: number
  /**
   * `key` and `route` compose the storage key, in the order given. `bodyHash`
   * does NOT go in the key — it means "a different body under this key is a
   * conflict". Putting the fingerprint in the key would make a different body
   * compute a different key, miss the lookup, and leave §11's own
   * MOCK_IDEMPOTENCY_MISMATCH rule unreachable. See the phases 7-9 design §2.7.
   */
  scope?: ScopePart[]
  conflictStatus?: number
}

export interface ResolvedIdempotency {
  header: string
  methods: string[]
  ttlMs: number
  inFlightTtlMs: number
  scope: ScopePart[]
  conflictStatus: number
}

/**
 * What lives in the Store under a record key.
 *
 * The in-flight marker carries the fingerprint too, so a second request with a
 * DIFFERENT body conflicts on its merits rather than being reported as merely
 * concurrent.
 */
export type IdempotencyEntry =
  | { state: 'in-flight'; fingerprint: string }
  | {
      state: 'done'
      fingerprint: string
      status: number
      headers: Record<string, string>
      body: string | null
    }

export function resolveIdempotency(config: IdempotencyConfig = {}): ResolvedIdempotency {
  const scope = config.scope ?? ['key', 'route', 'bodyHash']
  // A scope of `['bodyHash']` alone would key every request in the document
  // under one record. Throw at construction rather than silently collapsing
  // every caller onto one another's responses.
  if (!scope.includes('key') && !scope.includes('route')) {
    throw new Error(
      'mockingham: idempotency scope must include "key" or "route"; ' +
        `got [${scope.join(', ')}].`
    )
  }
  return {
    header: config.header ?? 'Idempotency-Key',
    methods: (config.methods ?? []).map((method) => method.toUpperCase()),
    ttlMs: config.ttlMs ?? 86_400_000,
    inFlightTtlMs: config.inFlightTtlMs ?? 30_000,
    scope,
    conflictStatus: config.conflictStatus ?? 409
  }
}

/**
 * Per §11, an operation is idempotent when the document declares the key as a
 * header parameter, or when config names its method. The document wins nothing
 * and loses nothing — either route is sufficient.
 */
export function isIdempotent(operation: Operation, config: ResolvedIdempotency): boolean {
  const wanted = config.header.toLowerCase()
  const declared = operation.parameters.some(
    (parameter) =>
      parameter.location === 'header' && parameter.name.toLowerCase() === wanted
  )
  return declared || config.methods.includes(operation.method.toUpperCase())
}

/** fnv1a over the raw request bytes — see `fnv1aBytes` for why not the parsed body. */
export function fingerprint(raw: Uint8Array): string {
  return fnv1aBytes(raw).toString(16).padStart(8, '0')
}

export interface RecordKeyInput {
  key: string
  operation: Operation
  scope: ScopePart[]
}

/**
 * Composes the storage key from the scope's `key` and `route` parts, in the
 * configured order. The route part is the TEMPLATED path, so `/pets/1` and
 * `/pets/2` share a route and differ only through params, which belong to
 * neither part — deliberate, since a key is supposed to be unique per logical
 * operation.
 *
 * `bodyHash` contributes nothing here on purpose; see `comparesBody`.
 */
export function recordKey(input: RecordKeyInput): string {
  const parts: string[] = []
  for (const part of input.scope) {
    if (part === 'key') parts.push(`key=${input.key}`)
    else if (part === 'route') {
      parts.push(`route=${input.operation.method} ${input.operation.path}`)
    }
  }
  return `idem|${parts.join('|')}`
}

/**
 * Whether a stored fingerprint that differs from this request's is a conflict.
 *
 * This is what `bodyHash` in the scope actually controls. With it, the default
 * scope gives §11's stated behavior — same key, different body, 409. Without it,
 * any body replays the first response, which is what a caller asking for
 * `scope: ['key', 'route']` is asking for.
 */
export function comparesBody(config: ResolvedIdempotency): boolean {
  return config.scope.includes('bodyHash')
}

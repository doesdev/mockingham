import type { Operation } from '../spec/types.ts'
import { fnv1aBytes } from '../generate/rng.ts'
import { normalizeExpression, resolveExpression } from '../webhooks/expr.ts'
import { resolveTarget } from '../resolve/target.ts'
import { targetKey } from './failure.ts'
import type { Ctx, Fail, Stage } from './types.ts'
import type { Store } from './store.ts'

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
  /**
   * Per-operation keys read out of the request itself, delta design §6. The
   * record key is a control-plane target and the value is a runtime expression
   * — in practice a body pointer, `{$request.body#/meta/requestId}`, for the
   * many documents that carry the key in the body rather than in a header.
   */
  operations?: Record<string, { key: string }>
}

export interface ResolvedIdempotency {
  header: string
  methods: string[]
  ttlMs: number
  inFlightTtlMs: number
  scope: ScopePart[]
  conflictStatus: number
  /** Expression by `targetKey`, expanded from the configured targets. */
  operations: Map<string, string>
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

/**
 * `known` is the document's operations, so a configured target resolves — and,
 * more importantly, a typo throws here rather than arming a key nothing ever
 * reads. It is optional only because a unit test may resolve a config with no
 * document in hand; without it the target string is taken as the `targetKey`
 * verbatim, which is what a bare operationId resolves to anyway.
 */
export function resolveIdempotency(
  config: IdempotencyConfig = {},
  known?: Operation[]
): ResolvedIdempotency {
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
  const operations = new Map<string, string>()
  for (const [target, entry] of Object.entries(config.operations ?? {})) {
    // Normalized here, once, like every other compile site. A bare key
    // expression matches no token, so `resolveExpression` returns the literal
    // expression TEXT as an `ok` value — collapsing every request in the
    // document onto one record key and answering the second one with a
    // spurious MOCK_IDEMPOTENCY_MISMATCH 409.
    const key = normalizeExpression(entry.key)
    if (known === undefined) operations.set(target, key)
    else for (const operation of resolveTarget(target, known)) {
      operations.set(targetKey(operation), key)
    }
  }

  return {
    header: config.header ?? 'Idempotency-Key',
    methods: (config.methods ?? []).map((method) => method.toUpperCase()),
    ttlMs: config.ttlMs ?? 86_400_000,
    inFlightTtlMs: config.inFlightTtlMs ?? 30_000,
    scope,
    conflictStatus: config.conflictStatus ?? 409,
    operations
  }
}

/**
 * Per §11, an operation is idempotent when the document declares the key as a
 * header parameter, or when config names its method. Delta design §6 adds a
 * third route: config names a key expression for the operation. The document
 * wins nothing and loses nothing — each route is sufficient on its own, and
 * none takes precedence over another.
 */
export function isIdempotent(operation: Operation, config: ResolvedIdempotency): boolean {
  const wanted = config.header.toLowerCase()
  const declared = operation.parameters.some(
    (parameter) =>
      parameter.location === 'header' && parameter.name.toLowerCase() === wanted
  )
  return (
    declared ||
    config.methods.includes(operation.method.toUpperCase()) ||
    config.operations.has(targetKey(operation))
  )
}

/**
 * The key this request presents, delta design §6.
 *
 * A configured expression replaces the header for that operation rather than
 * supplementing it: an operation whose key lives in the body has no header to
 * fall back to, and inventing one would key two different callers together.
 * An expression that resolves to nothing yields `undefined`, exactly as a
 * missing header does — the request is then not idempotent and proceeds.
 */
export function suppliedKey(ctx: Ctx, config: ResolvedIdempotency): string | undefined {
  const expression = config.operations.get(targetKey(ctx.operation))
  if (expression === undefined) return ctx.headers[config.header.toLowerCase()]

  const resolved = resolveExpression(expression, {
    request: ctx.req,
    url: new URL(ctx.req.url),
    method: ctx.req.method,
    params: ctx.params,
    body: ctx.body
  })
  return resolved.ok ? resolved.value : undefined
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

export interface IdempotencyStageInput {
  operation: Operation
  config: ResolvedIdempotency
  store: Store
  /** The raw request bytes, from stage 2's parse. */
  raw: Uint8Array
  fail: Fail
  /**
   * Called when this request claims the key. The single exit uses it to know
   * what to store, and the boundary catch uses it to know what to clear.
   */
  claim: (key: string, fingerprint: string) => void
}

/**
 * Pipeline stage 5 — the read half. Stage 11, at the single exit, is the write
 * half. Idempotency spans two stages, which is why it is more invasive than its
 * size suggests.
 */
export function createIdempotencyStage(input: IdempotencyStageInput): Stage {
  return async function idempotencyStage(ctx) {
    if (!isIdempotent(input.operation, input.config)) return undefined

    // The body is parsed at stage 2 and this is stage 5, so a body pointer has
    // a parsed body to read by the time it is evaluated.
    const supplied = suppliedKey(ctx, input.config)
    // No key, nothing to key on. A document that wants the header mandatory
    // declares it `required`, and stage 4 has already rejected its absence.
    if (supplied === undefined) return undefined

    const bodyHash = fingerprint(input.raw)
    const key = recordKey({
      key: supplied,
      operation: input.operation,
      scope: input.config.scope
    })

    const entry = (await input.store.get(key)) as IdempotencyEntry | undefined

    if (entry === undefined) {
      ctx.decisions.idempotency = 'first'
      await input.store.set(
        key,
        { state: 'in-flight', fingerprint: bodyHash },
        input.config.inFlightTtlMs
      )
      input.claim(key, bodyHash)
      return undefined
    }

    // Mismatch before in-flight: a different body is a conflict on its merits,
    // whether or not the first request has finished.
    if (comparesBody(input.config) && entry.fingerprint !== bodyHash) {
      ctx.decisions.idempotency = 'mismatch'
      return await input.fail(
        input.config.conflictStatus,
        'MOCK_IDEMPOTENCY_MISMATCH',
        `Idempotency key "${supplied}" was already used with a different request body.`,
        ctx
      )
    }

    if (entry.state === 'in-flight') {
      ctx.decisions.idempotency = 'in-flight'
      return await input.fail(
        input.config.conflictStatus,
        'MOCK_IDEMPOTENCY_IN_FLIGHT',
        `Idempotency key "${supplied}" is still in flight.`,
        ctx
      )
    }

    ctx.decisions.idempotency = 'replayed'
    const headers = new Headers(entry.headers)
    headers.set('idempotent-replay', 'true')
    return new Response(entry.body, { status: entry.status, headers })
  }
}

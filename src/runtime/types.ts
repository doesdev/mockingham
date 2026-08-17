import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { Principal } from './auth.ts'

/**
 * The value handed to every user callback: resolvers, override functions, and
 * full response callbacks.
 *
 * `auth` and `deny()` are specified in the master spec §4 and are set by the
 * auth pipeline stage. `store` and `schema.*` are also specified there and
 * still arrive with plan 4. `seq` is synchronous by design decision 1.2 - it
 * is per-instance identity, not shared state.
 */
export interface Ctx {
  req: Request
  operation: Operation
  params: Record<string, string>
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body: unknown
  mediaType?: string
  rng: Rng
  requestKey: string
  /**
   * A correlation id: an inbound `X-Request-Id` when the caller sent one,
   * otherwise `hash(requestKey, ordinal)`. Derived rather than random so a
   * replayed run correlates across processes - see the phases 7-9 design §2.2.
   */
  requestId: string
  log: Record<string, unknown>
  decisions: Decisions
  seq(name: string): number
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
  /**
   * Async because it settles the body before serializing it: `generate` is
   * synchronous and may leave promises from async resolvers in the tree.
   */
  respond(
    status: number, body?: unknown, headers?: Record<string, string>
  ): Promise<Response>
  auth?: Principal
  deny(status: number, code?: string): Response
}

/**
 * What each stage decided, for the log record's `decisions` field (master spec
 * §12). Short lowercase strings rather than booleans or objects, because §12
 * separates low-cardinality fields precisely so they can be used as metric tags
 * - `auth: "denied"` tags cleanly, a nested object does not.
 *
 * A stage writes here whether or not it short-circuits: a validation that passed
 * is as loggable as one that failed.
 */
export interface Decisions {
  /** 'ok' | 'anonymous' | 'denied' */
  auth?: string
  /** 'ok' | 'failed' - absent when validateRequests is false */
  validation?: string
  /** 'ok' | 'injected' */
  failure?: string
  /** 'first' | 'replayed' | 'mismatch' | 'in-flight' - absent when not idempotent */
  idempotency?: string
  /** Reserved for phase 11's fixture path. */
  fixture?: string
}

/**
 * What an emit override function receives: the request `Ctx` plus the finished
 * response.
 *
 * `result` is a separate type rather than an optional field on `Ctx` because
 * `Ctx` is built before a response exists - `result` would then be `undefined`
 * throughout every ordinary resolver, header override, and response callback,
 * and a field that is only sometimes real is a field that gets read when it is
 * not. See the webhooks design §2.4.
 */
export interface EmitCtx extends Ctx {
  result: {
    status: number
    headers: Record<string, string>
    body: unknown
  }
}

/** A resolver or override leaf. May return a value or a promise of one. */
export type Resolver = (ctx: Ctx) => unknown

export interface Resolvers {
  byFormat?: Record<string, Resolver>
  /** Ordered - the first matching entry wins. Strings are globs. */
  byName?: Array<[string | RegExp, Resolver]>
  bySchema?: Record<string, Record<string, Resolver>>
}

/**
 * A node in an override tree: a literal value, a function, or a deeper object
 * whose keys address object properties, array indices, or '*' for every
 * existing index of an array or key of an object.
 */
export type OverrideNode = unknown

/**
 * One pipeline stage. Returning a `Response` short-circuits the pipeline;
 * returning `undefined` continues to the next stage.
 */
export type Stage = (ctx: Ctx) => Promise<Response | undefined>

/**
 * Builds an on-contract error response. Bound by the handler to one operation
 * and one request key, so a stage supplies only what it actually decided.
 * Keeping the binding out here is what lets a stage factory live beside the
 * module it belongs to instead of inside `handler.ts`.
 */
export type Fail = (
  status: number,
  code: string,
  message: string,
  ctx?: Ctx,
  errors?: Array<{ path: string; message: string }>
) => Promise<Response>

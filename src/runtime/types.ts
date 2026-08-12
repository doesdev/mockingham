import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { Principal } from './auth.ts'

/**
 * The value handed to every user callback: resolvers, override functions, and
 * full response callbacks.
 *
 * `auth` and `deny()` are specified in the master spec §4 and are set by the
 * auth pipeline stage. `store` and `schema.*` are also specified there and
 * still arrive with plan 4. `seq` is synchronous by design decision 1.2 — it
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
  log: Record<string, unknown>
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

/** A resolver or override leaf. May return a value or a promise of one. */
export type Resolver = (ctx: Ctx) => unknown

export interface Resolvers {
  byFormat?: Record<string, Resolver>
  /** Ordered — the first matching entry wins. Strings are globs. */
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

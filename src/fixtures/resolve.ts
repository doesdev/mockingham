import type { Api, Operation, Schema } from '../spec/types.ts'
import type { Compiler } from '../schema/compile.ts'
import { fixtureKey, operationSlug } from './key.ts'
import { isScoped } from './scope.ts'
import type { ScopeConfig } from './scope.ts'
import { buildRequest } from './source.ts'
import type { ContentSource, FixtureRequest } from './source.ts'
import type { FixtureMeta, FixtureStore } from './store.ts'

const JSON_TYPE = 'application/json'

export interface ResolvedLlm {
  mode: 'off' | 'bake' | 'lazy' | 'live'
  source?: ContentSource
  persona?: string
  scope?: ScopeConfig
  budget: { maxCalls?: number; maxConcurrency: number; timeoutMs: number }
}

export interface ResolvedFixture {
  /** Replaces the body entirely, at the generate seam. */
  whole?: unknown
  /** Applied as the layer beneath the user's overrides. */
  layer?: unknown
}

export interface ResolverInput {
  api: Api
  store: FixtureStore
  compiler: Compiler
  llm?: ResolvedLlm
  now: () => number
  onError?: (error: unknown) => void
}

export interface FixtureResolver {
  resolve(
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): Promise<ResolvedFixture | undefined>
  /** Synchronous lookup for use inside a response callback - never fetches. */
  peek(
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): ResolvedFixture | undefined
}

export function createFixtureResolver(input: ResolverInput): FixtureResolver {
  const llm = input.llm
  const scoped = isScoped(llm?.scope)
  // Single-flight. One process, one map: two concurrent identical requests
  // share a fetch rather than making two.
  const inFlight = new Map<string, Promise<unknown>>()
  let calls = 0

  // Whole-vs-layer is decided per ENTRY, not from the ambient llm.scope
  // config alone: a fixture baked WITH a scope carries `meta.scoped: true`
  // (set by bake(), design section 2.13/scope), and that marker travels with
  // the value even when it is later served under a config with no scope at
  // all - which the design's own mode table explicitly allows. Only a
  // fixture with no marker (hand-written, or generated before this field
  // existed) falls back to the ambient reading; that fallback is also what
  // keeps a hand-written fixture whole-body by default, since it has no meta
  // at all.
  const shape = (value: unknown, meta?: FixtureMeta): ResolvedFixture =>
    (meta?.scoped ?? scoped) ? { layer: value } : { whole: value }

  const lookup = (
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): { id: string; key: string; wildcardKey: string; schema?: Schema } => {
    const id = operationSlug(operation)
    const key = fixtureKey({ method: operation.method, path: operation.path, params })
    // `bake()` has no concrete request in hand offline, so it stores every
    // fixture under the empty-params key - which this reads back as "applies
    // to any request for this operation and status". Computed unconditionally
    // (cheap: one more hash), even for a parameter-free operation where it is
    // identical to `key` - `storeGet` below is what skips the redundant read.
    const wildcardKey = fixtureKey({ method: operation.method, path: operation.path, params: {} })
    const schema = operation.responses.find((r) => r.status === status)
      ?.content[JSON_TYPE]?.schema
    return { id, key, wildcardKey, schema }
  }

  // The exact-key/wildcard-key fallback, shared by `peek()` and `resolve()`
  // so the two paths can never drift on whether a baked fixture is visible -
  // the same reasoning as this project's single-schema-interpretation
  // invariant, applied to fixture lookup instead of schema walking. An exact
  // hand-written or lazily-fetched entry always beats a baked wildcard one,
  // because it is checked first.
  const storeGet = (
    id: string,
    status: number,
    key: string,
    wildcardKey: string
  ) => {
    const exact = input.store.get(id, status, key)
    if (exact !== undefined) return exact
    if (wildcardKey === key) return undefined
    return input.store.get(id, status, wildcardKey)
  }

  const peek: FixtureResolver['peek'] = (operation, status, params) => {
    const { id, key, wildcardKey, schema } = lookup(operation, status, params)
    // Design: "Responses with no body - 204 and anything with no JSON
    // content - skip fixture resolution entirely." A schema-less status has
    // nothing a fixture could be layered onto or replace, and handing one
    // back here is what produced an un-constructible Response downstream.
    if (schema === undefined) return undefined
    const entry = storeGet(id, status, key, wildcardKey)
    // A malformed entry (not a non-null object carrying `value`) can reach
    // the store through a route other than loadFixtures's own validation -
    // falls through to generation rather than throwing, per invariant 4.
    if (!entry || typeof entry !== 'object') return undefined
    return shape(entry.value, entry.meta)
  }

  return {
    peek,

    async resolve(operation, status, params) {
      const { id, key, wildcardKey, schema } = lookup(operation, status, params)
      // Same skip as peek() above, for the same reason.
      if (schema === undefined) return undefined

      if (llm?.mode !== 'live') {
        const entry = storeGet(id, status, key, wildcardKey)
        if (entry && typeof entry === 'object') return shape(entry.value, entry.meta)
      }

      if (!llm || !llm.source) return undefined
      if (llm.mode !== 'lazy' && llm.mode !== 'live') return undefined
      if (llm.budget.maxCalls !== undefined && calls >= llm.budget.maxCalls) {
        return undefined
      }

      const flightKey = `${id}|${status}|${key}`
      const existing = inFlight.get(flightKey)
      if (existing) {
        const value = await existing
        return value === undefined ? undefined : shape(value)
      }

      let request: FixtureRequest | undefined
      try {
        request = buildRequest({
          operation,
          status,
          key,
          params,
          schema,
          compiler: input.compiler,
          schemaNames: input.api.schemaNames,
          persona: llm.persona
        })
      } catch (error) {
        // Invariant 4/6: schema compilation on the lazy path can throw (a
        // pattern the runtime regex engine rejects, say) - that must fall
        // through to generation exactly like a source failure does, not
        // surface as a 500 from inside what looks like a synchronous lookup.
        input.onError?.(error)
        return undefined
      }
      if (!request) return undefined

      calls += 1
      const flight = (async (): Promise<unknown> => {
        try {
          const [result] = await llm.source!.generate([request])
          if (!result) return undefined
          // live deliberately does not persist: it exists to vary every
          // response, and writing would turn the second request into a hit.
          if (llm.mode === 'lazy') {
            input.store.set(id, status, key, {
              value: result.value,
              meta: { ...(result.meta ?? {}), generatedAt: new Date(input.now()).toISOString() }
            })
          }
          return result.value
        } catch (error) {
          // Invariant 4. The caller falls through to seeded generation.
          input.onError?.(error)
          return undefined
        } finally {
          inFlight.delete(flightKey)
        }
      })()

      inFlight.set(flightKey, flight)
      const value = await flight
      return value === undefined ? undefined : shape(value)
    }
  }
}

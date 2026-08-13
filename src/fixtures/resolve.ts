import type { Api, Operation, Schema } from '../spec/types.ts'
import type { Compiler } from '../schema/compile.ts'
import { fixtureKey, operationSlug } from './key.ts'
import { isScoped } from './scope.ts'
import type { ScopeConfig } from './scope.ts'
import { buildRequest } from './source.ts'
import type { ContentSource } from './source.ts'
import type { FixtureStore } from './store.ts'

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
  /** Synchronous lookup for use inside a response callback — never fetches. */
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

  const shape = (value: unknown): ResolvedFixture =>
    scoped ? { layer: value } : { whole: value }

  const lookup = (
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): { id: string; key: string; schema?: Schema } => {
    const id = operationSlug(operation)
    const key = fixtureKey({ method: operation.method, path: operation.path, params })
    const schema = operation.responses.find((r) => r.status === status)
      ?.content[JSON_TYPE]?.schema
    return { id, key, schema }
  }

  const peek: FixtureResolver['peek'] = (operation, status, params) => {
    const { id, key } = lookup(operation, status, params)
    const entry = input.store.get(id, status, key)
    return entry === undefined ? undefined : shape(entry.value)
  }

  return {
    peek,

    async resolve(operation, status, params) {
      const { id, key, schema } = lookup(operation, status, params)

      if (llm?.mode !== 'live') {
        const entry = input.store.get(id, status, key)
        if (entry !== undefined) return shape(entry.value)
      }

      if (!llm || !llm.source) return undefined
      if (llm.mode !== 'lazy' && llm.mode !== 'live') return undefined
      if (schema === undefined) return undefined
      if (llm.budget.maxCalls !== undefined && calls >= llm.budget.maxCalls) {
        return undefined
      }

      const flightKey = `${id}|${status}|${key}`
      const existing = inFlight.get(flightKey)
      if (existing) {
        const value = await existing
        return value === undefined ? undefined : shape(value)
      }

      const request = buildRequest({
        operation,
        status,
        key,
        params,
        schema,
        compiler: input.compiler,
        schemaNames: input.api.schemaNames,
        persona: llm.persona
      })
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

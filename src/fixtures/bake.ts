import type { Api, Schema } from '../spec/types.ts'
import type { Compiler } from '../schema/compile.ts'
import { fixtureKey } from './key.ts'
import { isScoped, narrow } from './scope.ts'
import type { ScopeConfig } from './scope.ts'
import { buildRequest, schemaHash } from './source.ts'
import type { ContentSource, FixtureRequest, FixtureResult } from './source.ts'
import type { FixtureStore } from './store.ts'

const JSON_TYPE = 'application/json'

export interface BakeBudget {
  maxCalls?: number
  maxConcurrency?: number
  timeoutMs?: number
}

export interface BakeOptions {
  api: Api
  store: FixtureStore
  source: ContentSource
  compiler: Compiler
  persona?: string
  scope?: ScopeConfig
  budget?: BakeBudget
  now: () => number
  onWarn?: (message: string) => void
  onError?: (error: unknown) => void
}

export interface BakeSummary {
  generated: number
  /** Not attempted: recursive, no JSON body, or over the call budget. */
  skipped: number
  /**
   * Attempted and did not become a stored fixture: a null result, a thrown
   * error, or (once scoped) a narrow() that found nothing in scope to keep.
   * `ContentSource.generate` returns `FixtureResult | null` with no reason
   * attached, so a source's refusal is indistinguishable from any other miss
   * at this boundary and is counted here rather than tracked separately.
   */
  failed: number
}

export async function bake(options: BakeOptions): Promise<BakeSummary> {
  const summary: BakeSummary = { generated: 0, skipped: 0, failed: 0 }
  const budget = options.budget ?? {}
  // How many requests go to the source per call. `maxConcurrency` names it
  // badly — chunks are awaited one after another below and every shipped source
  // handles its array sequentially, so nothing here runs concurrently. A source
  // that declares a `chunkSize` overrides it, which is the only way a batching
  // source can ever see enough requests to reach its own threshold.
  const chunkSize = Math.max(1, options.source.chunkSize ?? budget.maxConcurrency ?? 4)

  const planned: Array<{ request: FixtureRequest; schema: Schema }> = []

  // Sorted by path then method so the walk order — and therefore which
  // requests a maxCalls budget admits before truncating — depends only on
  // the document's operations, never on the order they happened to appear
  // in the source object.
  const operations = [...options.api.operations].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.method < b.method ? -1 : 1
  })

  for (const operation of operations) {
    const responses = [...operation.responses].sort((a, b) => a.status - b.status)
    for (const response of responses) {
      const media = response.content[JSON_TYPE]
      if (!media) {
        summary.skipped += 1
        continue
      }
      const request = buildRequest({
        operation,
        status: response.status,
        // Deliberately keyed with empty params, not synthesized concrete
        // ones: bake runs offline with no request in hand, so this is a
        // wildcard key meaning "this fixture applies to any request for this
        // operation and status." `resolve.ts` falls back to this exact key
        // when a request's own parameterized key misses. Do not "fix" this
        // by inventing params — that would break the fallback and make a
        // baked fixture for a parameterized path unreachable again.
        key: fixtureKey({ method: operation.method, path: operation.path, params: {} }),
        params: {},
        schema: media.schema,
        compiler: options.compiler,
        schemaNames: options.api.schemaNames,
        example: media.example,
        persona: options.persona
      })
      if (!request) {
        // Recursive, or not expressible as JSON Schema. Generator-only —
        // buildRequest already made this call; we only report it.
        options.onWarn?.(
          `mockingham: ${operation.method.toUpperCase()} ${operation.path} ` +
            `status ${response.status} cannot be sent to a content source; ` +
            'it will always be generated'
        )
        summary.skipped += 1
        continue
      }
      planned.push({ request, schema: media.schema })
    }
  }

  const limit = budget.maxCalls ?? planned.length
  const attempted = planned.slice(0, limit)
  summary.skipped += planned.length - attempted.length

  const generatedAt = new Date(options.now()).toISOString()

  for (let start = 0; start < attempted.length; start += chunkSize) {
    const chunk = attempted.slice(start, start + chunkSize)
    let results: (FixtureResult | null)[]
    try {
      results = await options.source.generate(chunk.map((item) => item.request))
    } catch (error) {
      // Invariant 4: a provider that throws costs us the chunk, not the run.
      options.onError?.(error)
      summary.failed += chunk.length
      continue
    }

    for (let index = 0; index < chunk.length; index++) {
      const item = chunk[index]
      const result = results[index]
      if (!result) {
        summary.failed += 1
        continue
      }

      let value = result.value
      const scoped = isScoped(options.scope)
      if (scoped) {
        value = narrow(value, item.schema, options.scope as ScopeConfig, options.api.schemaNames)
        if (value === undefined) {
          summary.failed += 1
          continue
        }
      }

      // Same helper the startup staleness check uses on `hashFor` — computed
      // from the response schema this fixture was actually generated
      // against, so a later document change is detectable. A schema
      // `buildRequest` could turn into a request always hashes; this can
      // only come back undefined for a schema shape neither path can convert
      // to JSON Schema, which is not written rather than fabricated.
      const hash = schemaHash(item.schema, options.compiler)
      options.store.set(item.request.operationId, item.request.status, item.request.key, {
        value,
        meta: {
          ...(result.meta ?? {}),
          generatedAt,
          ...(hash !== undefined ? { schemaHash: hash } : {}),
          // FixtureMeta.scoped: so resolve()'s shape() decides whole-vs-layer
          // from this entry, not from whatever llm.scope config happens to
          // be active when it is later served — see the doc comment there.
          ...(scoped ? { scoped: true } : {})
        }
      })
      summary.generated += 1
    }
  }

  return summary
}

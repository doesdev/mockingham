import { loadApi } from './spec/load.ts'
import type { Api } from './spec/types.ts'
import { createHandler } from './server/handler.ts'
import type { HandlerOptions, EmitOptions } from './server/handler.ts'
import { createNodeServer } from './server/node.ts'
import type { Store } from './runtime/store.ts'
import { resolveTarget } from './resolve/target.ts'
import { targetKey, failNextKey, outageKey } from './runtime/failure.ts'
import type { Delivery } from './webhooks/deliver.ts'
import { resolveLlm } from './fixtures/config.ts'
import type { LlmConfig } from './fixtures/config.ts'
import { createMemoryFixtureStore } from './fixtures/store.ts'
import type { FixtureStore } from './fixtures/store.ts'
import { createCompiler } from './schema/compile.ts'
import { bake as bakeFixtures } from './fixtures/bake.ts'
import type { BakeSummary } from './fixtures/bake.ts'

export interface MockOptions extends Omit<HandlerOptions, 'llm'> {
  /**
   * The user-facing configuration surface — validated and resolved to a
   * `ResolvedLlm` (a `ContentSource`, not raw provider options) before it
   * reaches `createHandler`, which keeps provider modules out of the pure
   * core. See `src/fixtures/config.ts`.
   */
  llm?: LlmConfig
}

export interface FailNextOptions {
  times?: number
  status?: number
}

export interface OutageOptions {
  forMs?: number
  status?: number
}

export interface Mock {
  fetch(request: Request): Promise<Response>
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
  failNext(target: string, opts?: FailNextOptions): Promise<void>
  outage(target: string, opts?: OutageOptions): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  store: Store
  api: Api
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(): Delivery[]
  clearDeliveries(): void
  settled(): Promise<void>
  /**
   * Prewarms the fixture store by walking every operation the configured llm
   * source can serve. Requires an llm source — either `llm.source` directly,
   * or a provider block with `llm.mode` set to something other than `off`.
   */
  bake(): Promise<BakeSummary>
}

export function createMock(
  doc: Record<string, unknown>,
  options: MockOptions = {}
): Mock {
  const api = loadApi(doc)
  // Constructed here, not left to the handler's own default, so bake() and
  // the request path share the exact same store instance rather than the
  // handler silently creating a second one when `fixtures.store` is omitted.
  const fixtureStore = options.fixtures?.store ?? createMemoryFixtureStore()
  const resolvedLlm = resolveLlm(options.llm, { fetch: options.fetch })
  const compiler = createCompiler()
  const handler = createHandler(api, {
    ...options,
    llm: resolvedLlm,
    fixtures: { store: fixtureStore }
  })
  const server = createNodeServer(handler.fetch)

  // Resolves a control-plane target to EVERY key the failure stage reads, so a
  // typo throws instead of silently arming nothing and a wildcard target arms
  // every operation it matches rather than only the first. The key convention
  // itself comes from the failure module, which is the side that reads them.
  const keysFor = (target: string): string[] =>
    resolveTarget(target, api.operations).map(targetKey)

  return {
    fetch: handler.fetch,
    listen: (port) => server.listen(port),
    async close() {
      // Emissions in flight are dropped rather than delivered after the server
      // is gone; §13 says close() cancels them.
      await handler.close()
      await server.close()
    },

    async failNext(target, opts = {}) {
      for (const key of keysFor(target)) {
        await handler.store.set(failNextKey(key), {
          times: opts.times ?? 1,
          status: opts.status ?? 503
        })
      }
    },

    async outage(target, opts = {}) {
      for (const key of keysFor(target)) {
        await handler.store.set(
          outageKey(key),
          { status: opts.status ?? 503 },
          opts.forMs
        )
      }
    },

    async setSeed(next) {
      handler.setSeed(next)
    },

    async reset() {
      // Delegates wholly: the handler owns the store's lifecycle, and two
      // surfaces each deciding what reset means is what deferred item 3 was.
      await handler.reset()
    },

    store: handler.store,
    api,

    emit: (name, opts) => handler.emit(name, opts),
    deliveries: () => handler.deliveries(),
    clearDeliveries: () => handler.clearDeliveries(),
    settled: () => handler.settled(),

    async bake() {
      if (!resolvedLlm?.source) {
        throw new Error(
          'mockingham: bake() requires an llm source. Set llm.mode to something ' +
            'other than "off" and configure llm.openai (or another provider), or ' +
            'pass llm.source directly.'
        )
      }
      return bakeFixtures({
        api,
        store: fixtureStore,
        source: resolvedLlm.source,
        compiler,
        persona: resolvedLlm.persona,
        scope: resolvedLlm.scope,
        budget: resolvedLlm.budget,
        now: options.now ?? (() => Date.now()),
        onWarn: options.onWarn,
        onError: (error) => options.onError?.(error)
      })
    }
  }
}

export { loadApi } from './spec/load.ts'
export type { Api, Operation, Schema } from './spec/types.ts'
export type { HandlerOptions } from './server/handler.ts'
export type { Delivery } from './webhooks/deliver.ts'
export type { WebhookConfig } from './webhooks/emit.ts'
export type { LlmConfig } from './fixtures/config.ts'
export type { FixtureStore } from './fixtures/store.ts'
export type { BakeSummary } from './fixtures/bake.ts'

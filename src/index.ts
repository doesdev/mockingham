import { loadApi } from './spec/load.ts'
import type { Api } from './spec/types.ts'
import { createHandler } from './server/handler.ts'
import type { HandlerOptions, EmitOptions } from './server/handler.ts'
import { createNodeServer } from './server/node.ts'
import type { Store } from './runtime/store.ts'
import { resolveTarget } from './resolve/target.ts'
import { targetKey, failNextKey, outageKey } from './runtime/failure.ts'
import type { Delivery } from './webhooks/deliver.ts'

export type MockOptions = HandlerOptions

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
}

export function createMock(
  doc: Record<string, unknown>,
  options: MockOptions = {}
): Mock {
  const api = loadApi(doc)
  const handler = createHandler(api, options)
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
    close: () => server.close(),

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
    clearDeliveries: () => handler.clearDeliveries()
  }
}

export { loadApi } from './spec/load.ts'
export type { Api, Operation, Schema } from './spec/types.ts'
export type { HandlerOptions } from './server/handler.ts'
export type { Delivery } from './webhooks/deliver.ts'
export type { WebhookConfig } from './webhooks/emit.ts'

import { loadApi } from './spec/load.ts'
import type { Api } from './spec/types.ts'
import { createHandler } from './server/handler.ts'
import type { HandlerOptions, EmitOptions, Capabilities } from './server/handler.ts'
import { createNodeServer } from './server/node.ts'
import type { Store } from './runtime/store.ts'
import { resolveTarget } from './resolve/target.ts'
import { targetKey, failNextKey, outageKey } from './runtime/failure.ts'
import { overrideKey, assertSerializable, assertValidOverrideKeys } from './runtime/overrides.ts'
import { variantKey } from './runtime/variant.ts'
import type { RuntimeOverride } from './runtime/overrides.ts'
import type { Delivery } from './webhooks/deliver.ts'
import type { Registration } from './webhooks/registry.ts'
import { resolveLlm } from './fixtures/config.ts'
import type { LlmConfig } from './fixtures/config.ts'
import { createMemoryFixtureStore } from './fixtures/store.ts'
import type { FixtureStore, FixtureRecord } from './fixtures/store.ts'
import { createCompiler } from './schema/compile.ts'
import { bake as bakeFixtures } from './fixtures/bake.ts'
import type { BakeSummary, BakeScope } from './fixtures/bake.ts'
import { warnOnStaleFixtures } from './fixtures/persist.ts'
import { schemaHashLookup } from './fixtures/source.ts'
import { createMcpServer } from './mcp/server.ts'
import type { McpOptions, McpServerHandle } from './mcp/server.ts'
import { createMcpContext } from './mcp/context.ts'
import { compileConfigs } from './runtime/config.ts'

const JSON_TYPE = 'application/json'

export interface MockOptions extends Omit<HandlerOptions, 'llm'> {
  /**
   * The user-facing configuration surface - validated and resolved to a
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
  /**
   * Layers a runtime override over any configured one for every operation the
   * target resolves to. JSON data only - see `assertSerializable`.
   */
  override(target: string, value: RuntimeOverride): Promise<void>
  /** No target clears every operation in the document. */
  clearOverrides(target?: string): Promise<void>
  /**
   * Stores a union-branch preference for every operation the target resolves
   * to. A `Prefer: variant=` header on a request outranks it, and a name
   * matching no branch falls through to the seeded pick. Design section 5.5.
   */
  setVariant(target: string, name: string): Promise<void>
  /** No target clears every operation in the document. */
  clearVariants(target?: string): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  store: Store
  api: Api
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  /**
   * Re-sends a recorded delivery verbatim - same body, same signature header,
   * same destination, same `id` (refinements design §7.3). Rejects on an
   * unknown id, or one that has aged out of the bounded delivery log.
   */
  redeliver(id: string): Promise<Delivery>
  deliveries(): Delivery[]
  clearDeliveries(): void
  /**
   * Every webhook destination registration this process knows about, sorted by
   * webhook then scope - refinements design §3.5.
   */
  registrations(webhook?: string): Promise<Registration[]>
  /**
   * Which operations recall, register or carry an idempotency key - refinements
   * design §9. What the MCP read tools report; exposed here because a consumer
   * embedding the mock has the same "will this round-trip?" question an agent
   * does.
   */
  capabilities(): Capabilities
  /**
   * Registers a destination imperatively, as a `registerVia` operation would.
   * An absent scope is the unscoped registration.
   */
  register(webhook: string, url: string, scope?: string): Promise<void>
  unregister(webhook: string, scope?: string): Promise<void>
  settled(): Promise<void>
  /**
   * Prewarms the fixture store by walking every operation the configured llm
   * source can serve. Requires an llm source - either `llm.source` directly,
   * or a provider block with `llm.mode` set to something other than `off`.
   *
   * `only` narrows the walk to one operation, and optionally one status - the
   * scoped re-bake `regenerate_fixture` is built on. A filter that matches no
   * operation throws rather than reporting a summary of zeroes.
   */
  bake(options?: { only?: BakeScope }): Promise<BakeSummary>
  /**
   * Everything currently in the fixture store, sorted. This is what
   * `list_fixtures` reports, and what a caller needs to see whether a bake
   * landed or a fixture has gone stale.
   */
  fixtures(): FixtureRecord[]
  /**
   * Builds an MCP server over this mock. `transport: 'http'` mounts it on the
   * mock's own fetch surface, so it works before or after `listen()`.
   */
  mcp(options?: McpOptions): McpServerHandle
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

  // A schemaHash mismatch means the document moved under a fixture `bake`
  // generated earlier. This is diagnostic only - warnOnStaleFixtures never
  // removes anything from `fixtureStore`, so a stale fixture keeps serving
  // exactly as it did before this check ran. Design section 2.13.
  warnOnStaleFixtures(
    fixtureStore,
    schemaHashLookup(api, compiler),
    options.onWarn ?? ((message) => console.warn(message))
  )

  const handler = createHandler(api, {
    ...options,
    llm: resolvedLlm,
    fixtures: { store: fixtureStore }
  })
  // Read on every request rather than captured, so mcp() works after listen().
  let mount: { path: string; handle: McpServerHandle } | undefined

  const fetchWithMcp = async (request: Request): Promise<Response> => {
    const current = mount
    if (current !== undefined && new URL(request.url).pathname === current.path) {
      return current.handle.handleRequest(request)
    }
    return handler.fetch(request)
  }

  const server = createNodeServer(fetchWithMcp)

  // Resolves a control-plane target to EVERY key the failure stage reads, so a
  // typo throws instead of silently arming nothing and a wildcard target arms
  // every operation it matches rather than only the first. The key convention
  // itself comes from the failure module, which is the side that reads them.
  const keysFor = (target: string): string[] =>
    resolveTarget(target, api.operations).map(targetKey)

  const mockRef: Mock = {
    fetch: fetchWithMcp,
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

    async override(target, value) {
      // Checked before any write, so a partially-applied wildcard is
      // impossible: either every matching operation gets the override or none
      // does.
      assertValidOverrideKeys(value)
      assertSerializable(value)
      // `assertSerializable` just proved this value can survive a serializing
      // Store - it does not prove the Store keeps a copy. An in-process Store
      // keeps the live reference by default, so storing `value` itself would
      // let the caller mutate what the mock serves after the call returns, or
      // inject something that never passed the door above. One copy, made
      // once here rather than per operation, is what makes what the mock
      // serves a snapshot instead of a window onto the caller's object.
      const stored = JSON.parse(JSON.stringify(value)) as RuntimeOverride
      for (const key of keysFor(target)) {
        await handler.store.set(overrideKey(key), stored)
      }
    },

    async clearOverrides(target) {
      // No enumeration on `Store`, so a clear-all deletes the key for every
      // operation the document declares. The operation list is finite and is
      // already the authority for what a target can resolve to - this avoids
      // both an index entry to keep consistent and `store.clear()`, which
      // would also discard idempotency keys and chaos state. Design 3.1.
      const keys = target === undefined
        ? api.operations.map(targetKey)
        : keysFor(target)
      for (const key of keys) {
        await handler.store.delete(overrideKey(key))
      }
    },

    async setVariant(target, name) {
      // `keysFor` resolves through `resolveTarget`, so a typo throws here
      // rather than silently storing a preference nothing ever reads.
      for (const key of keysFor(target)) {
        await handler.store.set(variantKey(key), name)
      }
    },

    async clearVariants(target) {
      // Same reasoning as `clearOverrides`: no enumeration on `Store`, and
      // `store.clear()` would take idempotency keys and chaos state with it.
      const keys = target === undefined
        ? api.operations.map(targetKey)
        : keysFor(target)
      for (const key of keys) {
        await handler.store.delete(variantKey(key))
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
    redeliver: (id) => handler.redeliver(id),
    deliveries: () => handler.deliveries(),
    clearDeliveries: () => handler.clearDeliveries(),
    registrations: (webhook) => handler.registrations(webhook),
    capabilities: () => handler.capabilities(),
    register: (webhook, url, scope) => handler.register(webhook, url, scope),
    unregister: (webhook, scope) => handler.unregister(webhook, scope),
    settled: () => handler.settled(),

    fixtures: () => fixtureStore.records(),

    async bake(bakeOptions = {}) {
      // Checked before the scope filter, so a regeneration with no source
      // configured says THAT rather than reporting a filter miss.
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
        only: bakeOptions.only,
        now: options.now ?? (() => Date.now()),
        onWarn: options.onWarn,
        onError: (error) => options.onError?.(error)
      })
    },

    mcp(mcpOptions: McpOptions = {}): McpServerHandle {
      // Built through the one shared factory rather than a literal here, so
      // the context a tool sees in production is the context it sees under
      // test. `mockRef` is read at call time, never during construction.
      const context = createMcpContext(
        mockRef,
        compileConfigs(options.operations, api.operations)
      )
      const inner = createMcpServer(context, mcpOptions)

      // Design §3.5: close() unmounts an http server as well as closing any
      // attached transport. The unmount lives here because the mount slot does
      // - mcp/server.ts knows nothing about the dispatcher.
      //
      // Guarded on identity: a later mcp({ transport: 'http' }) call replaces
      // the slot, and closing the older handle must not unmount the newer one.
      const handle: McpServerHandle = {
        ...inner,
        async close(): Promise<void> {
          if (mount?.handle === handle) mount = undefined
          await inner.close()
        }
      }

      if (mcpOptions.transport === 'http') {
        const path = mcpOptions.path ?? '/mcp'
        if (api.operations.some((operation) => operation.path === path)) {
          ;(options.onWarn ?? ((message: string) => console.warn(message)))(
            `mockingham: the MCP server is mounted at ${path}, which shadows an ` +
              'operation the document declares at the same path. Requests to it ' +
              'will reach the MCP server, not the mock. Mount elsewhere with ' +
              'mcp({ path: "..." }) if that is not what you want.'
          )
        }
        mount = { path, handle }
      }

      return handle
    }
  }

  return mockRef
}

export { loadApi } from './spec/load.ts'
export type { Api, Operation, Schema } from './spec/types.ts'
export type { HandlerOptions, EmitOptions } from './server/handler.ts'

// Writing a typed handler needs these, and `exports` deliberately declares only
// `.`, so an unexported type is one a consumer cannot name at all - the choice
// left is `any` or a local restatement that rots on the next release. `Ctx` was
// reachable by indexed access already
// (`Parameters<NonNullable<HandlerOptions['decide']>>[0]`), which is proof the
// gap was forwarding rather than design: nothing here is newly public, it is
// only newly nameable. Forwarded from the root rather than given an `exports`
// subpath, which would buy a second public entry point and the module layout
// commitment that comes with it.
export type {
  Ctx, EmitCtx, Decisions, Resolver, Resolvers, OverrideNode
} from './runtime/types.ts'
// The value type of the public `HandlerOptions.operations`, plus what its own
// fields are made of.
export type {
  OperationConfig, StatusConfig, EmitConfig
} from './runtime/config.ts'
export type { FailurePolicy, CircuitPolicy, Directive } from './runtime/failure.ts'
// The declared type of `Mock.store`.
export type { Store } from './runtime/store.ts'
export type {
  Capabilities, OperationCapabilities, IdempotencyKeySource
} from './server/handler.ts'
export type { Delivery } from './webhooks/deliver.ts'
export type { WebhookConfig, RegisterVia, UnregisterVia } from './webhooks/emit.ts'
export type { Registration } from './webhooks/registry.ts'
export type { LlmConfig } from './fixtures/config.ts'
export type { RuntimeOverride } from './runtime/overrides.ts'

// `seedTime` arrives through HandlerOptions; the default it falls back to is
// exported so a caller can offset from it rather than guess at it.
export { DEFAULT_SEED_TIME } from './generate/clock.ts'
export type { BakeSummary, BakeScope } from './fixtures/bake.ts'

// The bake-commit-serve loop needs these at the package root. Exporting only
// the types, as this file used to, left no way to construct a store or a
// source without importing internal paths - which happened to work solely
// because package.json declares no `exports` map.
export { createMemoryFixtureStore } from './fixtures/store.ts'
export type {
  FixtureStore,
  FixtureEntry,
  FixtureMeta,
  FixtureRecord
} from './fixtures/store.ts'

export { createDiskFixtureStore } from './fixtures/persist.ts'
export type { DiskStoreOptions } from './fixtures/persist.ts'

// A third-party provider is written against these and nothing else.
export type {
  ContentSource,
  FixtureRequest,
  FixtureResult
} from './fixtures/source.ts'

export { createRecordedSource } from './fixtures/sources/recorded.ts'
export type { RecordedEntry } from './fixtures/sources/recorded.ts'

export type { McpOptions, McpServerHandle } from './mcp/server.ts'
export type { McpContext, McpTool } from './mcp/context.ts'

import { createRouter } from '../spec/routes.ts'
import type { Api, Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { createVirtualClock } from '../generate/clock.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { parseBody } from '../runtime/body.ts'
import { renderResponse } from '../runtime/render.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, EmitCtx, Fail, OverrideNode, Resolvers, Stage } from '../runtime/types.ts'
import { isSupported, resolveExpression } from '../webhooks/expr.ts'
import { runCapture } from '../runtime/capture.ts'
import type { CaptureRule } from '../runtime/capture.ts'
import { compileLinkRules, createLinkTable } from '../runtime/link.ts'
import type { CompiledLinkRule, LinkRule } from '../runtime/link.ts'
import { compileConfigs, resolveConfigs } from '../runtime/config.ts'
import type { EmitConfig, OperationConfig, StatusConfig } from '../runtime/config.ts'
import { preferred } from '../runtime/select.ts'
import { envelope, isCallbackError, markCallback, buildError } from '../runtime/errors.ts'
import type { ErrorBodyMode } from '../runtime/errors.ts'
import { createValidationStage } from '../runtime/validate.ts'
import { createAuthStage } from '../runtime/auth.ts'
import type { AuthConfig } from '../runtime/auth.ts'
import { createResponders } from '../runtime/pipeline.ts'
import { createFailureStage, compilePolicies } from '../runtime/failure.ts'
import type { Directive, FailurePolicy } from '../runtime/failure.ts'
import { createMemoryStore } from '../runtime/store.ts'
import type { Store } from '../runtime/store.ts'
import { requestIdFor, emitLog, reportError } from '../runtime/logging.ts'
import type { LogSink, ErrorSink } from '../runtime/logging.ts'
import { createIdempotencyStage, resolveIdempotency } from '../runtime/idempotency.ts'
import type { IdempotencyConfig } from '../runtime/idempotency.ts'
import {
  emitWebhook, redeliverWebhook, resolveWebhook, createDeliveryLog
} from '../webhooks/emit.ts'
import type { WebhookConfig, ResolvedWebhook } from '../webhooks/emit.ts'
import { createRegistry, normalizeExpression } from '../webhooks/registry.ts'
import type { Registration } from '../webhooks/registry.ts'
import { resolveTarget } from '../resolve/target.ts'
import type { Delivery } from '../webhooks/deliver.ts'
import { createFixtureResolver } from '../fixtures/resolve.ts'
import type { ResolvedLlm } from '../fixtures/resolve.ts'
import { createMemoryFixtureStore } from '../fixtures/store.ts'
import type { FixtureStore } from '../fixtures/store.ts'
import { createCompiler } from '../schema/compile.ts'
import { readOverride } from '../runtime/overrides.ts'
import { readVariant } from '../runtime/variant.ts'

export type { EmitConfig, OperationConfig, StatusConfig } from '../runtime/config.ts'

/** Passed to `Handler.emit` — the imperative trigger. */
export interface EmitOptions {
  /** Destination tier 1: wins over a registered, captured or configured url. */
  to?: string
  /**
   * Which registration this emission addresses. An explicit scope wins over a
   * configured `scopeBy` expression, exactly as `to` wins over any resolved
   * destination. Absent addresses the unscoped registration — design §3.4.
   */
  scope?: string
  /** Layered over the generated payload, exactly as a response body override is. */
  body?: OverrideNode
}

export interface Handler {
  fetch(request: Request): Promise<Response>
  store: Store
  setSeed(next: string): void
  /**
   * Clears the store it was given — not only the store it created. The two
   * surfaces disagreed until plan 5: `Mock.reset()` wiped a caller-supplied
   * store while `Handler.reset()` left it untouched. Agreeing on "reset clears
   * the store it was given" is the honest contract now that idempotency records
   * live there too; supply a dedicated Store rather than sharing your
   * application's.
   */
  reset(): Promise<void>
  /**
   * The imperative trigger. Resolves with a `Delivery` in every case,
   * including `unresolved` and an exhausted retry — §13's "an emit never
   * hard-fails" is a property of the return type, not only of the
   * implementation. An undeclared webhook name throws: that is a typo, and
   * `compileTarget`/`resolveTarget` already throw on those rather than
   * silently never firing. Calling `emit()` after `close()` rejects too, for
   * the same reason — the handler has stopped accepting new emissions, and
   * silently sending anyway would be surprising rather than useful. Tracked
   * the same way an operation-linked emission is, so `settled()` and
   * `close()` genuinely wait for it rather than racing ahead of it.
   */
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  /**
   * Re-sends a recorded delivery's bytes — refinements design §7.3. Same body,
   * same signature header, same destination, same `id`; the payload is not
   * regenerated and the destination is not re-resolved. Appends a second record
   * carrying the same id.
   *
   * Rejects on an id that is not in the log, or one that has aged out of it —
   * both are caller errors, like an undeclared webhook name. A redelivery that
   * FAILS is still a recorded `Delivery`, never a rejection.
   */
  redeliver(id: string): Promise<Delivery>
  /** Oldest first. */
  deliveries(): Delivery[]
  clearDeliveries(): void
  /**
   * Every known webhook destination registration, sorted by webhook then
   * scope. Sorted because invariant 2 forbids an unordered iteration deciding
   * anything observable, and this is observable. Enumeration is process-local
   * even when the Store is shared — design §13.1.
   */
  registrations(webhook?: string): Promise<Registration[]>
  /** The imperative equivalent of a `registerVia` operation. */
  register(webhook: string, url: string, scope?: string): Promise<void>
  unregister(webhook: string, scope?: string): Promise<void>
  /**
   * Resolves once every pending emission — from either trigger — has settled.
   * The response never waits for one (§13), so a test needs this to await what
   * `fetch()` already let go of.
   */
  settled(): Promise<void>
  /**
   * Stops accepting new emissions and drains those already pending. An
   * emission still waiting on its `afterMs` is dropped, not delivered late —
   * §13's close() cancels rather than flushes.
   */
  close(): Promise<void>
}

export interface HandlerOptions {
  seed?: string
  maxDepth?: number
  preferExamples?: boolean
  debugHeaders?: boolean
  resolvers?: Resolvers
  headers?: Record<string, OverrideNode>
  operations?: Record<string, OperationConfig>
  errorBody?: ErrorBodyMode
  validateRequests?: boolean
  auth?: AuthConfig
  failure?: FailurePolicy[]
  decide?: (ctx: Ctx) => Directive | undefined
  chaosSeed?: string
  store?: Store
  sleep?: (ms: number) => Promise<void>
  idempotency?: IdempotencyConfig
  /**
   * The wall clock, injected. Log timestamps and Store TTLs are the only two
   * consumers; neither can reach a response body, so neither violates the
   * determinism invariant. Defaults to `Date.now` at this boundary and nowhere
   * else.
   */
  now?: () => number
  /**
   * The starting timestamp of the seeded virtual clock UUIDv7 generation reads
   * — NOT a wall clock, and deliberately not defaulted to one. Defaults to
   * `DEFAULT_SEED_TIME`, a fixed epoch, so a baked fixture holding a v7 is
   * stable across runs. See `src/generate/clock.ts`.
   */
  seedTime?: number
  onLog?: LogSink
  onError?: ErrorSink
  /**
   * Where startup warnings go — an unsupported runtime expression, for one.
   * Injectable so a test can assert on it without capturing the console, and
   * so an embedding application can route it.
   */
  onWarn?: (message: string) => void
  /**
   * Response linking for create-then-read loops. A write records its generated
   * response against a key it minted; a read whose key matches replays those
   * bytes; a miss falls through to ordinary generation. NOT stateful CRUD — see
   * `src/runtime/link.ts` and the refinements design §4.
   */
  link?: LinkRule[]
  webhooks?: Record<string, WebhookConfig>
  /** Capture every delivery without sending it. See the webhooks design §2.6. */
  captureOnly?: boolean
  /** Injectable so the suite never reaches the network. */
  fetch?: typeof fetch
  fixtures?: { store?: FixtureStore }
  /**
   * Already resolved — `createMock` validates the user-facing `LlmConfig` and
   * constructs the source. The handler only ever sees a `ContentSource`, which
   * keeps provider modules out of the pure core.
   */
  llm?: ResolvedLlm
}

// Module scope: a per-request TextEncoder would be one more allocation on
// every logged request for no behavioral difference — the encoder itself is
// stateless.
const encoder = new TextEncoder()

function requestKey(
  operation: Operation,
  params: Record<string, string>,
  seed: string
): string {
  const ordered = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&')
  return `${seed}|${operation.method}|${operation.path}|${ordered}`
}

export function createHandler(
  api: Api,
  options: HandlerOptions = {}
): Handler {
  const router = createRouter(api.operations)
  let seed = options.seed ?? 'mockingham'
  const resolvers = compileResolvers(options.resolvers)

  const compiled = compileConfigs(options.operations, api.operations)

  const counters: Counters = createCounters()

  // Per-mock, not per-request: it advances across requests, which is what makes
  // ids from successive POSTs sort correctly. That also makes v7 generation a
  // sequence-dependent output — same request sequence, same ids.
  const virtualClock = createVirtualClock(options.seedTime)

  const now = options.now ?? (() => Date.now())
  // One clock for the store and the log, so a fake clock in a test drives both.
  const store = options.store ?? createMemoryStore(now)
  const fixtureStore = options.fixtures?.store ?? createMemoryFixtureStore()
  const fixtureResolver = createFixtureResolver({
    api,
    store: fixtureStore,
    compiler: createCompiler(),
    llm: options.llm,
    now,
    onError: (error) => reportError(options.onError, error)
  })
  const idempotency = resolveIdempotency(options.idempotency, api.operations)
  const policies = compilePolicies(options.failure, api.operations)
  const chaosSeed = options.chaosSeed ?? seed
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const chaosCounts = new Map<string, number>()
  // Its OWN counter. Sharing the chaos counter would shift every chaos roll the
  // moment logging was enabled — phases 7-9 design §2.2.
  const requestOrdinals = new Map<string, number>()

  const mode: ErrorBodyMode = options.errorBody ?? 'contract'

  const warn = options.onWarn ?? ((message: string) => console.warn(message))

  // Compiled once. An expression outside the documented subset warns here
  // rather than silently never firing — the same reasoning as `compileTarget`
  // throwing on a target that matches nothing.
  const callbacks = api.operations.map((operation) => {
    const specs = operation.callbacks.filter((callback) => {
      if (isSupported(callback.expression)) return true
      warn(
        `mockingham: callback "${callback.name}" on ` +
          `${operation.method.toUpperCase()} ${operation.path} uses the runtime ` +
          `expression ${callback.expression}, which is outside the supported ` +
          'subset. It will not capture a destination.'
      )
      return false
    })
    // The document's `callbacks` entries become capture rules here, once, not
    // per request. The tier-2 block at the single exit then runs them through
    // the same pass the registry and response linking use, so the existing
    // behavior travels through the new path rather than sitting beside it.
    const rules: CaptureRule[] = specs.map((callback) => ({
      kind: 'callback',
      name: callback.name,
      expression: callback.expression
    }))
    return { operation, specs, rules }
  })

  // Response linking. Targets resolve here so a typo throws at construction
  // rather than silently never linking, and the bounds default here so the
  // table is never unbounded — design §4.3.
  const linkRules = compileLinkRules(options.link, api.operations)
  const linkTable =
    linkRules.length === 0
      ? undefined
      : createLinkTable(store, linkRules.map((rule) => ({ ttlMs: rule.ttlMs, max: rule.max })))
  // Compiled once per operation, not per request, exactly as the callback rules
  // above are. A `from` operation records; a `to` operation recalls.
  const linkCaptureRules = new Map<Operation, CaptureRule[]>()
  const linkRecallRules = new Map<Operation, CompiledLinkRule[]>()
  for (const rule of linkRules) {
    for (const operation of rule.from) {
      const existing = linkCaptureRules.get(operation) ?? []
      existing.push({
        kind: 'link',
        index: rule.index,
        keyExpr: rule.fromKey,
        remember: rule.remember
      })
      linkCaptureRules.set(operation, existing)
    }
    for (const operation of rule.to) {
      const existing = linkRecallRules.get(operation) ?? []
      existing.push(rule)
      linkRecallRules.set(operation, existing)
    }
  }

  const webhookConfigs = new Map<string, ResolvedWebhook>()
  for (const [name, config] of Object.entries(options.webhooks ?? {})) {
    webhookConfigs.set(name, resolveWebhook(config))
  }

  // The cross-operation destination registry (design §3). Store-backed, so
  // `reset()` clears registrations for free through `store.clear()`.
  const registry = createRegistry(store)

  // `registerVia`/`unregisterVia` become capture rules here, once, keyed by the
  // operation their target resolves to — exactly as the callback rules above
  // are. `resolveTarget` throws on a target matching nothing, so a typo fails
  // loudly at construction rather than silently never registering.
  const registryRules = new Map<Operation, CaptureRule[]>()
  const scopeExpressions = new Map<string, string>()
  for (const [name, config] of Object.entries(options.webhooks ?? {})) {
    const scope = config.scopeBy === undefined
      ? undefined
      : normalizeExpression(config.scopeBy)
    if (scope !== undefined) scopeExpressions.set(name, scope)
    const addRule = (target: string, rule: CaptureRule): void => {
      for (const operation of resolveTarget(target, api.operations)) {
        const existing = registryRules.get(operation) ?? []
        existing.push(rule)
        registryRules.set(operation, existing)
      }
    }
    if (config.registerVia !== undefined) {
      addRule(config.registerVia.operationId, {
        kind: 'register',
        webhook: name,
        url: normalizeExpression(config.registerVia.url),
        scope
      })
    }
    if (config.unregisterVia !== undefined) {
      addRule(config.unregisterVia.operationId, { kind: 'unregister', webhook: name, scope })
    }
  }

  const deliveryLog = createDeliveryLog()
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  // Pending emissions. `settled()` drains them, `close()` stops accepting new
  // ones, and `reset()` invalidates the ones already waiting. A generation
  // counter rather than real timer handles: `sleep` is injected, so there is no
  // timer object to cancel, and checking a generation after the wait is both
  // simpler and testable.
  const pending = new Set<Promise<void>>()
  let generation = 0
  let closed = false

  function track(promise: Promise<void>): void {
    pending.add(promise)
    void promise.finally(() => pending.delete(promise))
  }

  // A promise `close()` resolves. Racing an `afterMs` wait against it is the
  // only way to unblock an INJECTED `sleep` — there is no timer handle to
  // cancel on one of those — so this is what makes `close()` return promptly
  // regardless of which `sleep` implementation is in play. Finding I3.
  let resolveClosedSignal: () => void = () => {}
  const closedSignal = new Promise<void>((resolve) => { resolveClosedSignal = resolve })

  // Real timers created by the emission path's OWN default sleep (used only
  // when no `options.sleep` was injected), so `close()` can clear them.
  // Racing against `closedSignal` above unblocks the `await`, but the
  // underlying `setTimeout` keeps running and holds the event loop open until
  // it is cleared too — that is what let a real shutdown hang for up to
  // `afterMs` even though `close()` had already "returned" the wait.
  const pendingTimers = new Set<{ handle: ReturnType<typeof setTimeout>; resolve: () => void }>()

  function defaultEmitSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry: { handle: ReturnType<typeof setTimeout>; resolve: () => void } = {
        handle: setTimeout(() => {
          pendingTimers.delete(entry)
          resolve()
        }, ms),
        resolve
      }
      pendingTimers.add(entry)
    })
  }

  // Only the emission path's `afterMs` wait uses this. The shared `sleep`
  // above is also used by the failure stage's injected delay and by delivery
  // retry backoff, neither of which this fix touches.
  const emitSleep = options.sleep ?? defaultEmitSleep

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending])
  }

  /**
   * One emission, from either trigger. Records into the delivery log whatever
   * comes back — including `unresolved` — because §13 says an emit never
   * hard-fails and the log is where an operator sees that it did not.
   */
  async function runEmit(
    name: string,
    opts: { to?: string; scope?: string; body?: OverrideNode; ctx?: unknown } = {}
  ): Promise<Delivery> {
    // Drawn ONCE and used twice: the payload rng and the delivery id both key
    // off this ordinal. Calling `counters.next` twice would advance it between
    // the two and silently decouple an emission's payload from its identity.
    const ordinal = counters.next(`webhook|${name}`)
    const delivery = await emitWebhook({
      name,
      api,
      config: webhookConfigs.get(name) ?? resolveWebhook(),
      store,
      captureOnly: options.captureOnly === true,
      seed,
      ordinal,
      rng: createRng(`${seed}|webhook|${name}|${ordinal}`),
      generateOptions: {
        maxDepth: options.maxDepth,
        preferExamples: options.preferExamples,
        resolvers,
        schemaNames: api.schemaNames,
        clock: virtualClock
      },
      fetch: doFetch,
      sleep,
      now,
      to: opts.to,
      registry,
      scope: opts.scope,
      bodyOverride: opts.body,
      ctx: opts.ctx
    })
    deliveryLog.record(delivery)
    return delivery
  }

  /**
   * One redelivery — refinements design §7.3. Draws NO ordinal and builds no
   * new id: the recorded id travels with the recorded bytes, which is what
   * makes a duplicate observably the same delivery. Recorded into the log like
   * any other emission, so `deliveries()` shows two entries under one id.
   */
  async function runRedeliver(id: string): Promise<Delivery> {
    const delivery = await redeliverWebhook({
      id,
      api,
      log: deliveryLog,
      configFor: (webhook) => webhookConfigs.get(webhook) ?? resolveWebhook(),
      captureOnly: options.captureOnly === true,
      seed,
      fetch: doFetch,
      sleep
    })
    deliveryLog.record(delivery)
    return delivery
  }

  /**
   * The error builder, bound to one operation and one request key. Binding here
   * rather than passing five arguments at each call site is what lets each stage
   * live in its own module. The rng seed string is unchanged from plan 4, so
   * generated error bodies stay byte-identical.
   */
  const failWith = (operation: Operation | undefined, key: string): Fail =>
    (status, code, message, ctx, errors) =>
      buildError({
        operation,
        status,
        code,
        message,
        errors,
        mode,
        ctx,
        rng: createRng(`${key}|error|${status}`),
        generateOptions: {
          maxDepth: options.maxDepth,
          preferExamples: options.preferExamples,
          resolvers,
          schemaNames: api.schemaNames,
          clock: virtualClock
        },
        debugHeaders: options.debugHeaders
      })

  /**
   * What the single exit needs to know about a request, filled in by `produce`
   * as it learns it. A mutable record rather than a return value because the
   * boundary catch has to observe a request that threw before producing
   * anything — and that is precisely the request an operator most wants logged.
   */
  interface Trace {
    operation?: Operation
    params: Record<string, string>
    requestKey: string
    bytesIn: number
    ctx?: Ctx
    error?: unknown
    /** Set by stage 5 when this request claimed a key; read by the single exit. */
    claimed?: { key: string; fingerprint: string }
    /**
     * Set on the paths that never build a `Ctx` — an unmatched route and a
     * body-parse failure — so the log's `requestId` fallback does not collapse
     * every such request in the process onto the same id. `ctx.requestId` wins
     * when a `Ctx` exists; this is the equivalent for when it does not.
     */
    requestId?: string
    /**
     * The templated path for a 405, known from the router even though no
     * `Operation` was matched (the path matched, the method did not).
     */
    route?: string
    /** Set from `config.emits` once `resolveConfigs` has run. Trigger two. */
    emits?: EmitConfig[]
  }

  async function produce(request: Request, trace: Trace): Promise<Response> {
    // Stage 1 — route match.
    const url = new URL(request.url)
    const matched = router.match(request.method, url.pathname)

    if (!matched) {
      // The body is never read on this path, so `content-length` is the only
      // honest byte count available.
      trace.bytesIn = Number(request.headers.get('content-length') ?? 0) || 0

      // A pure function of the request — never the matched path's `key` below,
      // which feeds the seeded PRNG. This one only ever reaches the log, so
      // giving it its own ordinal (rather than a fixed 0) is what makes
      // repeated identical unmatched requests get distinct ids too.
      const unmatchedKey =
        `${seed}|unmatched|${request.method.toUpperCase()}|${url.pathname}`
      trace.requestKey = unmatchedKey
      const unmatchedOrdinal = (requestOrdinals.get(unmatchedKey) ?? 0) + 1
      requestOrdinals.set(unmatchedKey, unmatchedOrdinal)
      const unmatchedInbound = request.headers.get('x-request-id')
      trace.requestId = unmatchedInbound ?? requestIdFor(unmatchedKey, unmatchedOrdinal)

      const fail = failWith(undefined, seed)
      const allowed = router.allowedMethods(url.pathname)
      if (allowed.length > 0) {
        // The router matched the path on segments alone — the method is what's
        // wrong, not the route. That template is knowable even though no
        // `Operation` was matched; `operationId` is not, since it differs by
        // method and no single one answered this request.
        trace.route = router.templateFor(url.pathname)
        const response = await fail(
          405,
          'MOCK_METHOD_NOT_ALLOWED',
          `Allowed methods: ${allowed.join(', ')}`
        )
        response.headers.set('allow', allowed.join(', '))
        return response
      }
      return await fail(404, 'MOCK_NOT_FOUND', `No operation for ${url.pathname}`)
    }

    const { operation, params } = matched
    const config = resolveConfigs(operation, compiled)
    // Read once, here, rather than at render: `config.status` feeds status
    // selection below and selection runs well before the body is rendered, so
    // one read serves both. Design section 4.
    const runtime = await readOverride(store, operation)
    // `Prefer: variant=` on THIS request beats the stored `set_variant`
    // preference, for the same reason `Prefer: status` beats a configured
    // status: a header is a statement about this call. A name matching no
    // branch falls through to the seeded pick rather than failing — the
    // sibling directive's rule, and what keeps the header harmless on the many
    // responses that contain no union at all. Design section 5.5.
    const variant =
      preferred(request, 'variant') ?? (await readVariant(store, operation))
    // Computed once — it was built twice per request before this refactor.
    const key = requestKey(operation, params, seed)
    const fail = failWith(operation, key)

    trace.operation = operation
    trace.params = params
    trace.requestKey = key
    trace.emits = config.emits

    // Stage 2 — body parse and content negotiation.
    const parsed = await parseBody(request, operation)
    if (!parsed.ok) {
      // The bytes were fully read to even discover the parse failure — a 415
      // storm should not log as zero traffic.
      trace.bytesIn = parsed.raw.length
      // No `Ctx` exists yet on this path, so the log's fallback would otherwise
      // reuse ordinal 0 for every failed parse under this same request identity.
      const parseOrdinal = (requestOrdinals.get(key) ?? 0) + 1
      requestOrdinals.set(key, parseOrdinal)
      const parseInbound = request.headers.get('x-request-id')
      trace.requestId = parseInbound ?? requestIdFor(key, parseOrdinal)
      return await fail(parsed.status, parsed.code, parsed.message)
    }
    trace.bytesIn = parsed.body.raw.length

    const exampleName = preferred(request, 'example')

    // Declared above `responders`; assigned after resolution (stage 7.5, once
    // the status is known), read by the `fixture` hook at generation time —
    // the same deferral the `ctx` getter above already uses.
    let resolvedWhole: unknown
    let selectedStatus: number | undefined

    const responders = createResponders({
      operation,
      request,
      staticStatus: runtime.status ?? config.status,
      key,
      generateOptions: {
        maxDepth: options.maxDepth,
        preferExamples: options.preferExamples,
        resolvers,
        schemaNames: api.schemaNames,
        clock: virtualClock,
        // Deliberately the ONLY construction site that receives it. `runEmit`
        // has no request behind it, and steering an error envelope's union
        // (`failWith`) or a header's (render.ts) from a request header is not
        // a behavior to introduce silently. Design section 5.4.
        variant
      },
      // ctx is declared just below; this getter is only invoked later (inside
      // generateValue, at generation time), by which point the assignment has
      // already run — the same deferral the old inline closure relied on.
      ctx: () => ctx,
      // A response callback (stage 10, before status selection) calls this
      // through `ctx.generate()` with no `resolvedWhole` set yet, so it always
      // falls through to `peek` — a synchronous store read, never a fetch.
      // The pipeline's own call, after status selection, hits the fast path.
      fixture: (status) =>
        resolvedWhole !== undefined && status === selectedStatus
          ? resolvedWhole
          : fixtureResolver.peek(operation, status, params)?.whole
    })

    const ordinal = (requestOrdinals.get(key) ?? 0) + 1
    requestOrdinals.set(key, ordinal)
    // The caller's id wins: correlating with whatever they already log matters
    // more than an id we made up.
    const inbound = request.headers.get('x-request-id')
    const requestId = inbound ?? requestIdFor(key, ordinal)

    const ctx: Ctx = createContext({
      request,
      url,
      operation,
      params,
      body: parsed.body.value,
      mediaType: parsed.body.mediaType,
      rng: responders.rngFor('ctx'),
      requestKey: key,
      requestId,
      counters,
      generate: responders.generate,
      example: responders.example
    })
    trace.ctx = ctx

    // Stages 3 through 6, in the master spec's order. Auth runs before
    // validation so an unauthenticated caller cannot learn whether their body
    // was well-formed.
    const stages: Stage[] = [
      createAuthStage({
        security: operation.security,
        schemes: api.securitySchemes,
        config: options.auth ?? {},
        fail
      })
    ]

    if (options.validateRequests !== false) {
      stages.push(createValidationStage({ operation, fail }))
    }

    // Stage 5 — idempotency lookup. After validation so a malformed request
    // never claims a key it will not be able to honor.
    stages.push(
      createIdempotencyStage({
        operation,
        config: idempotency,
        store,
        raw: parsed.body.raw,
        fail,
        claim: (claimedKey, claimedFingerprint) => {
          trace.claimed = { key: claimedKey, fingerprint: claimedFingerprint }
        }
      })
    )

    // Pushed after validation so a malformed request is still rejected on its
    // merits rather than by chaos.
    stages.push(
      createFailureStage({
        operation,
        policies,
        decide: options.decide,
        store,
        chaosSeed,
        requestKey: key,
        counter: () => {
          const next = (chaosCounts.get(key) ?? 0) + 1
          chaosCounts.set(key, next)
          return next
        },
        sleep,
        fail
      })
    )

    for (const stage of stages) {
      const short = await stage(ctx)
      if (short) return short
    }

    // Stage 10 — the full response callback replaces stages 7 through 10,
    // status selection included, so it runs BEFORE the selection check: an
    // operation declaring no responses has nothing to select, yet the callback
    // must still answer.
    if (config.respond) {
      try {
        return await config.respond(ctx)
      } catch (error) {
        throw markCallback(error)
      }
    }

    // Stage 7 — status selection, now that every short-circuiting stage has run
    // and no callback has taken over.
    const selected = responders.selection()
    if (!selected) {
      return await fail(
        501,
        'MOCK_NO_RESPONSE',
        `Operation ${operation.method} ${operation.path} declares no responses`,
        ctx
      )
    }
    const chosen = selected.spec

    // After selection, because the fixture key is per status. Awaited here so
    // the generate seam below stays synchronous — design section 2.12.
    const fixture = await fixtureResolver.resolve(operation, chosen.status, params)
    resolvedWhole = fixture?.whole
    selectedStatus = chosen.status

    // Stage 7.5 — link recall. Immediately after status selection and
    // immediately before the fixture contributes, because the resulting
    // precedence is
    //   runtime override > config override > link recall > fixture > example > generated
    // — a recalled entity is more specific than a fixture for the operation
    // (the fixture answers "what does this endpoint return", the recall answers
    // "what does it return FOR THIS ID"), and less specific than either
    // override layer, which are deliberate statements from the caller.
    //
    // Only a SUCCESS status recalls. Replaying a stored body into a 404 or a
    // 500 would be actively wrong, and the failure-injection stage exists
    // precisely so a caller can force those — design §4.4.
    const linkLayer: OverrideNode[] = []
    if (linkTable !== undefined && chosen.status >= 200 && chosen.status < 300) {
      for (const rule of linkRecallRules.get(operation) ?? []) {
        const recallKey = resolveExpression(rule.toKey, {
          request,
          url,
          method: request.method,
          params,
          body: parsed.body.value
        })
        if (!recallKey.ok) continue
        const recalled = await linkTable.recall(rule.index, recallKey.value)
        // A miss falls through to ordinary generation, exactly as a fixture
        // miss does. That is the whole read side of the feature: an id the mock
        // never minted is generated for, not recalled.
        if (recalled === undefined) continue
        // A FUNCTION node, so the recalled entity replaces the generated body
        // rather than merging key-by-key into it — replaying the recorded bytes
        // is the point. The layers above still refine what it produced.
        linkLayer.push(() => recalled)
        break
      }
    }

    // Computed once, here, for both the composition below and the debug
    // header: calling `runtime.bodies`/`runtime.headers` again just to answer
    // "did it actually apply" would be a second read of the same layer.
    const runtimeBodies = runtime.bodies(chosen.status)
    const runtimeHeaders = runtime.headers(chosen.status)
    // `runtime !== EMPTY_OVERRIDE` only proves a record exists for this
    // operation, not that it did anything at the status that was actually
    // selected — an override scoped to a different status, or an empty
    // override object, would both stamp a false "applied". The header must
    // instead reflect what actually contributed: a body layer, a header, or
    // a runtime `status` that forced the selection that happened.
    const runtimeApplied =
      runtimeBodies.length > 0 ||
      Object.keys(runtimeHeaders).length > 0 ||
      (runtime.status !== undefined && runtime.status === chosen.status)

    return await renderResponse({
      ctx,
      chosen,
      // The runtime layer goes last so it refines the config layers rather
      // than erasing them, and the fixture stays beneath both.
      bodyOverrides: [...linkLayer, ...config.bodies(chosen.status), ...runtimeBodies],
      fixtureLayer: fixture?.layer as OverrideNode | undefined,
      headerOverrides: {
        ...config.headers(chosen.status),
        ...runtimeHeaders
      },
      globals: options.headers,
      resolvers,
      rngFor: responders.rngFor,
      generateOptions: responders.generateOptions,
      exampleName,
      generate: responders.generate,
      example: responders.example,
      debug: options.debugHeaders
        ? {
            seed: String(fnv1a(key)),
            source: selected.source,
            operationId: operation.operationId,
            override: runtimeApplied ? 'applied' : undefined
          }
        : undefined
    })
  }

  /**
   * The boundary 500. Every user callback — resolvers, override functions,
   * header overrides, response callbacks — runs somewhere inside `produce`, and
   * invariant 4 says the mock keeps serving whatever they do. One catch rather
   * than one per leaf: a per-leaf catch would let a half-built body reach the
   * client as if it were real.
   */
  function internalError(error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error)
    const headers = new Headers()
    if (options.debugHeaders) {
      // Header values cannot carry line breaks, and a thrown message might.
      headers.set('x-mock-error', message.replace(/[\r\n]+/g, ' '))
    }
    const code = isCallbackError(error) ? 'MOCK_CALLBACK_FAILED' : 'MOCK_INTERNAL'
    return Response.json(envelope(code, message), { status: 500, headers })
  }

  /**
   * The response body as a string, read from a clone. A `Response` body is
   * one-shot: reading the original to store it would consume it before the
   * caller ever saw it. A null body (a 204, say) stays null rather than becoming
   * an empty string, so a replay reproduces "no body" rather than "empty body".
   */
  async function captureBody(response: Response): Promise<string | null> {
    if (response.body === null) return null
    return await response.clone().text()
  }

  function headersOf(response: Response): Record<string, string> {
    const out: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      out[name] = value
    })
    return out
  }

  /**
   * The response body as a value, for `$response.body#/…` and for `EmitCtx`.
   * A non-JSON body stays a string rather than becoming `undefined`, so an
   * expression pointing at a text body still resolves.
   */
  function parseBodyText(text: string | null, response: Response): unknown {
    if (text === null || text === '') return undefined
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('json')) return text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * THE SINGLE EXIT. Every response leaves through here — a 404 built before any
   * operation was known, a body-parse 400, a stage short-circuit, a rendered
   * body, and the boundary 500 alike. Stage 11 (idempotency capture, then the
   * log record), callback capture (trigger one), and emission (trigger two)
   * all hang off this one point; that is the whole reason `produce` was split
   * out. See the phases 7-9 design §1.
   */
  async function handle(request: Request): Promise<Response> {
    const startedAt = now()
    const trace: Trace = { params: {}, requestKey: seed, bytesIn: 0 }

    let response: Response
    try {
      response = await produce(request, trace)
    } catch (error) {
      trace.error = error
      reportError(options.onError, error, trace.ctx)
      response = internalError(error)
    }

    // ── Stage 11 ──
    // From here on, `response` is what the caller gets back, no matter what.
    // Each concern below — body capture, idempotency storage, log emission —
    // is wrapped in its own try/catch and routed to `onError` rather than
    // allowed to reject `handle()`. A caller-supplied `Store` and `onLog` are
    // user code, and invariant 4 says the mock keeps serving whatever they do;
    // before this fix, a throw anywhere past `produce()` destroyed an
    // already-correct response instead of merely failing to log or store it.
    const claimed = trace.claimed
    const hasCallbacks =
      trace.operation !== undefined &&
      callbacks.some(
        (candidate) => candidate.operation === trace.operation && candidate.specs.length > 0
      )
    const hasEmits = trace.emits !== undefined && trace.emits.length > 0
    // Any capture rule may address `$response.body`, so this exit must capture
    // the body whenever the operation carries one. Without this the capture
    // pass runs against an undefined result body and records NOTHING — a link
    // rule then silently generates forever, and a registerVia never registers,
    // in both cases with no error anywhere to notice.
    //
    // Deliberately asked of the rule maps as a group rather than one clause per
    // kind: this gate and the rule list assembled at the capture call below
    // must name the same set, and two places listing kinds by hand drift the
    // moment a fourth kind is added. Both defects above were exactly that drift
    // — link rules reached the capture pass while this gate still listed only
    // callbacks, and registry rules were then added to the pass alone.
    const hasCaptureRules =
      trace.operation !== undefined &&
      (registryRules.has(trace.operation) || linkCaptureRules.has(trace.operation))
    const needsBody =
      claimed !== undefined ||
      options.onLog !== undefined ||
      hasCallbacks ||
      hasEmits ||
      hasCaptureRules
    // The body is read at most once, from a clone, and only when something
    // needs it: an idempotency record to store, a `bytesOut` to report, a
    // callback expression that may point at it, or an emit's `ctx.result.body`.
    let captured: string | null = null
    if (needsBody) {
      try {
        captured = await captureBody(response)
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }

    if (claimed !== undefined) {
      try {
        // A 5xx is never stored, and neither is a status the mock itself
        // injected rather than the operation genuinely answering with — an
        // open circuit's `then: 429` is exactly that. Storing either would
        // make every retry replay the injected failure until the TTL expired,
        // defeating the retry the idempotency key exists to make safe. §2.6
        // draws the line at "did the mock invent this," not at a status
        // threshold. Releasing the key on a throw is the other half of the
        // wedge fix from the phases 7-9 design §2.4 — the TTL covers a
        // process that dies, this covers a callback that threw.
        if (
          trace.error !== undefined ||
          response.status >= 500 ||
          trace.ctx?.decisions.failure === 'injected'
        ) {
          await store.delete(claimed.key)
        } else {
          await store.set(
            claimed.key,
            {
              state: 'done',
              fingerprint: claimed.fingerprint,
              status: response.status,
              headers: headersOf(response),
              body: captured
            },
            idempotency.ttlMs
          )
        }
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }

    if (options.onLog !== undefined) {
      try {
        const url = new URL(request.url)
        emitLog(
          options.onLog,
          {
            ts: startedAt,
            durationMs: now() - startedAt,
            requestId:
              trace.ctx?.requestId ?? trace.requestId ?? requestIdFor(trace.requestKey, 0),
            method: request.method,
            // A bounded value rather than the raw path: an unmatched path is
            // unbounded, and this field is meant to be safe as a metric tag.
            route: trace.operation?.path ?? trace.route ?? '<unmatched>',
            path: url.pathname,
            status: response.status,
            bytesIn: trace.bytesIn,
            bytesOut: captured === null ? 0 : encoder.encode(captured).length,
            params: trace.params,
            query: trace.ctx?.query ?? {},
            seed,
            operationId: trace.operation?.operationId,
            decisions: trace.ctx?.decisions ?? {},
            error:
              trace.error === undefined
                ? undefined
                : trace.error instanceof Error
                  ? trace.error.message
                  : String(trace.error),
            custom: trace.ctx?.log ?? {}
          },
          options.onError
        )
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }

    // Destination tier 2. Only for a response the operation actually accepted:
    // a 401 has not subscribed to anything, and capturing from one would let an
    // unauthenticated caller redirect another tenant's webhooks. Doing it here
    // rather than mid-pipeline also means `$response.*` and `$statusCode`
    // resolve, because the result exists.
    if (trace.operation !== undefined && response.status < 400) {
      try {
        const entry = callbacks.find((candidate) => candidate.operation === trace.operation)
        // One rule list, one pass: the ordering between a callback capture and
        // a registration write is decided by rule order rather than by which
        // feature's block happens to run first (design §2).
        const rules: CaptureRule[] = [
          ...(entry?.rules ?? []),
          ...(registryRules.get(trace.operation) ?? []),
          // A `link` rule's `from` operation records here, under exactly the
          // same `status < 400` precondition and inside exactly the same
          // try/catch as the destination tiers above it.
          ...(linkCaptureRules.get(trace.operation) ?? [])
        ]
        if (rules.length > 0) {
          const responseBody = parseBodyText(captured, response)
          const exprInput = {
            request,
            url: new URL(request.url),
            method: request.method,
            params: trace.params,
            body: trace.ctx?.body,
            result: {
              status: response.status,
              headers: headersOf(response),
              body: responseBody
            }
          }
          await runCapture({
            rules,
            expr: exprInput,
            store,
            registry,
            link: linkTable,
            responseBody,
            requestBody: trace.ctx?.body
          })
        }
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }

    // Trigger two. Fires only for a response the operation actually
    // succeeded at producing — the same reasoning as the callback-capture
    // block above, applied more strongly: capturing a redirected destination
    // is a data-integrity risk, but sending a signed outbound request that
    // announces a 401, a failed validation, an injected failure, or the
    // boundary 500 announces something that never happened. The idempotency
    // clause is finding I4: a replayed request must produce zero additional
    // deliveries, since the whole point of the key is that a client retry has
    // no further effect. Registered inside this same guard, so a throw in an
    // emit override, in signing, or in delivery reaches `onError` and can
    // never reach the response the caller already holds.
    if (
      trace.emits !== undefined &&
      trace.emits.length > 0 &&
      !closed &&
      trace.error === undefined &&
      response.status < 400 &&
      trace.ctx?.decisions.failure !== 'injected' &&
      trace.ctx?.decisions.idempotency !== 'replayed'
    ) {
      try {
        const ctx = trace.ctx
        if (ctx !== undefined) {
          // `createContext` returns a plain object whose methods are own
          // properties, so a spread carries `respond`, `deny`, and `seq` across
          // intact. `result` is added rather than assigned into `ctx`, so the
          // request context every other consumer holds is left untouched.
          //
          // This synchronous construction is now inside the same try/catch as
          // the delivery loop below it, matching the callback-capture block
          // above. It is unreachable today — nothing here throws — but it was
          // the one seam at this exit left asymmetric with its sibling.
          const emitCtx: EmitCtx = {
            ...ctx,
            result: {
              status: response.status,
              headers: headersOf(response),
              body: parseBodyText(captured, response)
            }
          }
          const at = generation
          // An operation-linked emit HAS the triggering request, so a
          // configured `scopeBy` resolves normally here — design §3.4's first
          // case. Resolved once, before the delayed emissions fan out, so a
          // later request cannot change which registration this one addresses.
          const scopeFor = (webhook: string): string | undefined => {
            const expression = scopeExpressions.get(webhook)
            if (expression === undefined) return undefined
            const resolved = resolveExpression(expression, {
              request,
              url: new URL(request.url),
              method: request.method,
              params: trace.params,
              body: ctx.body,
              result: emitCtx.result
            })
            // A scope that does not resolve addresses the unscoped
            // registration, which is the same place `mock.emit(name)` lands.
            // Finding nothing there is `unresolved`, never a cross-tenant send.
            return resolved.ok ? resolved.value : ''
          }
          const scopes = new Map<string, string | undefined>(
            trace.emits.map((emit) => [emit.webhook, scopeFor(emit.webhook)])
          )
          for (const emit of trace.emits) {
            track((async () => {
              try {
                const delay = typeof emit.afterMs === 'function' ? emit.afterMs(emitCtx) : emit.afterMs
                if (delay !== undefined && delay > 0) {
                  // Raced rather than plainly awaited: whichever `sleep` is in
                  // play, `close()` resolving `closedSignal` unblocks this
                  // promptly instead of waiting out the real delay.
                  await Promise.race([emitSleep(delay), closedSignal])
                }
                // A reset or a close while this was waiting invalidates it.
                if (closed || at !== generation) return
                await runEmit(emit.webhook, {
                  body: emit.body,
                  ctx: emitCtx,
                  scope: scopes.get(emit.webhook)
                })
              } catch (error) {
                reportError(options.onError, markCallback(error), emitCtx)
              }
            })())
          }
        }
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }

    return response
  }

  return {
    fetch: handle,
    store,
    setSeed(next) {
      seed = next
    },
    async reset() {
      seed = options.seed ?? 'mockingham'
      counters.reset()
      virtualClock.reset()
      chaosCounts.clear()
      requestOrdinals.clear()
      generation += 1
      deliveryLog.clear()
      // The values live in the Store that `clear()` below wipes; this drops the
      // process-local eviction index that tracks them.
      linkTable?.clear()
      await store.clear()
    },
    emit: (name, opts = {}) => {
      // Finding I2. The imperative trigger used to call `runEmit` directly,
      // untracked — `settled()` and `close()` genuinely waited only for the
      // operation-linked path, contradicting both docstrings and design §2.3.
      if (closed) {
        return Promise.reject(new Error(
          'mockingham: emit() was called after close(). The handler has ' +
            'stopped accepting new emissions.'
        ))
      }
      const delivery = runEmit(name, opts)
      // The tracked promise never itself rejects — track()/settled() only
      // need to know when the emission has settled, not how. The caller's own
      // `delivery` promise is unaffected and still rejects on, e.g., an
      // undeclared webhook name.
      track(delivery.then(() => undefined, () => undefined))
      return delivery
    },
    redeliver: (id) => {
      // A redelivery is an emission, so it obeys the same close() rule and is
      // tracked the same way — otherwise settled() would race past it.
      if (closed) {
        return Promise.reject(new Error(
          'mockingham: redeliver() was called after close(). The handler has ' +
            'stopped accepting new emissions.'
        ))
      }
      const delivery = runRedeliver(id)
      track(delivery.then(() => undefined, () => undefined))
      return delivery
    },
    deliveries: () => deliveryLog.all(),
    clearDeliveries: () => deliveryLog.clear(),
    registrations: (webhook) => registry.all(webhook),
    register: (webhook, url, scope) => registry.register(webhook, url, scope),
    unregister: (webhook, scope) => registry.unregister(webhook, scope),
    settled,
    async close() {
      closed = true
      resolveClosedSignal()
      // Clearing without resolving would leave each timer's own promise
      // pending forever; resolving it is what lets the event loop close
      // rather than merely letting `close()`'s own await resolve via the
      // race above.
      for (const entry of pendingTimers) {
        clearTimeout(entry.handle)
        entry.resolve()
      }
      pendingTimers.clear()
      await settled()
    }
  }
}

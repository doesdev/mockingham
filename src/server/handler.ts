import { createRouter } from '../spec/routes.ts'
import type { Api, Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { parseBody } from '../runtime/body.ts'
import { renderResponse } from '../runtime/render.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, EmitCtx, Fail, OverrideNode, Resolvers, Stage } from '../runtime/types.ts'
import { isSupported, resolveExpression } from '../webhooks/expr.ts'
import { callbackKey } from '../webhooks/emit.ts'
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
import { emitWebhook, resolveWebhook, createDeliveryLog } from '../webhooks/emit.ts'
import type { WebhookConfig, ResolvedWebhook } from '../webhooks/emit.ts'
import type { Delivery } from '../webhooks/deliver.ts'

export type { EmitConfig, OperationConfig, StatusConfig } from '../runtime/config.ts'

/** Passed to `Handler.emit` — the imperative trigger. */
export interface EmitOptions {
  /** Destination tier 1: wins over a captured or configured url. */
  to?: string
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
   * silently never firing.
   */
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  /** Oldest first. */
  deliveries(): Delivery[]
  clearDeliveries(): void
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
  onLog?: LogSink
  onError?: ErrorSink
  /**
   * Where startup warnings go — an unsupported runtime expression, for one.
   * Injectable so a test can assert on it without capturing the console, and
   * so an embedding application can route it.
   */
  onWarn?: (message: string) => void
  webhooks?: Record<string, WebhookConfig>
  /** Capture every delivery without sending it. See the webhooks design §2.6. */
  captureOnly?: boolean
  /** Injectable so the suite never reaches the network. */
  fetch?: typeof fetch
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

  const now = options.now ?? (() => Date.now())
  // One clock for the store and the log, so a fake clock in a test drives both.
  const store = options.store ?? createMemoryStore(now)
  const idempotency = resolveIdempotency(options.idempotency)
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
  const callbacks = api.operations.map((operation) => ({
    operation,
    specs: operation.callbacks.filter((callback) => {
      if (isSupported(callback.expression)) return true
      warn(
        `mockingham: callback "${callback.name}" on ` +
          `${operation.method.toUpperCase()} ${operation.path} uses the runtime ` +
          `expression ${callback.expression}, which is outside the supported ` +
          'subset. It will not capture a destination.'
      )
      return false
    })
  }))

  const webhookConfigs = new Map<string, ResolvedWebhook>()
  for (const [name, config] of Object.entries(options.webhooks ?? {})) {
    webhookConfigs.set(name, resolveWebhook(config))
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
    opts: { to?: string; body?: OverrideNode; ctx?: unknown } = {}
  ): Promise<Delivery> {
    const delivery = await emitWebhook({
      name,
      api,
      config: webhookConfigs.get(name) ?? resolveWebhook(),
      store,
      captureOnly: options.captureOnly === true,
      seed,
      rng: createRng(`${seed}|webhook|${name}|${counters.next(`webhook|${name}`)}`),
      generateOptions: {
        maxDepth: options.maxDepth,
        preferExamples: options.preferExamples,
        resolvers,
        schemaNames: api.schemaNames
      },
      fetch: doFetch,
      sleep,
      now,
      to: opts.to,
      bodyOverride: opts.body,
      ctx: opts.ctx
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
          schemaNames: api.schemaNames
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

    const responders = createResponders({
      operation,
      request,
      staticStatus: config.status,
      key,
      generateOptions: {
        maxDepth: options.maxDepth,
        preferExamples: options.preferExamples,
        resolvers,
        schemaNames: api.schemaNames
      },
      // ctx is declared just below; this getter is only invoked later (inside
      // generateValue, at generation time), by which point the assignment has
      // already run — the same deferral the old inline closure relied on.
      ctx: () => ctx
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

    return await renderResponse({
      ctx,
      chosen,
      bodyOverrides: config.bodies(chosen.status),
      headerOverrides: config.headers(chosen.status),
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
            operationId: operation.operationId
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
    const needsBody =
      claimed !== undefined || options.onLog !== undefined || hasCallbacks || hasEmits
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
        if (entry !== undefined && entry.specs.length > 0) {
          const exprInput = {
            request,
            url: new URL(request.url),
            method: request.method,
            params: trace.params,
            body: trace.ctx?.body,
            result: {
              status: response.status,
              headers: headersOf(response),
              body: parseBodyText(captured, response)
            }
          }
          for (const callback of entry.specs) {
            const resolved = resolveExpression(callback.expression, exprInput)
            if (resolved.ok) await store.set(callbackKey(callback.name), resolved.value)
          }
        }
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }

    // Trigger two. Registered inside the exit's guard, so a throw in an emit
    // override, in signing, or in delivery reaches `onError` and can never
    // reach the response the caller already holds.
    if (trace.emits !== undefined && trace.emits.length > 0 && !closed) {
      const ctx = trace.ctx
      if (ctx !== undefined) {
        // `createContext` returns a plain object whose methods are own
        // properties, so a spread carries `respond`, `deny`, and `seq` across
        // intact. `result` is added rather than assigned into `ctx`, so the
        // request context every other consumer holds is left untouched.
        const emitCtx: EmitCtx = {
          ...ctx,
          result: {
            status: response.status,
            headers: headersOf(response),
            body: parseBodyText(captured, response)
          }
        }
        const at = generation
        for (const emit of trace.emits) {
          track((async () => {
            try {
              const delay = typeof emit.afterMs === 'function' ? emit.afterMs(emitCtx) : emit.afterMs
              if (delay !== undefined && delay > 0) await sleep(delay)
              // A reset or a close while this was waiting invalidates it.
              if (closed || at !== generation) return
              await runEmit(emit.webhook, { body: emit.body, ctx: emitCtx })
            } catch (error) {
              reportError(options.onError, markCallback(error), emitCtx)
            }
          })())
        }
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
      chaosCounts.clear()
      requestOrdinals.clear()
      generation += 1
      deliveryLog.clear()
      await store.clear()
    },
    emit: (name, opts = {}) => runEmit(name, opts),
    deliveries: () => deliveryLog.all(),
    clearDeliveries: () => deliveryLog.clear(),
    settled,
    async close() {
      closed = true
      await settled()
    }
  }
}

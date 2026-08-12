import { createRouter } from '../spec/routes.ts'
import type { Api, Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { parseBody } from '../runtime/body.ts'
import { renderResponse } from '../runtime/render.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, Fail, OverrideNode, Resolvers, Stage } from '../runtime/types.ts'
import { compileConfigs, resolveConfigs } from '../runtime/config.ts'
import type { OperationConfig, StatusConfig } from '../runtime/config.ts'
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

export type { OperationConfig, StatusConfig } from '../runtime/config.ts'

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
   * THE SINGLE EXIT. Every response leaves through here — a 404 built before any
   * operation was known, a body-parse 400, a stage short-circuit, a rendered
   * body, and the boundary 500 alike. Stage 11 (idempotency capture, then the
   * log record) hangs off this one point; that is the whole reason `produce` was
   * split out. See the phases 7-9 design §1.
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
    const needsBody = claimed !== undefined || options.onLog !== undefined
    // The body is read at most once, from a clone, and only when something
    // needs it: an idempotency record to store, or a `bytesOut` to report.
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
      await store.clear()
    }
  }
}

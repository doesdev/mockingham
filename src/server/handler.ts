import { createRouter } from '../spec/routes.ts'
import type { Api, Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { parseBody } from '../runtime/body.ts'
import { renderResponse } from '../runtime/render.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, OverrideNode, Resolvers } from '../runtime/types.ts'
import type { Stage } from '../runtime/types.ts'
import { compileConfigs, resolveConfigs } from '../runtime/config.ts'
import type { OperationConfig, StatusConfig } from '../runtime/config.ts'
import { preferred } from '../runtime/select.ts'
import { envelope, isCallbackError, markCallback, buildError } from '../runtime/errors.ts'
import type { ErrorBodyMode } from '../runtime/errors.ts'
import { validateRequest } from '../runtime/validate.ts'
import { checkAuth } from '../runtime/auth.ts'
import type { AuthConfig } from '../runtime/auth.ts'
import { createResponders } from '../runtime/pipeline.ts'

export type { OperationConfig, StatusConfig } from '../runtime/config.ts'

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
}

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
): (request: Request) => Promise<Response> {
  const router = createRouter(api.operations)
  const seed = options.seed ?? 'mockingham'
  const resolvers = compileResolvers(options.resolvers)

  const compiled = compileConfigs(options.operations, api.operations)

  const counters: Counters = createCounters()

  const mode: ErrorBodyMode = options.errorBody ?? 'contract'

  const fail = (
    operation: Operation | undefined,
    status: number,
    code: string,
    message: string,
    key: string,
    ctx?: unknown,
    errors?: Array<{ path: string; message: string }>
  ): Promise<Response> =>
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

  async function run(request: Request): Promise<Response> {
    // Stage 1 — route match.
    const url = new URL(request.url)
    const matched = router.match(request.method, url.pathname)

    if (!matched) {
      const allowed = router.allowedMethods(url.pathname)
      if (allowed.length > 0) {
        const response = await fail(
          undefined,
          405,
          'MOCK_METHOD_NOT_ALLOWED',
          `Allowed methods: ${allowed.join(', ')}`,
          seed
        )
        response.headers.set('allow', allowed.join(', '))
        return response
      }
      return await fail(undefined, 404, 'MOCK_NOT_FOUND', `No operation for ${url.pathname}`, seed)
    }

    const { operation, params } = matched
    const config = resolveConfigs(operation, compiled)

    // Stage 2 — body parse and content negotiation.
    const parsed = await parseBody(request, operation)
    if (!parsed.ok) {
      return await fail(operation, parsed.status, parsed.code, parsed.message, requestKey(operation, params, seed))
    }

    // Stages 3 and 4 (auth, validation) are built below, once ctx exists.
    // Stages 5 and 6 (idempotency, failure) arrive with plan 4.

    const key = requestKey(operation, params, seed)
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

    const ctx: Ctx = createContext({
      request,
      url,
      operation,
      params,
      body: parsed.body.value,
      mediaType: parsed.body.mediaType,
      rng: responders.rngFor('ctx'),
      requestKey: key,
      counters,
      generate: responders.generate,
      example: responders.example
    })

    // Stages 3 through 6. Auth runs before validation so an unauthenticated
    // caller cannot learn whether their body was well-formed; idempotency and
    // failure policy arrive in plan 4. Each stage may return a Response to
    // short-circuit the rest.
    const stages: Stage[] = []

    // Stage 3 — auth.
    stages.push(async (current) => {
      const outcome = await checkAuth({
        security: operation.security,
        schemes: api.securitySchemes,
        config: options.auth ?? {},
        ctx: current
      })
      if (outcome.ok) {
        current.auth = outcome.principal
        return undefined
      }
      if (outcome.response) return outcome.response
      return await fail(
        operation, outcome.status, outcome.code, outcome.message, key, current
      )
    })

    // Stage 4 — request validation.
    if (options.validateRequests !== false) {
      stages.push(async (current) => {
        const result = validateRequest(current, operation)
        if (result.ok) return undefined
        return await fail(
          operation,
          400,
          'MOCK_REQUEST_INVALID',
          'Request does not match the declared schema',
          key,
          current,
          result.errors
        )
      })
    }

    for (const stage of stages) {
      const short = await stage(ctx)
      if (short) return short
    }

    // Stage 7 — status selection, now that every short-circuiting stage has run.
    const selected = responders.selection()
    if (!selected) {
      return await fail(
        operation,
        501,
        'MOCK_NO_RESPONSE',
        `Operation ${operation.method} ${operation.path} declares no responses`,
        key,
        ctx
      )
    }
    const chosen = selected.spec

    // Stage 10 — the full response callback replaces stages 7 through 10.
    // It runs after ctx exists so the callback can reach ctx.generate and
    // ctx.example, which trigger selection on demand.
    if (config.respond) {
      try {
        return await config.respond(ctx)
      } catch (error) {
        throw markCallback(error)
      }
    }

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
   * The single failure boundary. Every user callback — resolvers, override
   * functions, header overrides, response callbacks — runs somewhere inside
   * `run`, and invariant 4 says the mock keeps serving whatever they do. One
   * catch here rather than one per leaf: a per-leaf catch would let a
   * half-built body reach the client as if it were real.
   */
  return async function handle(request: Request): Promise<Response> {
    try {
      return await run(request)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      const headers = new Headers()
      if (options.debugHeaders) {
        // Header values cannot carry line breaks, and a thrown message might.
        headers.set('x-mock-error', message.replace(/[\r\n]+/g, ' '))
      }
      const code = isCallbackError(error) ? 'MOCK_CALLBACK_FAILED' : 'MOCK_INTERNAL'
      return Response.json(envelope(code, message), { status: 500, headers })
    }
  }
}

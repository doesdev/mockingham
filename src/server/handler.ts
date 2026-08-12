import { createRouter } from '../spec/routes.ts'
import type { Api, Operation } from '../spec/types.ts'
import { generateValue } from '../generate/generate.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import type { Rng } from '../generate/rng.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { parseBody } from '../runtime/body.ts'
import { renderResponse } from '../runtime/render.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, OverrideNode, Resolvers } from '../runtime/types.ts'
import type { Stage } from '../runtime/types.ts'
import { compileConfigs, resolveConfigs } from '../runtime/config.ts'
import type { OperationConfig, StatusConfig } from '../runtime/config.ts'
import { preferred, selectResponse } from '../runtime/select.ts'
import { envelope, isCallbackError, markCallback, buildError } from '../runtime/errors.ts'
import type { ErrorBodyMode } from '../runtime/errors.ts'
import { validateRequest } from '../runtime/validate.ts'
import { checkAuth } from '../runtime/auth.ts'
import type { AuthConfig } from '../runtime/auth.ts'

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

const JSON_TYPE = 'application/json'

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
        return new Response(null, {
          status: 405,
          headers: { allow: allowed.join(', ') }
        })
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

    // Stage 7 — status selection.
    const key = requestKey(operation, params, seed)
    const exampleName = preferred(request, 'example')
    const selected = selectResponse(operation, request, config.status)

    if (!selected) {
      return await fail(
        operation,
        501,
        'MOCK_NO_RESPONSE',
        `Operation ${operation.method} ${operation.path} declares no responses`,
        key
      )
    }

    const chosen = selected.spec
    const source = selected.source
    const generateOptions: GenerateOptions = {
      maxDepth: options.maxDepth,
      preferExamples: options.preferExamples,
      resolvers,
      schemaNames: api.schemaNames
    }

    const rngFor = (label: string): Rng => createRng(`${key}|${label}`)

    const mediaFor = (status: number) =>
      operation.responses.find((r) => r.status === status)?.content[JSON_TYPE]

    const generateFor = (status?: number): unknown => {
      const target = status === undefined ? chosen.status : status
      const media = mediaFor(target)
      if (!media) return undefined
      return generateValue(media.schema, rngFor(String(target)), {
        ...generateOptions,
        ctx
      })
    }

    const exampleFor = (status?: number, name?: string): unknown => {
      const media = mediaFor(status === undefined ? chosen.status : status)
      if (!media) return undefined
      if (name === undefined) return media.example
      return media.examples?.[name]?.value
    }

    const ctx: Ctx = createContext({
      request,
      url,
      operation,
      params,
      body: parsed.body.value,
      rng: rngFor('ctx'),
      requestKey: key,
      counters,
      generate: generateFor,
      example: exampleFor
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

    // Stage 10 — the full response callback replaces stages 7 through 10.
    // It runs after ctx exists so the callback can reach ctx.generate and
    // ctx.example, both of which are bound to the selected response.
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
      rngFor,
      generateOptions,
      exampleName,
      generate: generateFor,
      example: exampleFor,
      debug: options.debugHeaders
        ? {
            seed: String(fnv1a(key)),
            source,
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

import { createRouter } from '../spec/routes.ts'
import type { Api, Operation, ResponseSpec } from '../spec/types.ts'
import { generateValue } from '../generate/generate.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import type { Rng } from '../generate/rng.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { compileTarget, resolveTarget } from '../resolve/target.ts'
import { applyOverrides } from '../resolve/layer.ts'
import { parseBody } from '../runtime/body.ts'
import { buildHeaders } from '../runtime/headers.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, OverrideNode, Resolvers } from '../runtime/types.ts'

export interface StatusConfig {
  body?: OverrideNode
  headers?: Record<string, OverrideNode>
}

export type OperationConfig = {
  status?: number
  respond?: (ctx: Ctx) => Response | Promise<Response>
} & { [status: number]: StatusConfig }

export interface HandlerOptions {
  seed?: string
  maxDepth?: number
  preferExamples?: boolean
  debugHeaders?: boolean
  resolvers?: Resolvers
  headers?: Record<string, OverrideNode>
  operations?: Record<string, OperationConfig>
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

function preferred(request: Request, key: string): string | undefined {
  const header = request.headers.get('prefer')
  if (header === null) return undefined
  const matched = new RegExp(`${key}=([^;,\\s]+)`).exec(header)
  return matched?.[1]
}

/**
 * Every configured target that matches, in declaration order.
 *
 * These are deliberately not merged into one config object. A broad target and
 * a specific one both setting `200.body` must layer — the specific one refining
 * the broad one's result — and merging with Object.assign would drop the broad
 * body entirely. Body overrides are instead applied in sequence below.
 */
function matchingConfigs(
  operation: Operation,
  compiled: Array<{ matches(op: Operation): boolean; config: OperationConfig }>
): OperationConfig[] {
  return compiled
    .filter((entry) => entry.matches(operation))
    .map((entry) => entry.config)
}

export function createHandler(
  api: Api,
  options: HandlerOptions = {}
): (request: Request) => Promise<Response> {
  const router = createRouter(api.operations)
  const seed = options.seed ?? 'mockingham'
  const resolvers = compileResolvers(options.resolvers)

  // Targets are validated here so a typo fails at construction rather than
  // silently never firing.
  const compiled = Object.entries(options.operations ?? {}).map(
    ([target, config]) => {
      resolveTarget(target, api.operations)
      return { matches: compileTarget(target).matches, config }
    }
  )

  const counters: Counters = createCounters()

  return async function handle(request: Request): Promise<Response> {
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
      return Response.json(
        {
          error: {
            code: 'MOCK_NOT_FOUND',
            message: `No operation for ${url.pathname}`
          }
        },
        { status: 404 }
      )
    }

    const { operation, params } = matched
    const configs = matchingConfigs(operation, compiled)

    // For the scalar settings, the last matching config that defines one wins.
    let staticStatus: number | undefined
    let respond: OperationConfig['respond']
    for (const entry of configs) {
      if (entry.status !== undefined) staticStatus = entry.status
      if (entry.respond !== undefined) respond = entry.respond
    }

    // Stage 2 — body parse and content negotiation.
    const parsed = await parseBody(request, operation)
    if (!parsed.ok) {
      return Response.json(
        { error: { code: parsed.code, message: parsed.message } },
        { status: parsed.status }
      )
    }

    // Stages 3, 4, 5, and 6 (auth, validation, idempotency, failure) arrive
    // with plans 3 and 4.

    // Stage 7 — status selection.
    const key = requestKey(operation, params, seed)
    const wanted = preferred(request, 'status')
    const exampleName = preferred(request, 'example')

    let source = 'default'
    let spec: ResponseSpec | undefined
    if (wanted !== undefined) {
      spec = operation.responses.find((r) => r.status === Number.parseInt(wanted, 10))
      if (spec) source = 'prefer'
    }
    if (!spec && staticStatus !== undefined) {
      spec = operation.responses.find((r) => r.status === staticStatus)
      if (spec) source = 'config'
    }
    if (!spec) {
      spec =
        operation.responses.find((r) => r.status >= 200 && r.status < 300) ??
        operation.responses[0]
    }

    if (!spec) {
      return Response.json(
        {
          error: {
            code: 'MOCK_NO_RESPONSE',
            message: `Operation ${operation.method} ${operation.path} declares no responses`
          }
        },
        { status: 501 }
      )
    }

    const chosen = spec
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

    // Stage 8 — generate the body.
    // Collect this status's overrides across every matching config. Bodies stay
    // a list so they layer; headers are flat, so a shallow merge in declaration
    // order is already the right precedence.
    const bodyOverrides: OverrideNode[] = []
    let headerOverrides: Record<string, OverrideNode> = {}
    for (const entry of configs) {
      const forStatus = entry[chosen.status]
      if (forStatus === undefined) continue
      if (forStatus.body !== undefined) bodyOverrides.push(forStatus.body)
      if (forStatus.headers) {
        headerOverrides = { ...headerOverrides, ...forStatus.headers }
      }
    }

    const headers = await buildHeaders({
      spec: chosen,
      globals: options.headers,
      resolvers,
      overrides: headerOverrides,
      ctx,
      rngFor: (name) => rngFor(`header|${name}`),
      generateOptions: { ...generateOptions, ctx }
    })

    if (options.debugHeaders) {
      headers.set('x-mock-seed', String(fnv1a(key)))
      headers.set('x-mock-status-source', source)
      if (operation.operationId) {
        headers.set('x-mock-operation', operation.operationId)
      }
    }

    let body: unknown
    if (exampleName !== undefined) {
      body = exampleFor(chosen.status, exampleName)
    }
    // Deliberately the same call ctx.generate(status) makes, rather than a
    // second copy of it — a response callback and the pipeline must never
    // produce different bodies for the same status.
    if (body === undefined) body = generateFor(chosen.status)

    // Stage 9 — apply the override layers, broad targets first so specific ones
    // refine their result rather than replacing it.
    if (bodyOverrides.length === 0) {
      // Still worth one pass: resolvers may have left promises in the tree.
      if (body !== undefined) body = await applyOverrides(body, undefined, ctx)
    } else {
      for (const override of bodyOverrides) {
        body = await applyOverrides(body, override, ctx)
      }
    }

    if (body === undefined) {
      return new Response(null, { status: chosen.status, headers })
    }

    // Layer 5 — transport headers, applied last so nothing can override them.
    // Content-Length is left to Response, per design amendment 1.4.
    headers.set('content-type', JSON_TYPE)
    return new Response(JSON.stringify(body), { status: chosen.status, headers })
  }
}

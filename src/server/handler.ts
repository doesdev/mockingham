import { createRouter } from '../spec/routes.ts'
import type { Api, Operation, ResponseSpec } from '../spec/types.ts'
import { generateValue } from '../generate/generate.ts'
import { createRng, fnv1a } from '../generate/rng.ts'

export interface HandlerOptions {
  seed?: string
  maxDepth?: number
  preferExamples?: boolean
  debugHeaders?: boolean
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

function preferredStatus(request: Request): number | undefined {
  const header = request.headers.get('prefer')
  if (!header) return undefined
  const matched = /status=(\d{3})/.exec(header)
  return matched ? Number.parseInt(matched[1] as string, 10) : undefined
}

function selectResponse(
  operation: Operation,
  request: Request
): ResponseSpec | undefined {
  const wanted = preferredStatus(request)
  if (wanted !== undefined) {
    const found = operation.responses.find((r) => r.status === wanted)
    if (found) return found
  }
  const success = operation.responses.find((r) => r.status >= 200 && r.status < 300)
  return success ?? operation.responses[0]
}

export function createHandler(
  api: Api,
  options: HandlerOptions = {}
): (request: Request) => Promise<Response> {
  const router = createRouter(api.operations)
  const seed = options.seed ?? 'mockingham'
  const generateOptions = {
    maxDepth: options.maxDepth,
    preferExamples: options.preferExamples
  }

  return async function handle(request: Request): Promise<Response> {
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
        { error: { code: 'MOCK_NOT_FOUND', message: `No operation for ${url.pathname}` } },
        { status: 404 }
      )
    }

    const { operation, params } = matched
    const spec = selectResponse(operation, request)
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

    const key = requestKey(operation, params, seed)
    const headers = new Headers()

    for (const [name, schema] of Object.entries(spec.headers)) {
      const value = generateValue(schema, createRng(`${key}|header|${name}`), generateOptions)
      if (value !== null && value !== undefined) headers.set(name, String(value))
    }

    if (options.debugHeaders) {
      headers.set('x-mock-seed', String(fnv1a(key)))
      if (operation.operationId) headers.set('x-mock-operation', operation.operationId)
    }

    const media = spec.content[JSON_TYPE]
    if (!media) {
      return new Response(null, { status: spec.status, headers })
    }

    const body = generateValue(
      media.schema,
      createRng(`${key}|${spec.status}`),
      generateOptions
    )
    headers.set('content-type', JSON_TYPE)
    return new Response(JSON.stringify(body), { status: spec.status, headers })
  }
}

import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'
import { createCompiler } from '../../schema/compile.ts'
import { toJsonSchema } from '../../schema/json-schema.ts'
import type { Operation, Parameter, Schema } from '../../spec/types.ts'
import { createRng } from '../../generate/rng.ts'
import { generateValue } from '../../generate/generate.ts'

// One compiler for the module: compilation is pure and its cache is a win
// across calls. It holds no per-request state.
const compiler = createCompiler()

export function findOperation(
  ctx: McpContext,
  args: Record<string, unknown>
): Operation {
  const operationId = args.operationId as string | undefined
  const method = (args.method as string | undefined)?.toLowerCase()
  const path = args.path as string | undefined

  if (operationId !== undefined) {
    const found = ctx.api.operations.find((op) => op.operationId === operationId)
    if (found === undefined) {
      throw new Error(
        `mockingham: no operation with operationId "${operationId}". ` +
          'Call list_operations to see what this document declares.'
      )
    }
    return found
  }
  if (method !== undefined && path !== undefined) {
    const found = ctx.api.operations.find((op) => op.method === method && op.path === path)
    if (found === undefined) {
      throw new Error(
        `mockingham: no operation for ${method.toUpperCase()} ${path}. ` +
          'The path must be the templated form, for example /orders/{orderId}.'
      )
    }
    return found
  }
  throw new Error(
    'mockingham: identify the operation with either operationId, or both method and path.'
  )
}

function contentSchemas(
  content: Record<string, { schema: Schema; example?: unknown }> | undefined
): Record<string, unknown> | undefined {
  if (content === undefined) return undefined
  const out: Record<string, unknown> = {}
  // Sorted: media type keys come from an object, and invariant 2 forbids
  // letting object key order decide output.
  for (const mediaType of Object.keys(content).sort()) {
    const media = content[mediaType]!
    out[mediaType] = {
      schema: toJsonSchema(media.schema, compiler) ?? {
        $comment: 'not expressible as JSON Schema; this operation is generated only'
      },
      example: media.example
    }
  }
  return out
}

const describeOperation: McpTool = {
  name: 'describe_operation',
  description:
    'The full contract for one operation: parameters, request body schema, ' +
    'every declared response schema, security requirements, and declared ' +
    'examples. Identify it by operationId, or by method and path.',
  inputSchema: {
    operationId: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional().describe('Templated form, e.g. /orders/{orderId}')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const operation = findOperation(ctx, args)
    return {
      method: operation.method.toUpperCase(),
      path: operation.path,
      operationId: operation.operationId,
      summary: operation.summary,
      description: operation.description,
      tags: operation.tags,
      parameters: operation.parameters.map((parameter) => ({
        name: parameter.name,
        location: parameter.location,
        required: parameter.required,
        schema: toJsonSchema(parameter.schema, compiler)
      })),
      requestBody: operation.requestBody
        ? {
            required: operation.requestBodyRequired === true,
            content: contentSchemas(operation.requestBody)
          }
        : undefined,
      responses: [...operation.responses]
        .sort((a, b) => a.status - b.status)
        .map((response) => ({
          status: response.status,
          description: response.description,
          content: contentSchemas(response.content),
          // Convenience: the JSON body schema most callers actually want,
          // lifted out of `content` so an agent does not have to know the
          // media-type key to find it.
          schema: response.content['application/json']
            ? toJsonSchema(response.content['application/json']!.schema, compiler)
            : undefined
        })),
      security: operation.security
    }
  }
}

const getAuthRequirements: McpTool = {
  name: 'get_auth_requirements',
  description:
    'Security schemes this API declares, and the requirements that apply — ' +
    'for one operation when operationId is given, for the document otherwise. ' +
    'An empty requirements array means the operation needs no auth.',
  inputSchema: { operationId: z.string().optional() },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const scoped = args.operationId !== undefined ? findOperation(ctx, args) : undefined
    return {
      schemes: ctx.api.securitySchemes,
      requirements: scoped?.security,
      // Stated rather than left to inference: `security: []` and an absent
      // `security` mean different things, and an agent reading `[]` should not
      // have to guess which one it is looking at.
      note:
        scoped !== undefined && Array.isArray(scoped.security) && scoped.security.length === 0
          ? 'This operation explicitly requires no authentication.'
          : undefined
    }
  }
}

const listOperations: McpTool = {
  name: 'list_operations',
  description:
    'List the operations this mock serves: method, path, operationId, summary, ' +
    'and tags. Filter with `tag` or `pathPrefix`. Start here, then call ' +
    'describe_operation for the one you are working on.',
  inputSchema: {
    tag: z.string().optional().describe('Only operations carrying this exact tag'),
    pathPrefix: z.string().optional().describe('Only operations whose path starts with this')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const tag = args.tag as string | undefined
    const pathPrefix = args.pathPrefix as string | undefined
    // Document order, which loadApi preserves. Deterministic without sorting,
    // and it keeps related operations adjacent the way the author wrote them.
    return ctx.api.operations
      .filter((operation) => tag === undefined || operation.tags.includes(tag))
      .filter((operation) => pathPrefix === undefined || operation.path.startsWith(pathPrefix))
      .map((operation) => ({
        method: operation.method.toUpperCase(),
        path: operation.path,
        operationId: operation.operationId,
        summary: operation.summary,
        tags: operation.tags
      }))
  }
}

/**
 * A path parameter the caller did not supply. Seeded on the operation and
 * parameter name and NOT on the mock's root seed: a synthesized parameter is
 * an address, not content. `set_seed` must change what `/orders/abc` returns
 * without turning it into `/orders/xyz` — otherwise every sample an agent
 * recorded stops resolving the moment anything reseeds. It also keeps fixture
 * keys stable, since fixtureKey includes params.
 *
 * Generated through the same generateValue the mock itself uses, so the value
 * satisfies the parameter's declared schema and survives request validation.
 */
function synthesizeParam(operation: Operation, parameter: Parameter): string {
  const rng = createRng(`${operation.operationId ?? operation.path}|${parameter.name}`)
  const value = generateValue(parameter.schema, rng, { schemaNames: new Map() })
  return String(value)
}

const sampleResponse: McpTool = {
  name: 'sample_response',
  description:
    'A live response for an operation, produced by the real request pipeline — ' +
    'the exact bytes your code will receive, not a schema you have to guess ' +
    'from. Path parameters you omit are filled with schema-valid values. Use ' +
    '`status` to ask for a specific declared response.',
  inputSchema: {
    operationId: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe('Path parameter values, e.g. { orderId: "abc" }'),
    query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    status: z.number().optional().describe('Ask for a specific declared status')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    const operation = findOperation(ctx, args)
    const supplied = (args.params ?? {}) as Record<string, string | number>

    let path = operation.path
    for (const parameter of operation.parameters) {
      if (parameter.location !== 'path') continue
      const value = supplied[parameter.name] !== undefined
        ? String(supplied[parameter.name])
        : synthesizeParam(operation, parameter)
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
    }

    const url = new URL(path, ctx.origin)
    const query = (args.query ?? {}) as Record<string, string | number>
    // Sorted: query keys arrive as object keys, and invariant 2 forbids object
    // key order deciding a URL that feeds generation.
    for (const name of Object.keys(query).sort()) {
      url.searchParams.set(name, String(query[name]))
    }

    const headers = new Headers((args.headers ?? {}) as Record<string, string>)
    if (args.status !== undefined) {
      // The same mechanism a real client uses (master spec section 2), so this
      // introduces no second status-selection path.
      headers.set('prefer', `status=${String(args.status)}`)
    }

    const method = operation.method.toUpperCase()
    const sendsBody = method !== 'GET' && method !== 'HEAD' && args.body !== undefined
    if (sendsBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }

    const response = await ctx.fetch(new Request(url, {
      method,
      headers,
      body: sendsBody ? JSON.stringify(args.body) : undefined
    }))

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => { responseHeaders[name] = value })
    const text = await response.text()
    const isJson = (response.headers.get('content-type') ?? '').includes('json')

    return {
      status: response.status,
      headers: responseHeaders,
      // Parsed when it is JSON so an agent reads a structure rather than an
      // escaped string; the raw text otherwise.
      body: isJson && text.length > 0 ? JSON.parse(text) : text,
      url: url.toString()
    }
  }
}

export const READ_TOOLS: McpTool[] = [
  listOperations,
  describeOperation,
  getAuthRequirements,
  sampleResponse
]

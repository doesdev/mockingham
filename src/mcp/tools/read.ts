import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'
import { createCompiler } from '../../schema/compile.ts'
import { toJsonSchema } from '../../schema/json-schema.ts'
import type { Operation, Parameter, Schema } from '../../spec/types.ts'
import { createRng } from '../../generate/rng.ts'
import { generateValue } from '../../generate/generate.ts'
import { schemaHashLookup } from '../../fixtures/source.ts'

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

/**
 * Design §5.1: a schema the converter refuses is reported as a `$comment`
 * rather than omitted, so an agent is told the shape exists and why it is not
 * shown. One helper, because three copies of the sentence would drift and a
 * fourth call site would forget it entirely.
 */
function jsonSchemaOf(schema: Schema): Record<string, unknown> {
  return toJsonSchema(schema, compiler) ?? {
    $comment: 'not expressible as JSON Schema; this operation is generated only'
  }
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
      schema: jsonSchemaOf(media.schema),
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
        schema: jsonSchemaOf(parameter.schema)
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
          // A range response carries its bucket's LOWER BOUND as `status`, so
          // `4XX` and an exactly declared `400` both report 400. Without this
          // flag they are indistinguishable to a caller.
          ...(response.range === true ? { range: true } : {}),
          description: response.description,
          content: contentSchemas(response.content),
          // Convenience: the JSON body schema most callers actually want,
          // lifted out of `content` so an agent does not have to know the
          // media-type key to find it.
          schema: response.content['application/json']
            ? jsonSchemaOf(response.content['application/json']!.schema)
            : undefined
        })),
      security: operation.security
    }
  }
}

const getAuthRequirements: McpTool = {
  name: 'get_auth_requirements',
  description:
    'The security schemes this API declares, plus — when operationId is given ' +
    '— that operation\'s own security requirements. Without operationId only ' +
    'the schemes are returned, not a document-level default. An empty ' +
    'requirements array means the operation needs no auth.',
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

const searchOperations: McpTool = {
  name: 'search_operations',
  description:
    'Free-text search over path, summary, description, and tags. Use this when ' +
    'you know what you want to do but not what it is called.',
  inputSchema: {
    query: z.string().describe('Free text; matched case-insensitively as a substring'),
    limit: z.number().int().positive().optional()
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const query = String(args.query ?? '').toLowerCase().trim()
    const limit = (args.limit as number | undefined) ?? 20
    if (query.length === 0) return []

    const scored = ctx.api.operations
      .map((operation) => {
        const haystacks = [
          operation.path,
          operation.summary ?? '',
          operation.description ?? '',
          operation.tags.join(' '),
          operation.operationId ?? ''
        ].map((text) => text.toLowerCase())

        // Ranked by WHERE it matched, not by how often: a summary hit is a
        // better answer than an incidental description hit, and an agent
        // reading the first result should get the best one.
        let score = 0
        if (haystacks[1]!.includes(query)) score += 8
        if (haystacks[4]!.includes(query)) score += 6
        if (haystacks[0]!.includes(query)) score += 4
        if (haystacks[3]!.includes(query)) score += 3
        if (haystacks[2]!.includes(query)) score += 1
        return { operation, score }
      })
      .filter((entry) => entry.score > 0)

    // Stable: equal scores keep document order, because sort() is stable in
    // Node and `scored` was built by walking operations in order.
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map((entry) => ({
      method: entry.operation.method.toUpperCase(),
      path: entry.operation.path,
      operationId: entry.operation.operationId,
      summary: entry.operation.summary,
      tags: entry.operation.tags
    }))
  }
}

const listWebhooks: McpTool = {
  name: 'list_webhooks',
  description:
    'Outbound requests this API can make — top-level webhooks and per-operation ' +
    'callbacks — with payload schemas and which operations are configured to ' +
    'emit them. An empty emittedBy means the document declares it but nothing ' +
    'fires it.',
  inputSchema: {},
  handler(ctx: McpContext) {
    const callbacks = new Map<string, { expression: string; owner: string }>()
    for (const operation of ctx.api.operations) {
      for (const callback of operation.callbacks) {
        if (callbacks.has(callback.name)) continue
        callbacks.set(callback.name, {
          expression: callback.expression,
          owner: `${operation.method.toUpperCase()} ${operation.path}`
        })
      }
    }

    // Sorted: api.webhooks is an object, and invariant 2 forbids object key
    // order deciding output.
    return Object.keys(ctx.api.webhooks).sort().map((name) => {
      const webhook = ctx.api.webhooks[name]!
      const callback = callbacks.get(name)
      const media = webhook.body?.['application/json']
      const configured = ctx.emitters.get(name) ?? []
      return {
        name,
        kind: callback === undefined ? 'webhook' : 'callback',
        method: webhook.method.toUpperCase(),
        payloadSchema: media ? toJsonSchema(media.schema, compiler) : undefined,
        // A callback's owning operation is declared in the document, so it is
        // reported whether or not anything is configured to emit it. A
        // top-level webhook has no declared owner — only config can link it.
        emittedBy: callback !== undefined && configured.length === 0
          ? [callback.owner]
          : configured,
        expression: callback?.expression
      }
    })
  }
}

const listDeliveries: McpTool = {
  name: 'list_deliveries',
  description:
    'Webhook deliveries this mock has made so far, oldest first — the feedback ' +
    'loop for verifying your own receiver. Filter by webhook name or outcome.',
  inputSchema: {
    webhook: z.string().optional(),
    outcome: z.string().optional().describe('e.g. captured, delivered, unresolved')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const webhook = args.webhook as string | undefined
    const outcome = args.outcome as string | undefined
    // Filtered here rather than by widening Mock.deliveries() — design 3.9.
    return ctx.deliveries()
      .filter((delivery) => webhook === undefined || delivery.webhook === webhook)
      .filter((delivery) => outcome === undefined || delivery.outcome === outcome)
  }
}

const listFixtures: McpTool = {
  name: 'list_fixtures',
  description:
    'What is in the fixture store: which operations and statuses have a ' +
    'stored response, when it was generated, and whether it has gone stale ' +
    'because the document changed underneath it. Values are omitted unless ' +
    'you ask for them. Pair with regenerate_fixture to refresh a stale one.',
  inputSchema: {
    operationId: z.string().optional(),
    status: z.number().int().optional(),
    includeValues: z
      .boolean()
      .optional()
      .describe('Default false — a whole document of values is a lot of tokens')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const operationId = args.operationId as string | undefined
    const status = args.status as number | undefined
    const includeValues = args.includeValues === true
    // Computed with the same helper the startup staleness check uses, so the
    // two can never disagree about what stale means.
    const hashFor = schemaHashLookup(ctx.api, compiler)

    // `records()` is already sorted — persistence depends on it writing
    // byte-identical files — so this must not re-sort by anything derived
    // from object key order.
    return ctx.fixtures()
      .filter((record) => operationId === undefined || record.operationId === operationId)
      .filter((record) => status === undefined || record.status === status)
      .map((record) => {
        const stored = record.entry.meta?.schemaHash
        return {
          operationId: record.operationId,
          status: record.status,
          key: record.key,
          generatedAt: record.entry.meta?.generatedAt,
          schemaHash: stored,
          scoped: record.entry.meta?.scoped,
          // An entry with no stored hash is NOT stale: it predates hashing, or
          // came from a schema neither path can convert. Reporting it stale
          // would send an agent regenerating something that is fine.
          stale:
            stored !== undefined &&
            stored !== hashFor(record.operationId, record.status),
          ...(includeValues ? { value: record.entry.value } : {})
        }
      })
  }
}

export const READ_TOOLS: McpTool[] = [
  listOperations,
  describeOperation,
  getAuthRequirements,
  sampleResponse,
  searchOperations,
  listWebhooks,
  listDeliveries,
  listFixtures
]

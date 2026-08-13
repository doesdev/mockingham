import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'
import { createCompiler } from '../../schema/compile.ts'
import { toJsonSchema } from '../../schema/json-schema.ts'
import type { Operation, Schema } from '../../spec/types.ts'

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

export const READ_TOOLS: McpTool[] = [listOperations, describeOperation, getAuthRequirements]

import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'

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

export const READ_TOOLS: McpTool[] = [listOperations]

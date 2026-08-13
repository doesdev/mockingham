import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import type { Mock, MockOptions } from '../../src/index.ts'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import type { McpToolOptions } from '../../src/mcp/tools/index.ts'
import { createMcpContext } from '../../src/mcp/context.ts'
import type { McpContext, McpTool } from '../../src/mcp/context.ts'
import { compileConfigs } from '../../src/runtime/config.ts'
import { mcpDoc } from './doc.ts'

/**
 * The same McpContext `createMock().mcp()` builds, from an existing Mock —
 * literally the same call, not a parallel one. Production and tests share one
 * construction path so the two cannot drift apart at the seam.
 */
export function contextForMock(mock: Mock, options: MockOptions = {}): McpContext {
  return createMcpContext(
    mock,
    compileConfigs(options.operations, mock.api.operations)
  )
}

export function contextFor(
  doc: Record<string, unknown> = mcpDoc,
  options: MockOptions = {}
): McpContext {
  return contextForMock(createMock(doc, options), options)
}

export function toolNamed(name: string, options: McpToolOptions = {}): McpTool {
  const tool = mcpTools(options).find((candidate) => candidate.name === name)
  assert.ok(tool, `no tool named ${name}`)
  return tool
}

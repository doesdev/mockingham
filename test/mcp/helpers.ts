import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import type { Mock, MockOptions } from '../../src/index.ts'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import type { McpToolOptions } from '../../src/mcp/tools/index.ts'
import { computeEmitters } from '../../src/mcp/context.ts'
import type { McpContext, McpTool } from '../../src/mcp/context.ts'
import { compileConfigs } from '../../src/runtime/config.ts'
import { mcpDoc } from './doc.ts'

/**
 * Builds the same McpContext `createMock` builds, from an existing Mock.
 * These two constructions MUST stay in step — see self-review note 1 at the
 * end of the plan. If you were able to have createMock export the context it
 * builds, delete this body and call that instead.
 */
export function contextForMock(mock: Mock, options: MockOptions = {}): McpContext {
  return {
    api: mock.api,
    fetch: (request) => mock.fetch(request),
    failNext: (target, opts) => mock.failNext(target, opts),
    outage: (target, opts) => mock.outage(target, opts),
    setSeed: (seed) => mock.setSeed(seed),
    reset: () => mock.reset(),
    emit: (name, opts) => mock.emit(name, opts),
    deliveries: () => mock.deliveries(),
    emitters: computeEmitters(
      mock.api.operations,
      compileConfigs(options.operations, mock.api.operations)
    ),
    origin: 'http://mock.local'
  }
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

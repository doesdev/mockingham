import type { McpTool } from '../context.ts'
import { READ_TOOLS } from './read.ts'

export interface McpToolOptions {
  /** Expose the write tools. Default false — design §3.7. */
  write?: boolean
}

/**
 * The tool list for one server. The write gate lives here so that both halves
 * of it — what `tools/list` advertises and what `tools/call` will accept — come
 * from one decision. A gate that only hid the tools from the listing would not
 * be a gate.
 */
export function mcpTools(options: McpToolOptions = {}): McpTool[] {
  // The write half arrives in task 7; until then there is nothing to gate.
  return [...READ_TOOLS]
}

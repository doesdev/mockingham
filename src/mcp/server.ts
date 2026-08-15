import type { McpContext, McpTool } from './context.ts'
import { mcpTools } from './tools/index.ts'
import { WRITE_TOOLS } from './tools/write.ts'

export interface McpOptions {
  /**
   * `http` mounts on the mock's own port. `inline` attaches nothing, which is
   * what a test wants. Default `inline`.
   *
   * `stdio` attaches nothing either — despite what this comment said until
   * deferred item 32 was closed, it does NOT connect immediately. Nothing here
   * or in `mcp()` branches on `'stdio'` at all; a handle only starts talking
   * JSON-RPC once the caller awaits `handle.connectStdio()`, which is what the
   * `mockingham mcp` subcommand does on their behalf. The same false claim,
   * inherited from this comment, had already reached `docs/mcp.md` once.
   */
  transport?: 'http' | 'stdio' | 'inline'
  /** http only. Default `/mcp`. */
  path?: string
  /** Expose the eight write tools. Default false — design §3.7. */
  write?: boolean
}

export interface McpServerHandle {
  /** Present only for transport `http`. */
  path?: string
  /** Serves over stdio. Node-only. */
  connectStdio(): Promise<void>
  close(): Promise<void>
  /** Handles one HTTP request. Fresh server and transport per call — see below. */
  handleRequest(request: Request): Promise<Response>
}

const MISSING_SDK =
  'mockingham: the MCP server needs @modelcontextprotocol/sdk, which is an ' +
  'optional peer dependency. Install it with:\n\n' +
  '  npm install @modelcontextprotocol/sdk\n'

interface McpServerLike {
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: Record<string, unknown> },
    cb: (args: Record<string, unknown>) => Promise<unknown>
  ): unknown
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

interface TransportLike {
  handleRequest(request: Request): Promise<Response>
  close(): Promise<void>
}

/**
 * Lazily imported so the package keeps zod as its only hard runtime
 * dependency. Only a genuinely absent module becomes the friendly message — an
 * error thrown from inside the SDK propagates as itself, because reporting a
 * broken install as a missing one sends the reader to the wrong problem.
 *
 * Every specifier is read through a non-literal variable so `tsc` cannot
 * resolve it statically — the same trick `fixtures/sources/anthropic.ts` uses,
 * and for the same reason. This package ships raw TypeScript (`main` is
 * `src/index.ts`) and `src/index.ts` imports this module statically, so a
 * literal specifier would fail a consumer's own `tsc --noEmit` with TS2307
 * whenever they skipped the optional peer dependency.
 *
 * The cost, stated plainly: a non-literal specifier types the import as `any`,
 * so the compiler NEVER checks the casts below — not even once
 * @modelcontextprotocol/sdk IS installed. `McpServerLike` and `TransportLike`
 * are therefore unverified against the real SDK; if it renames an export or
 * changes a constructor or method signature, only a runtime failure would show
 * it. Review both interfaces and these casts by hand whenever the SDK is
 * bumped. In practice that is a small bill here — both are already narrow
 * structural interfaces reached through `as never`.
 */
async function loadSdk(): Promise<{
  McpServer: new (info: { name: string; version: string }) => McpServerLike
  WebStandardStreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: undefined
    enableJsonResponse: boolean
  }) => TransportLike
}> {
  const mcpSpecifier = '@modelcontextprotocol/sdk/server/mcp.js'
  const httpSpecifier = '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
  try {
    const [mcp, http] = await Promise.all([
      import(mcpSpecifier),
      import(httpSpecifier)
    ])
    return {
      McpServer: mcp.McpServer as never,
      WebStandardStreamableHTTPServerTransport:
        http.WebStandardStreamableHTTPServerTransport as never
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(MISSING_SDK)
    }
    throw error
  }
}

function register(server: McpServerLike, context: McpContext, tools: McpTool[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        // No try/catch: the SDK already converts a throw into
        // { isError: true, content: [...] } with the message intact, which is
        // exactly what a mistyped control-plane target should produce.
        const result = await tool.handler(context, args ?? {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }
    )
  }

  // With the gate closed, a caller who knows a write tool's name gets a
  // refusal that says how to enable it, rather than the SDK's bare "not
  // found" — which reads like the feature does not exist.
  //
  // The names come from WRITE_TOOLS rather than a literal list: another write
  // tool added later must not silently lose its refusal message.
  const exposed = new Set(tools.map((tool) => tool.name))
  for (const disabled of WRITE_TOOLS.filter((tool) => !exposed.has(tool.name))) {
    server.registerTool(
      disabled.name,
      {
        description:
          `Disabled. ${disabled.name} changes the mock's runtime state, so it ` +
          'is off by default. Enable the write tools with mcp({ write: true }) ' +
          'or the --write flag.'
      },
      async () => {
        throw new Error(
          `mockingham: ${disabled.name} is a write tool and write tools are ` +
            'disabled. Enable them with mcp({ write: true }) or --write.'
        )
      }
    )
  }
}

export function createMcpServer(
  context: McpContext,
  options: McpOptions = {},
  version = '0.0.0'
): McpServerHandle {
  const tools = mcpTools({ write: options.write })
  let stdio: { server: McpServerLike; close(): Promise<void> } | undefined

  return {
    path: options.transport === 'http' ? (options.path ?? '/mcp') : undefined,

    async handleRequest(request: Request): Promise<Response> {
      const sdk = await loadSdk()
      // A fresh server and transport per request. This is required, not
      // defensive: a stateless transport throws on its second handleRequest,
      // because reuse collides message ids between clients. Our tools hold no
      // state — everything they touch lives on the Mock — so there is nothing
      // a session would remember. Registering twelve tools costs microseconds.
      const transport = new sdk.WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      const server = new sdk.McpServer({ name: 'mockingham', version })
      register(server, context, tools)
      await server.connect(transport)
      try {
        return await transport.handleRequest(request)
      } finally {
        // Verified safe: the response body survives this. Without it, every
        // request would leave a server and transport for the collector.
        await transport.close()
        await server.close()
      }
    },

    async connectStdio(): Promise<void> {
      // loadSdk() runs first, so an absent package has already produced
      // MISSING_SDK by the time this import is reached. Non-literal specifier
      // for the same reason as above, with the same unchecked-cast caveat.
      const sdk = await loadSdk()
      const stdioSpecifier = '@modelcontextprotocol/sdk/server/stdio.js'
      const { StdioServerTransport } = (await import(stdioSpecifier)) as {
        StdioServerTransport: new () => unknown
      }
      const server = new sdk.McpServer({ name: 'mockingham', version })
      register(server, context, tools)
      const transport = new StdioServerTransport()
      await server.connect(transport)
      stdio = { server, close: () => server.close() }
    },

    async close(): Promise<void> {
      await stdio?.close()
      stdio = undefined
    }
  }
}

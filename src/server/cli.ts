#!/usr/bin/env node
import { readFile as readFileFromDisk } from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { loadApi } from '../spec/load.ts'
import { createHandler } from './handler.ts'
import type { Handler } from './handler.ts'
import { createNodeServer } from './node.ts'
import { createMock } from '../index.ts'
import { bake } from '../fixtures/bake.ts'
import type { BakeSummary } from '../fixtures/bake.ts'
import { resolveLlm } from '../fixtures/config.ts'
import { createDiskFixtureStore, warnOnStaleFixtures } from '../fixtures/persist.ts'
import { schemaHashLookup } from '../fixtures/source.ts'
import type { FixtureStore } from '../fixtures/store.ts'
import { createCompiler } from '../schema/compile.ts'

export const USAGE = `mockingham — OpenAPI driven HTTP mock server

  mockingham <document.json> [options]

  --port <n>        Port to listen on (default: an ephemeral port)
  --seed <s>        Generation seed (default: mockingham)
  --fixtures <dir>  Serve committed fixture files from this directory
  --watch           Reload the document when it changes on disk
  --help, -h        Show this message

  mockingham bake <document.json> [options]   Generate fixture files
                                               (see: mockingham bake --help)

  mockingham mcp <document.json> [options]    Serve the MCP tools over stdio
                                               (see: mockingham mcp --help)

Bake once, review and commit the JSON it writes, then serve it back:

  mockingham bake ./openapi.json --fixtures ./fixtures --model llama3.3
  mockingham ./openapi.json --fixtures ./fixtures

YAML is not parsed. Convert the document to JSON first, or use createMock()
from a script and pass the parsed object in.
`

export interface CliArgs {
  document?: string
  port: number
  seed?: string
  /** Directory of committed fixture files to serve ahead of generation. */
  fixtures?: string
  watch: boolean
  help: boolean
}

const NEEDS_VALUE = new Set(['--port', '--seed', '--fixtures'])

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    document: undefined,
    port: 0,
    seed: undefined,
    fixtures: undefined,
    watch: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (token === '--watch') {
      args.watch = true
      continue
    }

    if (token.startsWith('--')) {
      // `--flag=value` and `--flag value` are both common enough that supporting
      // only one guarantees someone hits the other first.
      const split = token.indexOf('=')
      const name = split === -1 ? token : token.slice(0, split)
      if (!NEEDS_VALUE.has(name)) {
        throw new Error(`mockingham: unknown option ${name}\n\n${USAGE}`)
      }
      const value = split === -1 ? argv[++i] : token.slice(split + 1)
      if (value === undefined) {
        throw new Error(`mockingham: ${name} needs a value`)
      }
      if (name === '--port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`mockingham: --port must be a port number, got "${value}"`)
        }
        args.port = port
      } else if (name === '--fixtures') {
        args.fixtures = value
      } else {
        args.seed = value
      }
      continue
    }

    if (args.document !== undefined) {
      throw new Error(`mockingham: unexpected argument "${token}"`)
    }
    args.document = token
  }

  return args
}

export interface CliDeps {
  readFile: (path: string) => Promise<string>
  log: (message: string) => void
}

export interface CliHandle {
  url: string
  port: number
  watching: boolean
  /** Re-reads the document and swaps the handler. The watcher's only job. */
  reload(): Promise<void>
  close(): Promise<void>
}

/**
 * `startCli` is for actually serving a document, so it still treats `--help`
 * as a request it cannot fulfill — there is no `CliHandle` to hand back, and
 * changing this to a union return type would force every caller (including
 * every existing test) to narrow it. The real entry point, `import.meta.main`
 * below, checks `--help` itself before ever calling this, so the process exits
 * 0 for help without `startCli`'s contract changing. See that block's comment.
 */
export async function startCli(
  argv: string[],
  deps: Partial<CliDeps> = {}
): Promise<CliHandle> {
  const readFile = deps.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  const log = deps.log ?? ((message: string) => console.log(message))

  const args = parseArgs(argv)
  if (args.help) {
    log(USAGE)
    throw new Error('mockingham: nothing to serve')
  }
  if (args.document === undefined) {
    throw new Error(`mockingham: a document path is required\n\n${USAGE}`)
  }
  if (args.document.endsWith('.yaml') || args.document.endsWith('.yml')) {
    throw new Error(
      'mockingham: YAML documents are not parsed. Convert to JSON, or call ' +
        'createMock() from a script with the document already parsed.'
    )
  }

  const path = args.document

  const build = async (): Promise<Handler> => {
    const text = await readFile(path)
    const api = loadApi(JSON.parse(text) as Record<string, unknown>)

    // Rebuilt per build() rather than once, so a reload picks up fixture files
    // edited since startup the same way it picks up an edited document.
    let fixtures: { store: FixtureStore } | undefined
    if (args.fixtures !== undefined) {
      const store = await createDiskFixtureStore({ dir: args.fixtures, onWarn: log })
      // The same drift check createMock runs, through the same shared lookup.
      warnOnStaleFixtures(store, schemaHashLookup(api, createCompiler()), log)
      fixtures = { store }
    }

    return createHandler(api, { seed: args.seed, fixtures, onWarn: log })
  }

  let current = await build()
  // The dispatcher closes over `current` rather than over its `fetch`, so a
  // reload swaps the handler without touching the listening socket.
  const server = createNodeServer((request) => current.fetch(request))
  const address = await server.listen(args.port)

  let watcher: FSWatcher | undefined

  const handle: CliHandle = {
    url: address.url,
    port: address.port,
    watching: args.watch,
    async reload() {
      try {
        current = await build()
        log(`mockingham: reloaded ${path}`)
      } catch (error) {
        // A half-saved file must not take the server down. Keep serving the
        // last document that loaded and say why.
        const message = error instanceof Error ? error.message : String(error)
        log(`mockingham: reload failed, still serving the previous document — ${message}`)
      }
    },
    async close() {
      watcher?.close()
      await server.close()
    }
  }

  if (args.watch) {
    watcher = watch(path, () => {
      void handle.reload()
    })
  }

  log(`mockingham: serving ${path} at ${address.url}`)
  return handle
}

export const BAKE_USAGE = `mockingham bake — generate fixture files from an OpenAPI document

  mockingham bake <document.json> [options]

  --base-url <url>   OpenAI-compatible endpoint
                      (default: $MOCKINGHAM_LLM_BASE_URL, $OPENAI_BASE_URL,
                      or http://localhost:11434/v1 for a local Ollama)
  --model <name>      Model to request
                      (default: $MOCKINGHAM_LLM_MODEL or $OPENAI_MODEL; required)
  --api-key <key>     Bearer token sent with each request
                      (default: $MOCKINGHAM_LLM_API_KEY or $OPENAI_API_KEY)
  --fixtures <dir>    Where to write fixture files (default: .mockingham/fixtures)
  --persona <text>    Domain hint included in every prompt
  --help, -h          Show this message

YAML is not parsed. Convert the document to JSON first.
`

export interface BakeArgs {
  document?: string
  baseUrl?: string
  model?: string
  apiKey?: string
  fixtures?: string
  persona?: string
  help: boolean
}

const BAKE_NEEDS_VALUE = new Set([
  '--base-url',
  '--model',
  '--api-key',
  '--fixtures',
  '--persona'
])

export function parseBakeArgs(argv: string[]): BakeArgs {
  const args: BakeArgs = {
    document: undefined,
    baseUrl: undefined,
    model: undefined,
    apiKey: undefined,
    fixtures: undefined,
    persona: undefined,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }

    if (token.startsWith('--')) {
      // `--flag=value` and `--flag value` are both common enough that supporting
      // only one guarantees someone hits the other first — matches parseArgs.
      const split = token.indexOf('=')
      const name = split === -1 ? token : token.slice(0, split)
      if (!BAKE_NEEDS_VALUE.has(name)) {
        throw new Error(`mockingham: unknown option ${name}\n\n${BAKE_USAGE}`)
      }
      const value = split === -1 ? argv[++i] : token.slice(split + 1)
      if (value === undefined) {
        throw new Error(`mockingham: ${name} needs a value`)
      }
      if (name === '--base-url') args.baseUrl = value
      else if (name === '--model') args.model = value
      else if (name === '--api-key') args.apiKey = value
      else if (name === '--fixtures') args.fixtures = value
      else args.persona = value
      continue
    }

    if (args.document !== undefined) {
      throw new Error(`mockingham: unexpected argument "${token}"`)
    }
    args.document = token
  }

  return args
}

/**
 * Environment reads live here and nowhere else — the pure core takes an
 * explicit baseUrl. The Ollama default is what makes `mockingham bake doc.json`
 * work with no configuration at all.
 */
export function resolveBakeTarget(
  flags: { baseUrl?: string },
  env: Record<string, string | undefined>
): string {
  return (
    flags.baseUrl ??
    env.MOCKINGHAM_LLM_BASE_URL ??
    env.OPENAI_BASE_URL ??
    'http://localhost:11434/v1'
  )
}

/**
 * Unlike baseUrl there is no sensible default model — serving a request with
 * the wrong model silently is worse than refusing to start. So this throws,
 * naming every way to supply one, rather than falling back to something a
 * user did not choose.
 */
export function resolveBakeModel(
  flags: { model?: string },
  env: Record<string, string | undefined>
): string {
  const model = flags.model ?? env.MOCKINGHAM_LLM_MODEL ?? env.OPENAI_MODEL
  if (!model) {
    throw new Error(
      'mockingham: a model is required for bake — pass --model, or set ' +
        'MOCKINGHAM_LLM_MODEL or OPENAI_MODEL'
    )
  }
  return model
}

export function resolveBakeApiKey(
  flags: { apiKey?: string },
  env: Record<string, string | undefined>
): string | undefined {
  return flags.apiKey ?? env.MOCKINGHAM_LLM_API_KEY ?? env.OPENAI_API_KEY
}

export interface BakeDeps {
  readFile: (path: string) => Promise<string>
  log: (message: string) => void
  fetch?: typeof fetch
  now: () => number
  env: Record<string, string | undefined>
  /** Overridable so a test can prove flush() runs without touching disk. */
  createStore: (dir: string) => Promise<FixtureStore & { flush(): Promise<void> }>
}

export async function startBake(
  argv: string[],
  deps: Partial<BakeDeps> = {}
): Promise<BakeSummary> {
  const readFile = deps.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  const log = deps.log ?? ((message: string) => console.log(message))
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const createStore =
    deps.createStore ?? ((dir: string) => createDiskFixtureStore({ dir, onWarn: log }))

  const args = parseBakeArgs(argv)
  if (args.help) {
    log(BAKE_USAGE)
    throw new Error('mockingham: nothing to bake')
  }
  if (args.document === undefined) {
    throw new Error(`mockingham: a document path is required\n\n${BAKE_USAGE}`)
  }
  if (args.document.endsWith('.yaml') || args.document.endsWith('.yml')) {
    throw new Error(
      'mockingham: YAML documents are not parsed. Convert to JSON, or call ' +
        'createMock() from a script with the document already parsed.'
    )
  }

  const model = resolveBakeModel(args, env)
  const baseUrl = resolveBakeTarget(args, env)
  const apiKey = resolveBakeApiKey(args, env)
  const fixturesDir = args.fixtures ?? '.mockingham/fixtures'

  const text = await readFile(args.document)
  const api = loadApi(JSON.parse(text) as Record<string, unknown>)
  const compiler = createCompiler()

  const resolved = resolveLlm(
    { mode: 'bake', persona: args.persona, openai: { baseUrl, model, apiKey } },
    { fetch: deps.fetch }
  )
  if (!resolved || !resolved.source) {
    // Unreachable in practice — mode 'bake' with the openai-compatible
    // provider and a baseUrl always yields a source — but narrows the type
    // and fails loudly rather than crashing on `resolved.source` below if
    // that ever stops being true.
    throw new Error('mockingham: could not construct an LLM content source')
  }

  const store = await createStore(fixturesDir)
  try {
    const summary = await bake({
      api,
      store,
      source: resolved.source,
      compiler,
      persona: args.persona,
      now,
      onWarn: log,
      onError: (error) => {
        log(`mockingham: bake error — ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    log(
      `mockingham: baked ${summary.generated} fixture(s) to ${fixturesDir} ` +
        `(skipped ${summary.skipped}, failed ${summary.failed})`
    )

    return summary
  } finally {
    // Invariant: a debounced write left pending when the process exits is a
    // silent total loss of the bake. This must run even when bake() throws.
    await store.flush()
  }
}

export const MCP_USAGE = `mockingham mcp — serve the MCP tools over stdio

  mockingham mcp <document.json> [options]

  --seed <s>        Generation seed (default: mockingham)
  --fixtures <dir>  Serve committed fixture files from this directory
  --write           Expose the write tools (fail_next, outage, emit_webhook,
                     set_seed, reset, set_override, clear_overrides,
                     regenerate_fixture). Off by default: they change the
                     mock's runtime state, and regenerate_fixture writes to
                     the fixture directory when one is configured.
  --help, -h        Show this message

YAML is not parsed. Convert the document to JSON first.
`

export interface McpArgs {
  document?: string
  seed?: string
  fixtures?: string
  write: boolean
  help: boolean
}

const MCP_NEEDS_VALUE = new Set(['--seed', '--fixtures'])

export function parseMcpArgs(argv: string[]): McpArgs {
  const args: McpArgs = {
    document: undefined,
    seed: undefined,
    fixtures: undefined,
    write: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (token === '--write') {
      args.write = true
      continue
    }

    if (token.startsWith('--')) {
      const split = token.indexOf('=')
      const name = split === -1 ? token : token.slice(0, split)
      if (!MCP_NEEDS_VALUE.has(name)) {
        throw new Error(`mockingham: unknown option ${name}\n\n${MCP_USAGE}`)
      }
      const value = split === -1 ? argv[++i] : token.slice(split + 1)
      if (value === undefined) {
        throw new Error(`mockingham: ${name} needs a value`)
      }
      if (name === '--seed') args.seed = value
      else args.fixtures = value
      continue
    }

    if (args.document !== undefined) {
      throw new Error(`mockingham: unexpected argument "${token}"`)
    }
    args.document = token
  }

  return args
}

export interface McpCliDeps {
  readFile: (path: string) => Promise<string>
  /**
   * stderr, NOT stdout. stdout is the JSON-RPC channel over stdio, and one
   * stray log line corrupts the stream for the whole session. This is the one
   * place the project's `log` convention bends, and it bends for a protocol
   * requirement rather than a preference.
   */
  log: (message: string) => void
}

export async function startMcp(
  argv: string[],
  deps: Partial<McpCliDeps> = {}
): Promise<{ close(): Promise<void> }> {
  const readFile = deps.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  const log = deps.log ?? ((message: string) => console.error(message))

  const args = parseMcpArgs(argv)
  if (args.help) {
    log(MCP_USAGE)
    throw new Error('mockingham: nothing to serve')
  }
  if (args.document === undefined) {
    throw new Error(`mockingham: a document path is required\n\n${MCP_USAGE}`)
  }
  if (args.document.endsWith('.yaml') || args.document.endsWith('.yml')) {
    throw new Error(
      'mockingham: YAML documents are not parsed. Convert to JSON, or call ' +
        'createMock() from a script with the document already parsed.'
    )
  }

  const text = await readFile(args.document)
  // createMock, not createHandler: the write tools need failNext, outage, and
  // emit, which live on Mock rather than Handler.
  const mock = createMock(JSON.parse(text) as Record<string, unknown>, {
    seed: args.seed,
    fixtures: args.fixtures !== undefined
      ? { store: await createDiskFixtureStore({ dir: args.fixtures, onWarn: log }) }
      : undefined,
    onWarn: log
  })

  const server = mock.mcp({ transport: 'stdio', write: args.write })
  await server.connectStdio()
  log(`mockingham: MCP server ready for ${args.document}`)

  return {
    async close() {
      await server.close()
      await mock.close()
    }
  }
}

if (import.meta.main) {
  try {
    // `--help` is not misuse — `mockingham --help` must exit 0, and this is
    // the one call site that can act on that without changing `startCli`'s
    // contract. A genuinely missing document argument still reaches
    // `startCli` below and throws, which IS misuse and should exit non-zero.
    // `parseArgs` itself must stay inside this `try`: it can throw too (an
    // unknown flag, a bad `--port`), and before this wrapping that throw hit
    // top-level module evaluation instead of this catch — a stack trace
    // instead of the same one clean line every other CLI misuse gets.
    const argv = process.argv.slice(2)
    if (argv[0] === 'mcp') {
      const mcpArgv = argv.slice(1)
      if (parseMcpArgs(mcpArgv).help) {
        console.error(MCP_USAGE)
      } else {
        await startMcp(mcpArgv)
      }
    } else if (argv[0] === 'bake') {
      const bakeArgv = argv.slice(1)
      if (parseBakeArgs(bakeArgv).help) {
        console.log(BAKE_USAGE)
      } else {
        await startBake(bakeArgv)
      }
    } else if (parseArgs(argv).help) {
      console.log(USAGE)
    } else {
      await startCli(argv)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

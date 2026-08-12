#!/usr/bin/env node
import { readFile as readFileFromDisk } from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { loadApi } from '../spec/load.ts'
import { createHandler } from './handler.ts'
import type { Handler } from './handler.ts'
import { createNodeServer } from './node.ts'

export const USAGE = `mockingham — OpenAPI driven HTTP mock server

  mockingham <document.json> [options]

  --port <n>    Port to listen on (default: an ephemeral port)
  --seed <s>    Generation seed (default: mockingham)
  --watch       Reload the document when it changes on disk
  --help, -h    Show this message

YAML is not parsed. Convert the document to JSON first, or use createMock()
from a script and pass the parsed object in.
`

export interface CliArgs {
  document?: string
  port: number
  seed?: string
  watch: boolean
  help: boolean
}

const NEEDS_VALUE = new Set(['--port', '--seed'])

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { document: undefined, port: 0, seed: undefined, watch: false, help: false }

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
    return createHandler(loadApi(JSON.parse(text) as Record<string, unknown>), {
      seed: args.seed
    })
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

if (import.meta.main) {
  try {
    await startCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

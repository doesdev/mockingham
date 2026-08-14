import { parseArgs, parseBakeArgs, parseMcpArgs } from '../../src/server/cli.ts'

/**
 * A prefix check rather than a parse. The rule only needs to distinguish
 * "prints a string" from "prints whatever util.inspect feels like today", and
 * a real expression parser here would be more machinery than the rule is
 * worth. Design section 2.5.
 */
export function assertPrintableLogs(block: string, file: string, line: number): void {
  const marker = 'console.log('
  for (let at = block.indexOf(marker); at !== -1; at = block.indexOf(marker, at + 1)) {
    const rest = block.slice(at + marker.length)
    const ok =
      rest.startsWith("'") ||
      rest.startsWith('"') ||
      rest.startsWith('`') ||
      rest.startsWith('JSON.stringify(')
    if (!ok) {
      throw new Error(
        `${file}:${line}: console.log must print a string, a template literal, ` +
          'or JSON.stringify(value, null, 2) — util.inspect output is not stable ' +
          'across Node versions.'
      )
    }
  }
}

/**
 * The docs must import the way a reader can. A relative path into `src/` would
 * run fine here and be uncopyable there — the exact drift this harness exists
 * to catch.
 */
export function assertBareSpecifier(block: string, file: string, line: number): void {
  const pattern = /from\s+'([^']+)'/g
  for (const match of block.matchAll(pattern)) {
    const specifier = match[1] as string
    if (specifier.startsWith('node:') || specifier === 'mockingham') continue
    throw new Error(
      `${file}:${line}: import from "${specifier}" — docs must use the bare ` +
        'specifier \'mockingham\' or a node: builtin.'
    )
  }
}

const SHELL_ALLOW = [
  'npm install',
  'npm test',
  'npx tsc --noEmit',
  'ollama serve',
  'ollama pull'
] as const

function splitArgs(line: string): string[] {
  return line
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.replace(/^["']|["']$/g, ''))
}

/** Routes to the same parser the running CLI uses, subcommand included. */
function checkMockinghamArgs(argv: string[]): void {
  if (argv[0] === 'bake') parseBakeArgs(argv.slice(1))
  else if (argv[0] === 'mcp') parseMcpArgs(argv.slice(1))
  else parseArgs(argv)
}

export function checkShellFence(content: string, file: string, line: number): void {
  for (const raw of content.split('\n')) {
    const command = raw.trim()
    if (command === '' || command.startsWith('#')) continue

    const withoutNpx = command.startsWith('npx mockingham ')
      ? command.slice('npx '.length)
      : command

    if (withoutNpx === 'mockingham' || withoutNpx.startsWith('mockingham ')) {
      checkMockinghamArgs(splitArgs(withoutNpx).slice(1))
      continue
    }

    if (!SHELL_ALLOW.some((allowed) => command === allowed || command.startsWith(`${allowed} `))) {
      throw new Error(
        `${file}:${line}: shell command "${command}" is not a mockingham ` +
          `invocation and is not on the allow-set (${SHELL_ALLOW.join(', ')}).`
      )
    }
  }
}

interface McpClientConfig {
  mcpServers?: Record<string, { command?: string; args?: string[] }>
}

export function checkJsonFence(content: string, file: string, line: number): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(
      `${file}:${line}: fence is not valid JSON — ${(error as Error).message}`
    )
  }

  const servers = (parsed as McpClientConfig).mcpServers
  if (servers === undefined) return

  for (const [name, server] of Object.entries(servers)) {
    const argv = server.args ?? []
    // `npx mockingham mcp ...` and `mockingham mcp ...` both appear in client
    // configs; drop the package name so the parser sees the same argv the CLI
    // process would.
    const start = argv[0] === 'mockingham' ? 1 : argv[0] === '-y' && argv[1] === 'mockingham' ? 2 : 0
    try {
      checkMockinghamArgs(argv.slice(start))
    } catch (error) {
      throw new Error(
        `${file}:${line}: mcpServers.${name} — ${(error as Error).message}`
      )
    }
  }
}

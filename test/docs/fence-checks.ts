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

    // Check for multiple arguments: scan to the matching close parenthesis,
    // tracking depth and quoted runs, and reject if a comma appears at depth 0.
    let depth = 1
    let i = 0
    let inQuote: string | undefined
    while (i < rest.length && depth > 0) {
      const char = rest[i] as string
      if (inQuote) {
        if (char === inQuote && rest[i - 1] !== '\\') inQuote = undefined
      } else {
        if (char === '"' || char === "'" || char === '`') {
          inQuote = char
        } else if (char === '(') {
          depth++
        } else if (char === ')') {
          depth--
        } else if (char === ',' && depth === 1) {
          throw new Error(
            `${file}:${line}: console.log must receive a single argument — ` +
              'only strings, template literals, and JSON.stringify are portable ' +
              'across readers.'
          )
        }
      }
      i++
    }
  }
}

/**
 * The docs must import the way a reader can. A relative path into `src/` would
 * run fine here and be uncopyable there — the exact drift this harness exists
 * to catch.
 */
export function assertBareSpecifier(block: string, file: string, line: number): void {
  const pattern = /from\s+["']([^"']+)["']/g
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
  const tokens: string[] = []
  let current = ''
  let inQuote: string | undefined
  let i = 0

  while (i < line.length) {
    const char = line[i] as string
    if (inQuote) {
      if (char === inQuote) {
        inQuote = undefined
      } else {
        current += char
      }
    } else {
      if (char === '"' || char === "'") {
        inQuote = char
      } else if (/\s/.test(char)) {
        if (current !== '') {
          tokens.push(current)
          current = ''
        }
      } else {
        current += char
      }
    }
    i++
  }

  if (current !== '') {
    tokens.push(current)
  }

  return tokens
}

/** Routes to the same parser the running CLI uses, subcommand included. */
function checkMockinghamArgs(argv: string[]): void {
  if (argv[0] === 'bake') parseBakeArgs(argv.slice(1))
  else if (argv[0] === 'mcp') parseMcpArgs(argv.slice(1))
  else parseArgs(argv)
}

export function checkShellFence(content: string, file: string, line: number): void {
  for (const raw of content.split('\n')) {
    const withComment = raw.trim()
    if (withComment === '' || withComment.startsWith('#')) continue

    // Strip trailing comments: an unquoted # and everything after.
    let command = ''
    let inQuote: string | undefined
    for (let i = 0; i < withComment.length; i++) {
      const char = withComment[i] as string
      if (inQuote) {
        command += char
        if (char === inQuote && withComment[i - 1] !== '\\') inQuote = undefined
      } else {
        if (char === '"' || char === "'") {
          inQuote = char
          command += char
        } else if (char === '#') {
          break
        } else {
          command += char
        }
      }
    }
    command = command.trim()

    // Handle "npx mockingham" or "npx -y mockingham"
    let withoutNpx = command
    if (command.startsWith('npx mockingham ')) {
      withoutNpx = command.slice('npx '.length)
    } else if (command.startsWith('npx -y mockingham ')) {
      withoutNpx = command.slice('npx -y '.length)
    }

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

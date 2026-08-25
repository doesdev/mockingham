import { parseArgs, parseBakeArgs, parseMcpArgs } from '../../src/server/cli.ts'

/**
 * For each index in `input`, the quote character enclosing it, or `undefined`
 * when that index sits outside any quoted run. Opening and closing quotes
 * themselves report as quoted.
 *
 * THE one quote scanner. There were three, and they disagreed: two treated any
 * quote preceded by a backslash as escaped, and `splitArgs` had no escape
 * handling at all. The two-character lookback is wrong for a DOUBLED
 * backslash - in `console.log('a\\', payload)` the final `\` is itself
 * escaped, so the `'` after it closes the string, but the lookback saw a
 * backslash and decided the string continued. The scan then never returned to
 * depth 1, the "single argument" check never ran, and a two-argument call was
 * accepted. Counting escapes properly, in one place, is the fix - the same
 * reasoning invariant 1 applies to schema traversal. Deferred item 35.
 */
export interface QuoteScan {
  /** Per index: the enclosing quote character, or undefined. Delimiters count
   * as enclosed. */
  inside: Array<string | undefined>
  /** Per index: true when this character opens or closes a quoted run. */
  delimiter: boolean[]
  /** True when a quoted run was left open at the end of the input. */
  unterminated: boolean
}

export function scanQuotes(input: string, quotes = `"'\``): QuoteScan {
  const inside: Array<string | undefined> = new Array(input.length)
  const delimiter: boolean[] = new Array(input.length).fill(false)
  let quote: string | undefined
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string

    if (escaped) {
      escaped = false
      inside[i] = quote
      continue
    }
    if (char === '\\') {
      escaped = true
      inside[i] = quote
      continue
    }
    if (quote === undefined) {
      if (quotes.includes(char)) {
        quote = char
        inside[i] = char
        delimiter[i] = true
      } else {
        inside[i] = undefined
      }
      continue
    }
    inside[i] = quote
    if (char === quote) {
      delimiter[i] = true
      quote = undefined
    }
  }

  return { inside, delimiter, unterminated: quote !== undefined }
}

/** Just the enclosure map, for the checks that only need to skip quoted runs. */
export function quoteMap(input: string): Array<string | undefined> {
  return scanQuotes(input).inside
}

/**
 * Every route to stdout or stderr other than a single-argument `console.log`.
 * The rule the harness enforces is that a document's output is stable and
 * byte-comparable, and `assertPrintableLogs` used to look only for the literal
 * `console.log(` - so `process.stdout.write(util.inspect(x))`, or a
 * `console.error`, sidestepped it entirely while still writing to a stream the
 * harness compares. Deferred item 34.
 */
const FORBIDDEN_WRITERS = [
  'process.stdout.write',
  'process.stderr.write',
  'console.error',
  'console.warn',
  'console.info',
  'console.debug',
  'console.dir',
  'console.table',
  'console.trace',
  'console.group'
] as const

/**
 * A prefix check rather than a parse. The rule only needs to distinguish
 * "prints a string" from "prints whatever util.inspect feels like today", and
 * a real expression parser here would be more machinery than the rule is
 * worth. Design section 2.5.
 */
export function assertPrintableLogs(block: string, file: string, line: number): void {
  const quoted = quoteMap(block)

  for (const writer of FORBIDDEN_WRITERS) {
    for (let at = block.indexOf(writer); at !== -1; at = block.indexOf(writer, at + 1)) {
      // Inside a string it is prose about the API, not a call.
      if (quoted[at] !== undefined) continue
      throw new Error(
        `${file}:${line}: ${writer} writes to a stream this harness compares, ` +
          'and only a single-argument console.log is portable. Use ' +
          'console.log with a string, a template literal, or JSON.stringify.'
      )
    }
  }

  const marker = 'console.log('
  for (let at = block.indexOf(marker); at !== -1; at = block.indexOf(marker, at + 1)) {
    if (quoted[at] !== undefined) continue
    const start = at + marker.length
    const rest = block.slice(start)
    const ok =
      rest.startsWith("'") ||
      rest.startsWith('"') ||
      rest.startsWith('`') ||
      rest.startsWith('JSON.stringify(')
    if (!ok) {
      throw new Error(
        `${file}:${line}: console.log must print a string, a template literal, ` +
          'or JSON.stringify(value, null, 2) - util.inspect output is not stable ' +
          'across Node versions.'
      )
    }

    // Scan to the matching close parenthesis and reject a comma at depth 1.
    // Quote state comes from the shared map, indexed against the whole block
    // so an escape earlier in the fence is accounted for.
    let depth = 1
    for (let i = start; i < block.length && depth > 0; i++) {
      if (quoted[i] !== undefined) continue
      const char = block[i] as string
      if (char === '(') depth++
      else if (char === ')') depth--
      else if (char === ',' && depth === 1) {
        throw new Error(
          `${file}:${line}: console.log must receive a single argument - ` +
            'only strings, template literals, and JSON.stringify are portable ' +
            'across readers.'
        )
      }
    }
  }
}

/**
 * The docs must import the way a reader can. A relative path into `src/` would
 * run fine here and be uncopyable there - the exact drift this harness exists
 * to catch.
 */
export function assertBareSpecifier(block: string, file: string, line: number): void {
  const pattern = /from\s+["']([^"']+)["']/g
  for (const match of block.matchAll(pattern)) {
    const specifier = match[1] as string
    if (specifier.startsWith('node:') || specifier === 'mockingham') continue
    throw new Error(
      `${file}:${line}: import from "${specifier}" - docs must use the bare ` +
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

export function splitArgs(input: string, file?: string, line?: number): string[] {
  // Same scanner as every other quote-aware check here, so a backslash means
  // the same thing in all of them. This function used to have no escape
  // handling at all. Backticks are not quotes in an argv the way they are in
  // TypeScript source, so they are excluded here.
  const scan = scanQuotes(input, `"'`)
  const tokens: string[] = []
  let current = ''
  let tokenStarted = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string

    // A delimiter starts a token without contributing to it, which is what
    // makes `--seed ""` an empty token rather than no token at all.
    if (scan.delimiter[i]) {
      tokenStarted = true
      continue
    }
    if (scan.inside[i] !== undefined) {
      current += char
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }
    current += char
    tokenStarted = true
  }

  if (scan.unterminated) {
    const context = file && line ? `${file}:${line}` : ''
    throw new Error(
      `${context}: unterminated quoted string`.replace(/^:\s*/, '')
    )
  }

  if (tokenStarted) {
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

    // Strip trailing comments: an unquoted # and everything after. Quote
    // state comes from the shared scanner, so a doubled backslash before a
    // closing quote is read the same way here as everywhere else.
    const quoted = scanQuotes(withComment, `"'`).inside
    let command = ''
    for (let i = 0; i < withComment.length; i++) {
      const char = withComment[i] as string
      if (quoted[i] === undefined && char === '#') break
      command += char
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
      checkMockinghamArgs(splitArgs(withoutNpx, file, line).slice(1))
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

/**
 * Every `args` array of strings anywhere in the parsed JSON, with the path
 * that reached it.
 *
 * The check used to read `parsed.mcpServers` and return the moment it was
 * absent, so a client config shaped for a host that uses a different top-level
 * key received no argument checking at all - while the docs-design §2.3 table
 * described the check as applying to a client config unconditionally. Walking
 * for the shape rather than for one key is what makes the description true.
 * Deferred item 38.
 */
function findArgsArrays(
  value: unknown,
  path: string[] = []
): Array<{ path: string; argv: string[] }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findArgsArrays(entry, [...path, String(index)])
    )
  }
  if (value === null || typeof value !== 'object') return []

  const found: Array<{ path: string; argv: string[] }> = []
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'args' &&
      Array.isArray(child) &&
      child.every((entry) => typeof entry === 'string')
    ) {
      found.push({ path: [...path, key].join('.'), argv: child as string[] })
      continue
    }
    found.push(...findArgsArrays(child, [...path, key]))
  }
  return found
}

export function checkJsonFence(content: string, file: string, line: number): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(
      `${file}:${line}: fence is not valid JSON - ${(error as Error).message}`
    )
  }

  for (const { path, argv } of findArgsArrays(parsed)) {
    // `npx mockingham mcp ...` and `mockingham mcp ...` both appear in client
    // configs; drop the package name so the parser sees the same argv the CLI
    // process would.
    const start =
      argv[0] === 'mockingham' ? 1 : argv[0] === '-y' && argv[1] === 'mockingham' ? 2 : 0
    // An args array that never names mockingham belongs to some other program
    // and is none of this parser's business.
    if (start === 0 && !argv.includes('mockingham')) continue
    try {
      checkMockinghamArgs(argv.slice(start))
    } catch (error) {
      throw new Error(`${file}:${line}: ${path} - ${(error as Error).message}`)
    }
  }
}

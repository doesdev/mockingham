export interface Fence {
  lang: string
  content: string
  /** 1-based line of the opening fence, for error messages that point somewhere. */
  line: number
}

/**
 * Line-based rather than a regex. A regex over fenced markdown gets the
 * nesting and the trailing-newline cases wrong in ways that are invisible
 * until a doc happens to hit one.
 *
 * Implements CommonMark 0.30 fence rules (§4.4):
 * - Opening fence: optional leading whitespace, 3+ backticks, optional info string
 * - Closing fence: line that trims to only backticks, count >= opening count
 * - Content indentation: strips the opening fence's indent prefix from each line
 */
export function extractFences(markdown: string): Fence[] {
  const lines = markdown.split('\n')
  const fences: Fence[] = []
  let open:
    | { lang: string; line: number; indent: string; backtickCount: number; body: string[] }
    | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string

    if (open === undefined) {
      // Try to match opening fence: optional whitespace, 3+ backticks, optional info string
      const match = line.match(/^(\s*)(`{3,})(.*)$/)
      if (match) {
        const [, indent, backticks, info] = match
        open = {
          lang: info.trim(),
          line: i + 1,
          indent: indent as string,
          backtickCount: backticks.length,
          body: []
        }
      }
      continue
    }

    // We have an open fence. Check if this line closes it.
    const trimmedLine = line.trim()
    const isAllBackticks = /^`+$/.test(trimmedLine)

    if (isAllBackticks && trimmedLine.length >= open.backtickCount) {
      // This line closes the fence
      const openFence = open
      const content = openFence.body
        .map((bodyLine) => {
          // Strip the opening fence's indent from content lines
          if (bodyLine.startsWith(openFence.indent)) {
            return bodyLine.slice(openFence.indent.length)
          }
          return bodyLine
        })
        .join('\n')

      fences.push({ lang: openFence.lang, content, line: openFence.line })
      open = undefined
    } else {
      // This line is content
      open.body.push(line)
    }
  }

  if (open !== undefined) {
    throw new Error(`unclosed fence opened at line ${open.line}`)
  }
  return fences
}

/**
 * Every language the harness knows how to check. An unrecognized one fails
 * rather than being ignored: a checked-in exemption list is a list that goes
 * stale silently, so adding a new kind of block has to be a decision someone
 * makes on purpose. Design section 2.3.
 */
export const KNOWN_LANGS: ReadonlySet<string> = new Set([
  'ts',
  'console',
  'sh',
  'json',
  'jsonc',
  'txt'
])

export function assertKnownFences(fences: Fence[], file: string): void {
  for (const fence of fences) {
    if (!KNOWN_LANGS.has(fence.lang)) {
      throw new Error(
        `${file}:${fence.line}: fence language "${fence.lang}" has no check ` +
          `attached. Known: ${[...KNOWN_LANGS].join(', ')}.`
      )
    }
  }
}

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
 */
export function extractFences(markdown: string): Fence[] {
  const lines = markdown.split('\n')
  const fences: Fence[] = []
  let open: { lang: string; line: number; body: string[] } | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (!line.startsWith('```')) {
      if (open !== undefined) open.body.push(line)
      continue
    }
    if (open === undefined) {
      open = { lang: line.slice(3).trim(), line: i + 1, body: [] }
    } else {
      fences.push({ lang: open.lang, content: open.body.join('\n'), line: open.line })
      open = undefined
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

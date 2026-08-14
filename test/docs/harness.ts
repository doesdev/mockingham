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

import { mkdtemp, writeFile, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertPrintableLogs,
  assertBareSpecifier,
  checkShellFence,
  checkJsonFence
} from './fence-checks.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const ENTRY = join(REPO, 'src', 'index.ts')
const EXAMPLE_DOC = join(REPO, 'docs', 'example.json')

/** The default: generous enough for a real document, short enough that a
 * hung program does not stall a test run for long. Callers exercising the
 * timeout path pass a much smaller value explicitly. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Only the import specifier is rewritten — `from 'mockingham'` or
 * `from "mockingham"` — never a bare occurrence of the literal `mockingham`
 * elsewhere in the fence. `mockingham` is also the CLI's own documented
 * default seed (see cli.ts's USAGE strings), so `seed: 'mockingham'` is a
 * plausible thing for a guide to write, and rewriting it into a file path
 * would make the harness record output for a seed no reader could
 * reproduce.
 */
const IMPORT_SPECIFIER = /from\s+(['"])mockingham\1/g

export function assembleProgram(fences: Fence[], entryPath: string): string {
  return fences
    .filter((fence) => fence.lang === 'ts')
    .map((fence) => fence.content.replace(IMPORT_SPECIFIER, `from ${JSON.stringify(entryPath)}`))
    .join('\n\n')
}

export function expectedOutput(fences: Fence[]): string {
  return fences
    .filter((fence) => fence.lang === 'console')
    .map((fence) => fence.content.replace(/\s+$/, ''))
    .join('\n')
}

/**
 * Markdown read from disk goes through here on every path that reads a
 * document, so a CRLF-terminated file (a Windows editor, `core.autocrlf`)
 * normalizes exactly once rather than twice, or once-and-forgotten.
 * `extractFences`'s opening-fence regex uses `.` and `$` without `/m`, and
 * `.` never matches `\r` — an un-normalized CRLF document silently extracts
 * zero fences.
 */
async function readDocument(docPath: string): Promise<string> {
  const raw = await readFile(docPath, 'utf8')
  return raw.replace(/\r\n/g, '\n')
}

/**
 * A document that extracts zero `ts` fences would otherwise sail through
 * every check that follows vacuously: nothing unknown to reject, an empty
 * assembled program, a child that prints nothing, output that trivially
 * matches an equally empty expectation. "This document claims nothing" must
 * be a failure, not a pass — and it is also what catches a CRLF document
 * losing its fences even if the normalization above were ever skipped on
 * some other read path.
 */
function assertHasTsFence(fences: Fence[], file: string): void {
  if (!fences.some((fence) => fence.lang === 'ts')) {
    throw new Error(
      `${file}: no ts fence found — a document with zero runnable blocks ` +
        'would otherwise pass vacuously, which is worse than failing loudly.'
    )
  }
}

interface ChildResult {
  stdout: string
  stderr: string
  code: number
  /** True when the child was killed for exceeding the timeout, rather than
   * exiting on its own. A killed child's `error.code` is not numeric, so
   * without this flag it is indistinguishable from an ordinary exit 1 —
   * hiding that the real cause is usually a `listen()` with no matching
   * `close()`. */
  timedOut: boolean
}

function runChild(program: string, cwd: string, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [program],
      { cwd, env: { ...process.env, NO_COLOR: '1' }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error !== null && error.killed === true) {
          resolve({ stdout, stderr, code: -1, timedOut: true })
          return
        }
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr, code, timedOut: false })
      }
    )
  })
}

/**
 * Each document runs in its own sandbox holding a copy of the example document
 * named `openapi.json`, with the child's cwd set to it. That is what lets a
 * guide write `readFile('./openapi.json')` — the path a reader actually has —
 * and still resolve here.
 */
export async function runDocument(
  docPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ChildResult> {
  const markdown = await readDocument(docPath)
  const fences = extractFences(markdown)
  assertKnownFences(fences, docPath)
  assertHasTsFence(fences, docPath)

  for (const fence of fences) {
    if (fence.lang === 'ts') {
      assertPrintableLogs(fence.content, docPath, fence.line)
      assertBareSpecifier(fence.content, docPath, fence.line)
    } else if (fence.lang === 'sh') {
      checkShellFence(fence.content, docPath, fence.line)
    } else if (fence.lang === 'json') {
      checkJsonFence(fence.content, docPath, fence.line)
    } else if (fence.lang === 'jsonc') {
      checkJsonFence(
        fence.content.replace(/^\s*\/\/.*$/gm, ''),
        docPath,
        fence.line
      )
    }
  }

  const sandbox = await mkdtemp(join(tmpdir(), 'mockingham-docs-'))
  await copyFile(EXAMPLE_DOC, join(sandbox, 'openapi.json'))
  const programPath = join(sandbox, 'program.ts')
  await writeFile(programPath, assembleProgram(fences, ENTRY), 'utf8')

  return runChild(programPath, sandbox, timeoutMs)
}

function section(label: string, content: string): string {
  return `--- ${label} ---\n${content === '' ? '(empty)' : content}`
}

export async function assertDocument(
  docPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<void> {
  const markdown = await readDocument(docPath)
  const expected = expectedOutput(extractFences(markdown))
  const result = await runDocument(docPath, timeoutMs)

  if (result.timedOut) {
    throw new Error(
      `${docPath}: the document's program did not exit within ${timeoutMs}ms ` +
        'and was killed. This usually means a mock was never shut down — a ' +
        'listen() without a matching close().\n\n' +
        `${section('stderr', result.stderr)}\n${section('stdout', result.stdout)}`
    )
  }

  if (result.code !== 0) {
    throw new Error(
      `${docPath}: the document's program exited ${result.code}\n\n` +
        `${section('stderr', result.stderr)}\n${section('stdout', result.stdout)}`
    )
  }

  const actual = result.stdout.replace(/\s+$/, '')
  if (actual !== expected) {
    throw new Error(
      `${docPath}: output does not match the console fences\n\n` +
        `--- expected ---\n${expected}\n\n--- actual ---\n${actual}\n\n` +
        section('stderr', result.stderr)
    )
  }
}

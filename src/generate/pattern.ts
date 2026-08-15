import type { Rng } from './rng.ts'

/**
 * Generates a string matching a regex `pattern`, for the documented subset of
 * master §3: literals, character classes, anchors, and bounded quantifiers,
 * plus alternation and groups.
 *
 * Returns `undefined` — never throws — for anything outside that subset, which
 * is the caller's signal to fall back to `example`, then `default`, then the
 * ordinary placeholder. The caller decides; this module only reports that it
 * cannot help.
 *
 * Every choice draws from the seeded `Rng`, so a pattern generates the same
 * value for the same seed across processes. Invariant 2 covers this module as
 * much as any other generator.
 */

/** Unbounded `*` and `+` need a ceiling to terminate. */
const MAX_UNBOUNDED_REPEAT = 3

/** `.` emits from a safe printable set rather than any codepoint. */
const DOT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const DIGITS = '0123456789'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const WORD = `${LOWER}${UPPER}${DIGITS}_`
const SPACE = ' '
/** For a negated class, the pool a complement is taken from. */
const PRINTABLE = `${LOWER}${UPPER}${DIGITS} _-.`

type Node =
  | { kind: 'chars'; chars: string }
  | { kind: 'literal'; value: string }
  | { kind: 'repeat'; node: Node; min: number; max: number }
  | { kind: 'sequence'; nodes: Node[] }
  | { kind: 'alternation'; branches: Node[] }

/** Thrown internally to abandon a parse; never escapes this module. */
const UNSUPPORTED = Symbol('unsupported')

function unsupported(): never {
  throw UNSUPPORTED
}

function expand(from: string, to: string): string {
  const start = from.charCodeAt(0)
  const end = to.charCodeAt(0)
  if (end < start) unsupported()
  let out = ''
  for (let code = start; code <= end; code++) out += String.fromCharCode(code)
  return out
}

function shorthand(escaped: string): string | undefined {
  switch (escaped) {
    case 'd': return DIGITS
    case 'w': return WORD
    case 's': return SPACE
    // A complement over the printable pool, not over all of Unicode: the point
    // is a plausible mock value, and every character here still matches.
    case 'D': return `${LOWER}${UPPER}_-`
    case 'W': return ' -.'
    case 'S': return `${LOWER}${UPPER}${DIGITS}_`
    default: return undefined
  }
}

function createParser(pattern: string) {
  let at = 0

  const peek = (): string | undefined => pattern[at]
  const eat = (): string => {
    const char = pattern[at]
    if (char === undefined) unsupported()
    at++
    return char
  }

  function parseClass(): Node {
    // The opening '[' is already consumed.
    let negated = false
    if (peek() === '^') {
      at++
      negated = true
    }
    let chars = ''
    let closed = false
    while (at < pattern.length) {
      const char = eat()
      if (char === ']') {
        closed = true
        break
      }
      if (char === '\\') {
        const escaped = eat()
        const set = shorthand(escaped)
        chars += set ?? escaped
        continue
      }
      // A range, but only when '-' sits between two members rather than at
      // either edge, where it is a literal hyphen.
      if (peek() === '-' && pattern[at + 1] !== undefined && pattern[at + 1] !== ']') {
        at++
        chars += expand(char, eat())
        continue
      }
      chars += char
    }
    if (!closed) unsupported()
    if (chars === '') unsupported()
    if (!negated) return { kind: 'chars', chars }
    const excluded = new Set(chars.split(''))
    const complement = PRINTABLE.split('').filter((c) => !excluded.has(c)).join('')
    if (complement === '') unsupported()
    return { kind: 'chars', chars: complement }
  }

  function parseQuantifier(node: Node): Node {
    const char = peek()
    if (char === '?') {
      at++
      return { kind: 'repeat', node, min: 0, max: 1 }
    }
    if (char === '*') {
      at++
      return { kind: 'repeat', node, min: 0, max: MAX_UNBOUNDED_REPEAT }
    }
    if (char === '+') {
      at++
      return { kind: 'repeat', node, min: 1, max: MAX_UNBOUNDED_REPEAT }
    }
    if (char !== '{') return node
    const close = pattern.indexOf('}', at)
    if (close === -1) return node
    const inner = pattern.slice(at + 1, close)
    const bounds = /^(\d+)(,(\d*)?)?$/.exec(inner)
    // Not a quantifier at all — a literal '{'. Left to the atom parser.
    if (!bounds) return node
    at = close + 1
    const min = Number.parseInt(bounds[1] as string, 10)
    const max =
      bounds[2] === undefined
        ? min
        : bounds[3] === undefined || bounds[3] === ''
          ? min + MAX_UNBOUNDED_REPEAT
          : Number.parseInt(bounds[3], 10)
    if (max < min) unsupported()
    return { kind: 'repeat', node, min, max }
  }

  function parseAtom(): Node | undefined {
    const char = peek()
    if (char === undefined) return undefined
    if (char === '|' || char === ')') return undefined

    if (char === '^' || char === '$') {
      at++
      // Anchors constrain position, and position is not something a generated
      // string carries. They emit nothing.
      return { kind: 'sequence', nodes: [] }
    }

    if (char === '(') {
      at++
      if (peek() === '?') {
        at++
        // Only a non-capturing group is supported. Lookahead, lookbehind and
        // named groups all start here and all bail.
        if (eat() !== ':') unsupported()
      }
      const inner = parseAlternation()
      if (eat() !== ')') unsupported()
      return inner
    }

    if (char === '[') {
      at++
      return parseClass()
    }

    if (char === '\\') {
      at++
      const escaped = eat()
      const set = shorthand(escaped)
      if (set) return { kind: 'chars', chars: set }
      // A backreference is not expressible without tracking group values.
      if (/[0-9]/.test(escaped)) unsupported()
      // \p{...} and \k<...> are unicode property escapes and named
      // backreferences respectively.
      if (escaped === 'p' || escaped === 'P' || escaped === 'k') unsupported()
      if (escaped === 'b' || escaped === 'B') unsupported()
      if (escaped === 'n') return { kind: 'literal', value: '\n' }
      if (escaped === 't') return { kind: 'literal', value: '\t' }
      if (escaped === 'r') return { kind: 'literal', value: '\r' }
      return { kind: 'literal', value: escaped }
    }

    if (char === '.') {
      at++
      return { kind: 'chars', chars: DOT_CHARS }
    }

    at++
    return { kind: 'literal', value: char }
  }

  function parseSequence(): Node {
    const nodes: Node[] = []
    for (;;) {
      const atom = parseAtom()
      if (atom === undefined) break
      nodes.push(parseQuantifier(atom))
    }
    return { kind: 'sequence', nodes }
  }

  function parseAlternation(): Node {
    const branches: Node[] = [parseSequence()]
    while (peek() === '|') {
      at++
      branches.push(parseSequence())
    }
    return branches.length === 1
      ? (branches[0] as Node)
      : { kind: 'alternation', branches }
  }

  return {
    parse(): Node {
      const node = parseAlternation()
      // Anything left means a stray ')' or a construct the atom parser
      // refused to advance past.
      if (at !== pattern.length) unsupported()
      return node
    }
  }
}

function emit(node: Node, rng: Rng): string {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'chars':
      return node.chars[rng.int(0, node.chars.length - 1)] as string
    case 'sequence':
      return node.nodes.map((child) => emit(child, rng)).join('')
    case 'alternation':
      return emit(rng.pick(node.branches), rng)
    case 'repeat': {
      const count = rng.int(node.min, node.max)
      let out = ''
      for (let i = 0; i < count; i++) out += emit(node.node, rng)
      return out
    }
  }
}

export function generateFromPattern(
  pattern: string,
  rng: Rng
): string | undefined {
  let parsed: Node
  try {
    parsed = createParser(pattern).parse()
  } catch (error) {
    if (error === UNSUPPORTED) return undefined
    throw error
  }
  return emit(parsed, rng)
}

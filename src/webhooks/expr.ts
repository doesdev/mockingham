/**
 * OpenAPI runtime expressions, restricted to the subset the master spec §13
 * documents: `$url`, `$method`, `$statusCode`,
 * `$request.{header|query|path}.name`, `$request.body#/pointer`, and the
 * `$response` equivalents that make sense for a response - `header` and `body`.
 * `$response.query` and `$response.path` are not meaningful and are rejected.
 *
 * An expression may be a whole template or mixed with literal text, because a
 * document can write `{$request.body#/host}/hooks`.
 */

export interface ExprInput {
  request: Request
  url: URL
  method: string
  params: Record<string, string>
  body: unknown
  /** Absent when resolving before a response exists. */
  result?: { status: number; headers: Record<string, string>; body: unknown }
}

export type ExprResult =
  | { ok: true; value: string }
  | { ok: false; reason: string }

const TOKEN = /\{([^}]*)\}/g

/**
 * The same pattern without `g`, for one-shot checks.
 *
 * `TOKEN.test(...)` on a global regex advances its `lastIndex` and leaves it
 * advanced, and `String.prototype.matchAll` starts from the regex's current
 * `lastIndex` - so a `test` here silently made `isSupported` skip the first
 * token of the NEXT expression it examined. Four startup-warning tests caught
 * it. A separate stateless pattern is the honest fix; resetting `lastIndex` by
 * hand at every call site is the kind of convention that drifts.
 */
const ONE_TOKEN = /\{([^}]*)\}/

/**
 * A local JSON-pointer walk rather than reuse of `spec/refs.ts`. That module
 * resolves `$ref` inside a document and carries cycle tracking this does not
 * need; coupling the webhook path to it for eight lines would be the worse
 * trade, the same call made for `split()` in `deferred-items.md`.
 */
function resolvePointer(source: unknown, pointer: string): unknown {
  if (pointer === '') return source
  let value = source
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined
}

function resolveToken(token: string, input: ExprInput): string | undefined {
  if (token === '$url') return input.url.href
  if (token === '$method') return input.method
  if (token === '$statusCode') {
    return input.result === undefined ? undefined : String(input.result.status)
  }

  const isRequest = token.startsWith('$request.')
  const isResponse = token.startsWith('$response.')
  if (!isRequest && !isResponse) return undefined
  const rest = token.slice((isRequest ? '$request.' : '$response.').length)

  if (rest.startsWith('header.')) {
    const name = rest.slice('header.'.length).toLowerCase()
    if (name === '') return undefined
    if (isRequest) return input.request.headers.get(name) ?? undefined
    return input.result?.headers[name]
  }
  if (isRequest && rest.startsWith('query.')) {
    return input.url.searchParams.get(rest.slice('query.'.length)) ?? undefined
  }
  if (isRequest && rest.startsWith('path.')) {
    return input.params[rest.slice('path.'.length)]
  }
  if (rest === 'body' || rest.startsWith('body#')) {
    const source = isRequest ? input.body : input.result?.body
    if (source === undefined) return undefined
    const pointer = rest === 'body' ? '' : rest.slice('body#'.length)
    return scalar(resolvePointer(source, pointer))
  }
  return undefined
}

function isSupportedToken(token: string): boolean {
  if (token === '$url' || token === '$method' || token === '$statusCode') return true
  const isRequest = token.startsWith('$request.')
  const isResponse = token.startsWith('$response.')
  if (!isRequest && !isResponse) return false
  const rest = token.slice((isRequest ? '$request.' : '$response.').length)
  if (rest.startsWith('header.')) return rest.length > 'header.'.length
  if (isRequest && rest.startsWith('query.')) return rest.length > 'query.'.length
  if (isRequest && rest.startsWith('path.')) return rest.length > 'path.'.length
  return rest === 'body' || rest.startsWith('body#')
}

/**
 * Whether every token in the template is a FORM this implementation supports.
 * Deliberately not about whether it resolves: an unsupported form is a startup
 * warning, while a supported form that finds nothing is a runtime fall-through
 * to the next destination tier.
 */
export function isSupported(expression: string): boolean {
  for (const match of expression.matchAll(TOKEN)) {
    if (!isSupportedToken((match[1] ?? '').trim())) return false
  }
  return true
}

/**
 * Accepts the bare `$request.body#/url` spelling alongside the braced
 * `{$request.body#/url}` that `resolveExpression` requires - design §3.3.
 * OpenAPI's own `callbacks` keys are written bare, so a reader coming from the
 * spec will type it that way.
 *
 * This lives here, beside `resolveExpression`, and there is exactly ONE
 * spelling of it, for the reason `registrationKey` and `callbackKey` are
 * shared: two independent spellings of one convention drift silently with both
 * test suites green. The consequence of a missing call is not a failure but a
 * WRONG ANSWER - `resolveExpression` matches braced tokens only, so a bare
 * string matches nothing and comes back `{ ok: true }` carrying the literal
 * expression text. Every site that compiles a caller-written expression must
 * call this before storing it.
 *
 * A template that already contains a COMPLETE token is passed through whole
 * rather than wrapped, because `{$request.body#/host}/hooks` is a legal mixed
 * template and wrapping it again would produce `{{$request.body#/host}/hooks}`.
 *
 * The test is a matched token, not the presence of a `{`. A stray opening brace
 * - `https://h/{tenant` - satisfies "contains a brace" while matching no token,
 * so it used to be passed through and then resolve to itself: the same silent
 * wrong answer this function exists to prevent, reached by a different typo.
 * With no complete token it is wrapped, which makes it an unsupported
 * expression that `isSupported` warns about at construction and that resolves
 * `ok: false` rather than inventing a value.
 */
export function normalizeExpression(expression: string): string {
  const trimmed = expression.trim()
  return ONE_TOKEN.test(trimmed) ? trimmed : `{${trimmed}}`
}

export function resolveExpression(expression: string, input: ExprInput): ExprResult {
  let failed: string | undefined
  const value = expression.replace(TOKEN, (_, raw: string) => {
    const token = raw.trim()
    const resolved = resolveToken(token, input)
    if (resolved === undefined) {
      failed ??= token
      return ''
    }
    return resolved
  })
  if (failed !== undefined) return { ok: false, reason: failed }
  return { ok: true, value }
}

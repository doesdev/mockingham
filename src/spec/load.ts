import { resolveDocument } from './refs.ts'
import { HTTP_METHODS } from './types.ts'
import { asRecord, toContent, toParameter } from './raw.ts'
import { toCallbacks, toWebhooks } from './webhooks.ts'
import type {
  Api, HttpMethod, Operation, ResponseSpec, Schema,
  SecurityScheme, SecurityRequirement
} from './types.ts'

function toResponseSpec(
  status: number,
  value: unknown,
  range?: boolean
): ResponseSpec {
  const record = asRecord(value)
  const headers: Record<string, Schema> = {}
  for (const [name, header] of Object.entries(asRecord(record['headers']))) {
    headers[name] = asRecord(asRecord(header)['schema']) as Schema
  }
  return {
    status,
    ...(range === true ? { range: true } : {}),
    description: record['description'] as string | undefined,
    headers,
    content: toContent(record['content'])
  }
}

/** OpenAPI 3.x range keys — `1XX` through `5XX`. */
const RANGE_KEY = /^([1-5])XX$/i
const EXACT_KEY = /^[1-5][0-9]{2}$/

function toResponses(
  raw: unknown
): { responses: ResponseSpec[]; defaultResponse?: ResponseSpec } {
  const responses: ResponseSpec[] = []
  let defaultResponse: ResponseSpec | undefined
  for (const [code, value] of Object.entries(asRecord(raw))) {
    if (code === 'default') {
      defaultResponse = toResponseSpec(0, value)
      continue
    }
    // `Number.parseInt` is a converter here, never a parser. Used as one it
    // read '4XX' as 4 and '200abc' as 200, so a declared error contract loaded
    // under a status no request can produce and the built-in envelope served
    // in its place. The key is tested first, converted second.
    const ranged = RANGE_KEY.exec(code)
    if (ranged) {
      responses.push(
        toResponseSpec(Number.parseInt(ranged[1] as string, 10) * 100, value, true)
      )
      continue
    }
    if (!EXACT_KEY.test(code)) continue
    responses.push(toResponseSpec(Number.parseInt(code, 10), value))
  }
  // By status, then an exact status before a range sharing its bound.
  //
  // The tiebreak is defense in depth, not load-bearing, and deliberately kept
  // after being shown unobservable: an exact key like '400' is integer-like and
  // JS iterates it before a string key like '4XX' whatever the document's own
  // order, so `Object.entries` already hands them over exact-first and a stable
  // sort preserves that. Nothing downstream depends on this order either —
  // `responseForStatus` selects exact over range explicitly rather than by
  // position. It stays because a total sort should not rely on two unrelated
  // language guarantees holding forever.
  responses.sort(
    (a, b) =>
      a.status - b.status || Number(a.range ?? false) - Number(b.range ?? false)
  )
  return { responses, defaultResponse }
}

function toSecuritySchemes(raw: unknown): Record<string, SecurityScheme> {
  const out: Record<string, SecurityScheme> = {}
  for (const [name, value] of Object.entries(asRecord(raw))) {
    const record = asRecord(value)
    out[name] = {
      type: record['type'] as SecurityScheme['type'],
      scheme: record['scheme'] as string | undefined,
      location: record['in'] as SecurityScheme['location'],
      name: record['name'] as string | undefined
    }
  }
  return out
}

function toSecurity(raw: unknown): SecurityRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map((entry) => {
    const out: SecurityRequirement = {}
    for (const [scheme, scopes] of Object.entries(asRecord(entry))) {
      out[scheme] = Array.isArray(scopes) ? (scopes as string[]) : []
    }
    return out
  })
}

export function loadApi(doc: Record<string, unknown>): Api {
  const version = doc['openapi']
  if (typeof version !== 'string') {
    throw new Error(
      'mockingham: document is missing a string "openapi" version field. ' +
        'Swagger 2.0 documents are not supported.'
    )
  }

  const { document: resolved, schemaNames } = resolveDocument(doc)
  const securitySchemes = toSecuritySchemes(
    asRecord(resolved['components'])['securitySchemes']
  )
  // A document-level `security` is the default for operations that declare
  // none. An operation's own `security: []` must survive as an empty array —
  // it opts out of that default — so the fallback tests for `undefined`, not
  // for emptiness.
  const documentSecurity = toSecurity(resolved['security'])
  const operations: Operation[] = []

  const rawPaths = resolved['paths']
  if (
    rawPaths !== undefined &&
    (rawPaths === null || typeof rawPaths !== 'object' || Array.isArray(rawPaths))
  ) {
    throw new Error(
      'mockingham: document "paths" must be an object when present. ' +
        'An absent "paths" is allowed; a malformed one is not, because it would ' +
        'silently produce a mock with no routes.'
    )
  }

  for (const [path, rawItem] of Object.entries(asRecord(rawPaths))) {
    const item = asRecord(rawItem)
    const shared = Array.isArray(item['parameters'])
      ? (item['parameters'] as unknown[]).map(toParameter)
      : []

    for (const method of HTTP_METHODS) {
      const rawOp = item[method]
      if (rawOp === undefined) continue
      const op = asRecord(rawOp)
      const own = Array.isArray(op['parameters'])
        ? (op['parameters'] as unknown[]).map(toParameter)
        : []
      const merged = [...shared]
      for (const param of own) {
        const index = merged.findIndex(
          (p) => p.name === param.name && p.location === param.location
        )
        if (index === -1) merged.push(param)
        else merged[index] = param
      }

      const { responses, defaultResponse } = toResponses(op['responses'])
      operations.push({
        method: method as HttpMethod,
        path,
        operationId: op['operationId'] as string | undefined,
        summary: op['summary'] as string | undefined,
        description: op['description'] as string | undefined,
        // Non-strings are dropped rather than coerced — same treatment every
        // other array in this loader gives a malformed entry. A tag is a
        // filter key; a coerced "7" would match nothing and look like a bug.
        tags: Array.isArray(op['tags'])
          ? (op['tags'] as unknown[]).filter((tag): tag is string => typeof tag === 'string')
          : [],
        parameters: merged,
        requestBody: op['requestBody']
          ? toContent(asRecord(op['requestBody'])['content'])
          : undefined,
        requestBodyRequired: asRecord(op['requestBody'])['required'] === true,
        responses,
        defaultResponse,
        security: toSecurity(op['security']) ?? documentSecurity,
        callbacks: toCallbacks(op['callbacks'])
      })
    }
  }

  const webhooks = toWebhooks(resolved['webhooks'])
  // A callback contributes its payload schema under its own name, so `emit()`
  // has one place to look rather than two. A top-level `webhooks` entry wins a
  // collision: it is the document's more explicit declaration of the same event.
  for (const operation of operations) {
    for (const callback of operation.callbacks) {
      if (webhooks[callback.name] !== undefined) continue
      webhooks[callback.name] = {
        name: callback.name,
        method: callback.method,
        body: callback.body,
        headers: []
      }
    }
  }

  return { version, operations, schemaNames, securitySchemes, webhooks }
}

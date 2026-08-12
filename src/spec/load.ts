import { resolveDocument } from './refs.ts'
import { HTTP_METHODS } from './types.ts'
import type {
  Api, HttpMethod, MediaType, Operation, Parameter, ResponseSpec, Schema,
  SecurityScheme, SecurityRequirement
} from './types.ts'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function toParameter(raw: unknown): Parameter {
  const record = asRecord(raw)
  return {
    name: String(record['name'] ?? ''),
    location: (record['in'] ?? 'query') as Parameter['location'],
    required: record['required'] === true,
    schema: asRecord(record['schema']) as Schema
  }
}

function toContent(raw: unknown): Record<string, MediaType> {
  const out: Record<string, MediaType> = {}
  for (const [mediaType, value] of Object.entries(asRecord(raw))) {
    const record = asRecord(value)
    out[mediaType] = {
      schema: asRecord(record['schema']) as Schema,
      example: record['example'],
      examples: record['examples'] as MediaType['examples']
    }
  }
  return out
}

function toResponseSpec(status: number, value: unknown): ResponseSpec {
  const record = asRecord(value)
  const headers: Record<string, Schema> = {}
  for (const [name, header] of Object.entries(asRecord(record['headers']))) {
    headers[name] = asRecord(asRecord(header)['schema']) as Schema
  }
  return {
    status,
    description: record['description'] as string | undefined,
    headers,
    content: toContent(record['content'])
  }
}

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
    const status = Number.parseInt(code, 10)
    if (Number.isNaN(status)) continue
    responses.push(toResponseSpec(status, value))
  }
  responses.sort((a, b) => a.status - b.status)
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
        parameters: merged,
        requestBody: op['requestBody']
          ? toContent(asRecord(op['requestBody'])['content'])
          : undefined,
        requestBodyRequired: asRecord(op['requestBody'])['required'] === true,
        responses,
        defaultResponse,
        security: toSecurity(op['security']) ?? documentSecurity
      })
    }
  }

  return { version, operations, schemaNames, securitySchemes }
}

import { resolveDocument } from './refs.ts'
import { HTTP_METHODS } from './types.ts'
import type {
  Api, HttpMethod, MediaType, Operation, Parameter, ResponseSpec, Schema
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

function toResponses(raw: unknown): ResponseSpec[] {
  const out: ResponseSpec[] = []
  for (const [code, value] of Object.entries(asRecord(raw))) {
    const status = Number.parseInt(code, 10)
    if (Number.isNaN(status)) continue
    const record = asRecord(value)
    const headers: Record<string, Schema> = {}
    for (const [name, header] of Object.entries(asRecord(record['headers']))) {
      headers[name] = asRecord(asRecord(header)['schema']) as Schema
    }
    out.push({
      status,
      description: record['description'] as string | undefined,
      headers,
      content: toContent(record['content'])
    })
  }
  return out.sort((a, b) => a.status - b.status)
}

export function loadApi(doc: Record<string, unknown>): Api {
  const version = doc['openapi']
  if (typeof version !== 'string') {
    throw new Error(
      'mockingham: document is missing a string "openapi" version field. ' +
        'Swagger 2.0 documents are not supported.'
    )
  }

  const resolved = resolveDocument(doc)
  const operations: Operation[] = []

  for (const [path, rawItem] of Object.entries(asRecord(resolved['paths']))) {
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
        responses: toResponses(op['responses'])
      })
    }
  }

  return { version, operations }
}

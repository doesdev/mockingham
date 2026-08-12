import type { MediaType, Parameter, Schema } from './types.ts'

/**
 * Shared by `load.ts` and `webhooks.ts`. They live here rather than in
 * `load.ts` because `load.ts` calls into `webhooks.ts`, and importing back the
 * other way would be a cycle.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

export function toParameter(raw: unknown): Parameter {
  const record = asRecord(raw)
  return {
    name: String(record['name'] ?? ''),
    location: (record['in'] ?? 'query') as Parameter['location'],
    required: record['required'] === true,
    schema: asRecord(record['schema']) as Schema
  }
}

export function toContent(raw: unknown): Record<string, MediaType> {
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

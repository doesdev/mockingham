import type { Schema } from '../spec/types.ts'

export type SchemaKind =
  | {
      kind: 'object'
      properties: Record<string, Schema>
      required: string[]
      additional: Schema | false
    }
  | { kind: 'array'; items: Schema }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'integer' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'enum'; values: unknown[] }
  | { kind: 'const'; value: unknown }
  | { kind: 'union'; variants: Schema[]; discriminator?: string }
  | { kind: 'unknown' }

function typeNames(schema: Schema): string[] {
  if (Array.isArray(schema.type)) return schema.type
  if (typeof schema.type === 'string') return [schema.type]
  return []
}

export function isNullable(schema: Schema): boolean {
  return schema.nullable === true || typeNames(schema).includes('null')
}

export function mergeAllOf(schema: Schema): Schema {
  if (!schema.allOf || schema.allOf.length === 0) return schema

  const merged: Schema = { ...schema }
  delete merged.allOf

  const properties: Record<string, Schema> = { ...(schema.properties ?? {}) }
  const required = new Set<string>(schema.required ?? [])

  for (const part of schema.allOf) {
    const resolved = mergeAllOf(part)
    if (resolved.type !== undefined && merged.type === undefined) {
      merged.type = resolved.type
    }
    for (const [key, value] of Object.entries(resolved.properties ?? {})) {
      properties[key] = value
    }
    for (const name of resolved.required ?? []) required.add(name)
  }

  if (Object.keys(properties).length > 0) {
    merged.properties = properties
    if (merged.type === undefined) merged.type = 'object'
  }
  if (required.size > 0) merged.required = [...required]

  return merged
}

export function classify(input: Schema): SchemaKind {
  const schema = mergeAllOf(input)

  if (schema.const !== undefined) return { kind: 'const', value: schema.const }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: 'enum', values: schema.enum }
  }

  const variants = schema.oneOf ?? schema.anyOf
  if (Array.isArray(variants) && variants.length > 0) {
    return {
      kind: 'union',
      variants,
      discriminator: schema.discriminator?.propertyName
    }
  }

  const names = typeNames(schema).filter((name) => name !== 'null')
  const primary = names[0]

  if (primary === 'object' || (primary === undefined && schema.properties)) {
    const additional =
      schema.additionalProperties === false
        ? false
        : typeof schema.additionalProperties === 'object'
          ? schema.additionalProperties
          : {}
    return {
      kind: 'object',
      properties: schema.properties ?? {},
      required: schema.required ?? [],
      additional
    }
  }

  if (primary === 'array' || (primary === undefined && schema.items)) {
    return { kind: 'array', items: schema.items ?? {} }
  }

  if (primary === 'string') return { kind: 'string' }
  if (primary === 'integer') return { kind: 'integer' }
  if (primary === 'number') return { kind: 'number' }
  if (primary === 'boolean') return { kind: 'boolean' }
  if (typeNames(schema).length > 0 && names.length === 0) return { kind: 'null' }

  return { kind: 'unknown' }
}

import type { Schema } from '../spec/types.ts'

export type SchemaKind =
  | {
      kind: 'object'
      properties: Record<string, Schema>
      required: string[]
      additional: Schema | false
    }
  | {
      kind: 'array'
      /**
       * The schema for every position past `prefix`. `{}` when the document
       * declares nothing there - including when `items` is `false`, which
       * `closed` records instead.
       */
      items: Schema
      /**
       * `prefixItems`, the tuple positions: `prefix[i]` governs index `i`.
       * Empty for an ordinary list. Both generation and compilation read this,
       * so a tuple cannot be generated one way and validated another.
       */
      prefix: Schema[]
      /** `items: false` - no position past the tuple is allowed at all. */
      closed: boolean
    }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'integer' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'enum'; values: unknown[] }
  | { kind: 'const'; value: unknown }
  | {
      kind: 'union'
      variants: Schema[]
      mode: 'one' | 'any'
      discriminator?: string
    }
  | { kind: 'unknown' }

function typeNames(schema: Schema): string[] {
  if (Array.isArray(schema.type)) return schema.type
  if (typeof schema.type === 'string') return [schema.type]
  return []
}

export function isNullable(schema: Schema): boolean {
  return schema.nullable === true || typeNames(schema).includes('null')
}

/**
 * Flattens `allOf` composition into a single schema.
 *
 * One precedence rule, applied to every keyword alike: `allOf` members are
 * merged in declaration order so a later member overrides an earlier one, and
 * the outer schema's own keywords then override all members. `properties` and
 * `required` accumulate instead of replacing - properties union with the outer
 * schema winning a key collision, required is a plain union.
 *
 * Every keyword is carried through, not just the structural ones. A constraint
 * that lives only on an `allOf` member (`minLength`, `pattern`, `format`,
 * `multipleOf`, …) must survive, or generation and validation would both
 * silently ignore it.
 */
export function mergeAllOf(schema: Schema): Schema {
  return merge(schema, new Set())
}

/**
 * `seen` carries the schemas being merged on the CURRENT path, and is copied
 * rather than shared so a cycle is skipped while a diamond is not.
 *
 * A member already on the path is a tautology - `A: { allOf: [A] }` says A must
 * satisfy A - so skipping it loses nothing and the merged result is exactly
 * what the document means. Ref resolution makes every reference to a component
 * the same object, so such a schema really does contain itself, and merging it
 * used to recurse until the stack ran out.
 *
 * Sharing one set across sibling members instead of copying would be wrong in
 * the other direction: a schema reached through two siblings is a diamond, not
 * a cycle, and skipping its second visit would silently drop its contribution.
 */
function merge(schema: Schema, seen: Set<Schema>): Schema {
  if (!schema.allOf || schema.allOf.length === 0) return schema

  const nested = new Set(seen)
  nested.add(schema)

  const own: Record<string, unknown> = { ...schema }
  delete own['allOf']

  const merged: Record<string, unknown> = {}
  const properties: Record<string, Schema> = {}
  const required = new Set<string>()

  const absorb = (source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (key === 'properties' || key === 'required') continue
      merged[key] = value
    }
    const sourceProps = source['properties'] as
      | Record<string, Schema>
      | undefined
    for (const [name, prop] of Object.entries(sourceProps ?? {})) {
      properties[name] = prop
    }
    for (const name of (source['required'] as string[] | undefined) ?? []) {
      required.add(name)
    }
  }

  for (const part of schema.allOf) {
    if (nested.has(part)) continue
    absorb(merge(part, nested) as unknown as Record<string, unknown>)
  }
  absorb(own)

  const result = merged as Schema
  if (Object.keys(properties).length > 0) {
    result.properties = properties
    if (result.type === undefined) result.type = 'object'
  }
  if (required.size > 0) result.required = [...required]

  return result
}

/**
 * Every const-valued property on a branch, as strings, in `Object.keys` order.
 *
 * Schema interpretation lives here, beside `classify`, and nowhere else
 * (invariant 1) - generation calls `matchesVariant` rather than reading
 * `properties` itself.
 *
 * With a formal `discriminator` only that property is considered - a document
 * that declares one has said which property names its branches, and letting a
 * second const property match anyway would ignore that declaration.
 *
 * On order: this is NOT literal declaration order. `Object.keys` lists
 * integer-like keys first in ascending numeric order, and after `mergeAllOf`
 * the `properties` object has been rebuilt as the allOf members' properties
 * followed by the outer schema's own - so "order" here means merge order, not
 * the order a reader sees in the document. That is good enough: the order is a
 * pure function of the schema and so still deterministic across processes
 * (invariant 2), and the only consumer that depends on it at all is
 * `variantName`, which takes the first entry. `matchesVariant` - the selection
 * path - is order-insensitive.
 */
function constValues(branch: Schema, discriminator?: string): string[] {
  const properties = mergeAllOf(branch).properties
  if (!properties) return []

  const names =
    discriminator === undefined ? Object.keys(properties) : [discriminator]

  const values: string[] = []
  for (const name of names) {
    const property = properties[name]
    if (property === undefined) continue
    const kind = classify(property)
    if (kind.kind !== 'const') continue
    if (
      typeof kind.value === 'string' ||
      typeof kind.value === 'number' ||
      typeof kind.value === 'boolean'
    ) {
      values.push(String(kind.value))
    }
  }
  return values
}

/**
 * The name a branch is known by - its first const-valued property, or its
 * discriminator property when one is declared. For describing a union to a
 * reader; SELECTION uses `matchesVariant`, which is not the same question when
 * a branch carries more than one const property.
 */
export function variantName(
  branch: Schema,
  discriminator?: string
): string | undefined {
  return constValues(branch, discriminator)[0]
}

/**
 * Whether a branch answers to `name`. Design section 5.1: with no formal
 * discriminator a branch matches when ANY of its const-valued properties
 * equals the requested name, so `{ kind: 'refund', status: 'pending' }` is
 * reachable by either. `variantName` alone would reach only the first.
 */
export function matchesVariant(
  branch: Schema,
  discriminator: string | undefined,
  name: string
): boolean {
  return constValues(branch, discriminator).includes(name)
}

export function classify(input: Schema): SchemaKind {
  const schema = mergeAllOf(input)

  if (schema.const !== undefined) return { kind: 'const', value: schema.const }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: 'enum', values: schema.enum }
  }

  // oneOf and anyOf differ: oneOf must match exactly one variant, anyOf at
  // least one. Only this module can preserve the distinction, so `mode` carries
  // it - a validator built on `classify` cannot recover it any other way.
  const variants = schema.oneOf ?? schema.anyOf
  if (Array.isArray(variants) && variants.length > 0) {
    return {
      kind: 'union',
      variants,
      mode: schema.oneOf ? 'one' : 'any',
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

  const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : []
  if (
    primary === 'array' ||
    (primary === undefined && (schema.items || prefixItems.length > 0))
  ) {
    return {
      kind: 'array',
      items: schema.items === false || schema.items === undefined
        ? {}
        : schema.items,
      prefix: prefixItems,
      closed: schema.items === false
    }
  }

  if (primary === 'string') return { kind: 'string' }
  if (primary === 'integer') return { kind: 'integer' }
  if (primary === 'number') return { kind: 'number' }
  if (primary === 'boolean') return { kind: 'boolean' }
  if (typeNames(schema).length > 0 && names.length === 0) return { kind: 'null' }

  return { kind: 'unknown' }
}

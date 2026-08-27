import type { Schema } from '../spec/types.ts'

/**
 * A schema position that may hold a boolean instead of an object. JSON Schema
 * allows one anywhere a schema is expected; `properties` is where it actually
 * turns up in practice, spelled `false` to forbid a key.
 */
export type SchemaNode = Schema | boolean

export type SchemaKind =
  | {
      kind: 'object'
      properties: Record<string, SchemaNode>
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
      /**
       * The shape the schema declares BESIDE its union, when it declares one -
       * the same schema with `oneOf`/`anyOf` removed. Under JSON Schema those
       * are constraints on the same instance, so `type: object` + `properties`
       * beside an `anyOf` still describes the object, and `type: array` +
       * `items` beside one still describes the array; consumers apply the base
       * and the chosen branch together. Only a container shape - object or
       * array - is recognized, by exactly the tests `classify` uses for each.
       * `undefined` for the purely alternative union, which is the common case
       * and the one whose bytes must never move.
       */
      base?: Schema
    }
  | { kind: 'never' }
  | { kind: 'unknown' }

/**
 * The one reading of a boolean schema position. `true` allows anything and so
 * reads as `{}`; `false` allows nothing and has no `Schema` equivalent, so it
 * is reported as the literal `'never'`. Generation skips a `'never'` property,
 * validation rejects one - both from this single answer (invariant 1).
 */
export function normalizeNode(node: SchemaNode): Schema | 'never' {
  if (node === true) return {}
  if (node === false) return 'never'
  return node
}

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
  const properties: Record<string, SchemaNode> = {}
  const required = new Set<string>()

  const absorb = (source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (key === 'properties' || key === 'required') continue
      merged[key] = value
    }
    const sourceProps = source['properties'] as
      | Record<string, SchemaNode>
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

/**
 * How `if`/`then`/`else` is expressed in the shared interpretation.
 *
 * The keywords cannot become a `SchemaKind`: a conditional applies BESIDE a
 * type rather than instead of one - the reproduction schema is still an object
 * - so folding it into `classify` would have to erase the object-ness to say
 * so. It is a separate question about the same schema, asked here and answered
 * once, the way `matchesVariant` is.
 *
 * Both halves read the same four fields, each taking what it needs from them:
 *
 * - Validation (`src/schema/compile.ts`) reads `when`, `onTrue` and `onFalse`
 *   and applies the JSON Schema rule directly: a value satisfying `when` must
 *   satisfy `onTrue`, one that does not must satisfy `onFalse`.
 * - Generation (`src/generate/generate.ts`) reads `whenTrue`/`whenFalse`, the
 *   two effective schemas a value on each branch must conform to, and then
 *   CHECKS the value it produced against `when` with that same compiler. So
 *   the branch decision and the branch check are the one reading too - there
 *   is no second notion of "did this take the then branch" anywhere.
 */
export interface Conditional {
  /** The `if` subschema, exactly as declared. */
  when: Schema
  /** The `then` subschema, when the document declares one. */
  onTrue?: Schema
  /** The `else` subschema, when the document declares one. */
  onFalse?: Schema
  /**
   * base ∧ if ∧ then - everything a value that takes the `then` branch must
   * satisfy, folded together by the same `allOf` merge every other composition
   * goes through.
   */
  whenTrue: Schema
  /** base ∧ else - the same for a value that takes the `else` branch. */
  whenFalse: Schema
}

// Keyed on the schema's identity so the two effective schemas are built once
// and keep a stable identity of their own - which is what lets the compiler's
// own WeakMap cache them, and what keeps generation from re-merging on every
// request. `null` records "asked, and this schema has no conditional".
const conditionals = new WeakMap<Schema, Conditional | null>()

export function conditionalOf(input: Schema): Conditional | undefined {
  const cached = conditionals.get(input)
  if (cached !== undefined) return cached ?? undefined

  const schema = mergeAllOf(input)
  const when = schema.if
  const onTrue = schema.then
  const onFalse = schema.else
  // `if` alone constrains nothing: with neither branch declared, both outcomes
  // are vacuously satisfied.
  if (when === undefined || (onTrue === undefined && onFalse === undefined)) {
    conditionals.set(input, null)
    return undefined
  }

  const base: Record<string, unknown> = { ...schema }
  delete base['if']
  delete base['then']
  delete base['else']
  const stripped = base as Schema

  const conditional: Conditional = {
    when,
    onTrue,
    onFalse,
    whenTrue: mergeAllOf({
      allOf: onTrue === undefined ? [stripped, when] : [stripped, when, onTrue]
    }),
    whenFalse: mergeAllOf({
      allOf: onFalse === undefined ? [stripped] : [stripped, onFalse]
    })
  }
  conditionals.set(input, conditional)
  return conditional
}

/**
 * The `not` subschema, when the schema declares one.
 *
 * A negation is the same kind of thing a conditional is - a constraint BESIDE
 * a type rather than instead of one. `{ type: 'string', not: { const: 'x' } }`
 * is still a string, so folding `not` into `classify` would have to erase the
 * string-ness to say so. It is a separate question about the same schema,
 * asked here and answered once, the way `conditionalOf` is.
 *
 * Both halves read this one answer:
 *
 * - Validation (`src/schema/compile.ts`) compiles it and rejects any value it
 *   accepts, which is the JSON Schema rule exactly.
 * - Generation (`src/generate/generate.ts`) compiles it with that same
 *   compiler and redraws a bounded number of times when the value it produced
 *   lands inside it. Where it cannot escape, it serves the value anyway
 *   (invariant 4) - a schema we cannot fully satisfy is not an error.
 *
 * The merged view is read, so a negation declared on an `allOf` member counts.
 * `mergeAllOf`'s uniform precedence applies: with `not` on two members the
 * later one wins rather than the two conjoining, the same way every other
 * keyword behaves there.
 */
export function negationOf(input: Schema): Schema | undefined {
  return mergeAllOf(input).not
}

/**
 * Cached so the base is the SAME object every time a schema is classified.
 * The compiler caches compiled schemas on identity and guards recursion the
 * same way, both of which a freshly built base would defeat.
 */
const bases = new WeakMap<Schema, Schema>()

/**
 * The sibling shape of a schema that declares one alongside its union, or
 * `undefined` when the union is purely alternative.
 *
 * Either container shape counts, recognized by exactly the tests `classify`
 * itself uses further down - an object (`type: object`, bare `properties`, or
 * bare `required`) or an array (`type: array`, bare `items`, or bare
 * `prefixItems`). Both are forms documents actually write: `anyOf:
 * [{required: [email]}, {required: [phone]}]` beside the properties it
 * constrains, and `anyOf: [{minItems: 2}, {maxItems: 0}]` beside the `items`
 * it constrains. Stripping the union keywords is all that is needed: what
 * remains classifies as the container it always was.
 *
 * A bare `required` counts for the reason given in `classify`: it is how
 * `anyOf: [{ required: ['email'] }]` beside a schema that declares only
 * `required` is written, and reading it as `unknown` made it vacuous. A bare
 * `items` counts for the same reason on the other branch - a union branch
 * declaring only `minItems` classifies as `unknown` and constrains nothing, so
 * discarding the array shape made the whole schema accept anything at all.
 *
 * A schema declaring neither - a scalar, or nothing at all beside its union -
 * has no sibling shape, and that purely alternative union is the common case.
 */
function siblingBase(schema: Schema, key: Schema): Schema | undefined {
  const declaresObject =
    typeNames(schema).includes('object') ||
    schema.properties !== undefined ||
    schema.required !== undefined
  const declaresArray =
    typeNames(schema).includes('array') ||
    schema.items !== undefined ||
    (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0)
  if (!declaresObject && !declaresArray) return undefined

  // Keyed on the schema as WRITTEN, not the merged view: `mergeAllOf` returns
  // a fresh object for an allOf schema, which would never hit the cache.
  const cached = bases.get(key)
  if (cached) return cached

  const base: Record<string, unknown> = { ...schema }
  delete base['oneOf']
  delete base['anyOf']
  delete base['discriminator']
  const result = base as Schema
  bases.set(key, result)
  return result
}

/**
 * Two levels of WeakMap so the folded schema is the SAME object every time a
 * (base, branch) pair is asked for - the compiler caches on identity and
 * `conditionalOf` keys its own cache the same way, both of which a freshly
 * merged object would defeat on every request.
 */
const foldedBranches = new WeakMap<Schema, WeakMap<Schema, Schema>>()

/**
 * base ∧ branch: everything a value taking `variant` of a union must satisfy
 * when the schema declares a shape beside that union.
 *
 * Needed only where the branch cannot be applied ON TOP of a generated value.
 * An OBJECT branch contributes properties, so generation lays it over the base
 * and validation intersects the two - and a branch declaring only `required`
 * classifies as an object anyway, so nothing is lost. An ARRAY branch is not
 * like that: `anyOf: [{minItems: 2}, {maxItems: 0}]` declares bounds and no
 * content, classifies as `unknown` on its own, and so constrains nothing at
 * all until it is read against the array it sits beside. Folding is what gives
 * it something to constrain.
 *
 * Both halves call THIS, through the same `allOf` merge `conditionalOf` builds
 * its effective schemas with - so a bound generation honors is a bound
 * validation enforces, which is the whole of invariant 1.
 */
export function foldBranch(base: Schema, variant: Schema): Schema {
  let byVariant = foldedBranches.get(base)
  if (byVariant === undefined) {
    byVariant = new WeakMap()
    foldedBranches.set(base, byVariant)
  }
  const cached = byVariant.get(variant)
  if (cached) return cached
  const folded = mergeAllOf({ allOf: [base, variant] })
  byVariant.set(variant, folded)
  return folded
}

export function classify(input: SchemaNode): SchemaKind {
  const node = normalizeNode(input)
  if (node === 'never') return { kind: 'never' }
  const schema = mergeAllOf(node)

  if (schema.const !== undefined) return { kind: 'const', value: schema.const }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: 'enum', values: schema.enum }
  }

  // oneOf and anyOf differ: oneOf must match exactly one variant, anyOf at
  // least one. Only this module can preserve the distinction, so `mode` carries
  // it - a validator built on `classify` cannot recover it any other way.
  const variants = schema.oneOf ?? schema.anyOf
  if (Array.isArray(variants) && variants.length > 0) {
    // A shape declared BESIDE the union is not an alternative to it: both
    // constrain the same instance. Discarding it collapsed the whole subtree.
    const base = siblingBase(schema, node)
    return {
      kind: 'union',
      variants,
      mode: schema.oneOf ? 'one' : 'any',
      discriminator: schema.discriminator?.propertyName,
      ...(base === undefined ? {} : { base })
    }
  }

  const names = typeNames(schema).filter((name) => name !== 'null')
  const primary = names[0]

  // A bare `required` with no `properties` and no `type` is still an object
  // schema - `then: { required: ['reason'] }` is the common way to write one -
  // and reading it as `unknown` made such a branch vacuously satisfiable.
  if (
    primary === 'object' ||
    (primary === undefined && (schema.properties || schema.required))
  ) {
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

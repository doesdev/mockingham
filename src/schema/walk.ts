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
      /**
       * `patternProperties`, in the document's own `Object.entries` order.
       * Both halves read it from here: generation invents a member for an
       * entry no declared property covers, validation applies the entry to
       * every matching key AND treats such a key as non-additional. Empty for
       * the ordinary object.
       */
      patternProperties: Record<string, SchemaNode>
      /**
       * `propertyNames` - the schema every property NAME must satisfy - or
       * `undefined` when the document declares none. A `SchemaNode`, so
       * `propertyNames: false` reaches `normalizeNode` like any other boolean
       * schema position rather than becoming a second notion of "no keys".
       */
      propertyNames?: SchemaNode
      /** `dependentRequired`: trigger name -> the names its presence demands. */
      dependentRequired: Record<string, string[]>
      /** `dependentSchemas`: trigger name -> the schema its presence imposes. */
      dependentSchemas: Record<string, SchemaNode>
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
       * beside an `anyOf` still describes the object; consumers apply the base
       * and the chosen branch together. `undefined` for the purely alternative
       * union, which is the common case.
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
/**
 * The keywords `absorb` accumulates rather than overwrites. Probed with `.has`
 * and never iterated, so it brings no unordered traversal with it.
 */
const ACCUMULATED = new Set([
  'properties',
  'required',
  'patternProperties',
  'dependentSchemas',
  'dependentRequired'
])

function merge(schema: Schema, seen: Set<Schema>): Schema {
  if (!schema.allOf || schema.allOf.length === 0) return schema

  const nested = new Set(seen)
  nested.add(schema)

  const own: Record<string, unknown> = { ...schema }
  delete own['allOf']

  const merged: Record<string, unknown> = {}
  const properties: Record<string, SchemaNode> = {}
  const required = new Set<string>()
  // Accumulated for the same reason `properties` is: `allOf` is a conjunction,
  // so two members each naming a pattern - or each naming a dependency - both
  // constrain the instance. Plain last-wins would silently drop one of them.
  const patternProperties: Record<string, SchemaNode> = {}
  const dependentSchemas: Record<string, SchemaNode> = {}
  const dependentRequired: Record<string, string[]> = {}

  const absorbMap = (
    into: Record<string, SchemaNode>,
    source: Record<string, unknown>,
    key: string
  ): void => {
    const from = source[key] as Record<string, SchemaNode> | undefined
    for (const [name, node] of Object.entries(from ?? {})) into[name] = node
  }

  const absorb = (source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (ACCUMULATED.has(key)) continue
      merged[key] = value
    }
    absorbMap(properties, source, 'properties')
    absorbMap(patternProperties, source, 'patternProperties')
    absorbMap(dependentSchemas, source, 'dependentSchemas')
    for (const name of (source['required'] as string[] | undefined) ?? []) {
      required.add(name)
    }
    const dependencies = source['dependentRequired'] as
      | Record<string, string[]>
      | undefined
    for (const [trigger, names] of Object.entries(dependencies ?? {})) {
      // A union per trigger, in first-seen order - the same shape `required`
      // takes, and deterministic because it is a pure function of the schema.
      const existing = dependentRequired[trigger] ?? []
      dependentRequired[trigger] = [
        ...existing,
        ...names.filter((name) => !existing.includes(name))
      ]
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
  if (Object.keys(patternProperties).length > 0) {
    result.patternProperties = patternProperties
  }
  if (Object.keys(dependentSchemas).length > 0) {
    result.dependentSchemas = dependentSchemas
  }
  if (Object.keys(dependentRequired).length > 0) {
    result.dependentRequired = dependentRequired
  }

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
 * Cached so the base is the SAME object every time a schema is classified.
 * The compiler caches compiled schemas on identity and guards recursion the
 * same way, both of which a freshly built base would defeat.
 */
const bases = new WeakMap<Schema, Schema>()

/**
 * The sibling shape of a schema that declares one alongside its union, or
 * `undefined` when the union is purely alternative.
 *
 * Only an object shape counts today - `type: object` or bare `properties` -
 * which is the form documents actually write (`anyOf: [{required: [email]},
 * {required: [phone]}]` beside the properties it constrains). Stripping the
 * union keywords is all that is needed: what remains classifies as the object
 * it always was.
 *
 * A bare `required` counts too, for the reason given in `classify`: it is how
 * `anyOf: [{ required: ['email'] }]` beside a schema that declares only
 * `required` is written, and reading it as `unknown` made it vacuous.
 */
function siblingBase(schema: Schema, key: Schema): Schema | undefined {
  const declaresObject =
    typeNames(schema).includes('object') ||
    schema.properties !== undefined ||
    schema.required !== undefined
  if (!declaresObject) return undefined

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
 * Cached for the same reason `bases` is: the compiler keys on identity, and a
 * freshly built schema on every `classify` call would never hit that cache.
 */
const nameSchemas = new WeakMap<Schema, Schema>()

/**
 * The `propertyNames` subschema, with its type supplied.
 *
 * The instance handed to it is a property NAME, which is always a string - so
 * a document writing `propertyNames: { pattern: "^[a-z]+$" }` or
 * `{ maxLength: 4 }` has written a string schema without saying so, and that is
 * how essentially every document writes it. Supplying `type: 'string'` HERE,
 * once, is what lets both halves read the position through the ordinary
 * `classify` path: without it the subschema classifies as `unknown`, validation
 * accepts every name, and generation believes every name is legal.
 *
 * A boolean passes through untouched - `false` still means "no name is legal" -
 * and a subschema that states its own `type` is left exactly as written.
 */
function nameSchemaOf(node: SchemaNode): SchemaNode {
  if (typeof node === 'boolean') return node
  if (node.type !== undefined) return node
  const cached = nameSchemas.get(node)
  if (cached) return cached
  const typed: Schema = { ...node, type: 'string' }
  nameSchemas.set(node, typed)
  return typed
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
  // `patternProperties`, `propertyNames`, `dependentRequired` and
  // `dependentSchemas` join `properties` and `required` here for the same
  // reason: each is an object constraint and nothing else, so a schema whose
  // only keyword is one of them describes an object. Reading it as `unknown`
  // made it vacuous in validation and generated `null` where the document
  // plainly meant a map.
  if (
    primary === 'object' ||
    (primary === undefined &&
      (schema.properties ||
        schema.required ||
        schema.patternProperties ||
        schema.propertyNames !== undefined ||
        schema.dependentRequired ||
        schema.dependentSchemas))
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
      additional,
      patternProperties: schema.patternProperties ?? {},
      ...(schema.propertyNames === undefined
        ? {}
        : { propertyNames: nameSchemaOf(schema.propertyNames) }),
      dependentRequired: schema.dependentRequired ?? {},
      dependentSchemas: schema.dependentSchemas ?? {}
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

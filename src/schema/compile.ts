import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Schema } from '../spec/types.ts'
import type { SchemaKind, SchemaNode } from './walk.ts'
import { classify, conditionalOf, isNullable, mergeAllOf, normalizeNode } from './walk.ts'
import { canonicalKey } from './equal.ts'

/**
 * Compiles an OpenAPI schema to a zod schema THROUGH `classify()` - the same
 * interpretation value generation uses. That shared reading is the whole point:
 * what we generate and what we validate can never disagree about a schema.
 */
export interface Compiler {
  compile(schema: SchemaNode): ZodType
}

/**
 * A `pattern` ECMAScript cannot compile (a POSIX class, a .NET construct, a
 * plain typo) must not take the whole operation down. Generation serves such a
 * document fine, and validation being the stricter of the two would turn every
 * request into a 500 over a constraint we simply cannot enforce. So the pattern
 * is dropped and the remaining constraints still apply.
 */
function patternOf(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

function withStringRules(schema: Schema): ZodType {
  let out = z.string()
  if (schema.minLength !== undefined) out = out.min(schema.minLength)
  if (schema.maxLength !== undefined) out = out.max(schema.maxLength)
  if (schema.pattern !== undefined) {
    const expression = patternOf(schema.pattern)
    if (expression) out = out.regex(expression)
  }
  return out
}

function withNumberRules(schema: Schema, integer: boolean): ZodType {
  let out = integer ? z.number().int() : z.number()
  if (schema.minimum !== undefined) out = out.min(schema.minimum)
  if (schema.maximum !== undefined) out = out.max(schema.maximum)
  if (typeof schema.exclusiveMinimum === 'number') {
    out = out.gt(schema.exclusiveMinimum)
  } else if (schema.exclusiveMinimum === true && schema.minimum !== undefined) {
    out = out.gt(schema.minimum)
  }
  if (typeof schema.exclusiveMaximum === 'number') {
    out = out.lt(schema.exclusiveMaximum)
  } else if (schema.exclusiveMaximum === true && schema.maximum !== undefined) {
    out = out.lt(schema.maximum)
  }
  if (schema.multipleOf !== undefined) out = out.multipleOf(schema.multipleOf)
  return out
}

/**
 * True when `variant` qualifies as a discriminated-union member for `key`:
 * an object whose `properties[key]` classifies as a literal-like value
 * (`const` or `enum`). zod 4 requires exactly this shape and does not check
 * it until first parse, so it must be checked here at compile time instead.
 */
function usable(variant: SchemaNode, key: string): boolean {
  const kind = classify(variant)
  if (kind.kind !== 'object') return false
  const property = kind.properties[key]
  if (property === undefined) return false
  const discriminator = classify(property)
  return discriminator.kind === 'const' || discriminator.kind === 'enum'
}

export function createCompiler(): Compiler {
  // Keyed on resolved-schema object identity, so a component referenced by
  // twenty operations compiles once. `$ref` resolution makes every reference to
  // one component the same object, which is what makes identity sufficient.
  const cache = new WeakMap<Schema, ZodType>()
  // Schemas currently being compiled. A recursive schema reaches itself while
  // still mid-compilation, and z.lazy defers that edge until parse time.
  const active = new Set<Schema>()

  function compile(node: SchemaNode): ZodType {
    // A boolean schema carries no keywords and cannot key a WeakMap, so it is
    // answered before the cache. `false` is the shape nothing satisfies.
    const normalized = normalizeNode(node)
    if (normalized === 'never') return z.never()
    const schema = normalized

    const cached = cache.get(schema)
    if (cached) return cached
    if (active.has(schema)) {
      return z.lazy(() => cache.get(schema) ?? z.unknown())
    }

    active.add(schema)
    let built: ZodType
    try {
      built = build(schema)
    } finally {
      // Always released, even when `build` throws (an invalid `pattern`
      // reaching `new RegExp` is the realistic case). Otherwise this schema
      // stays permanently "active", and every later reference to it silently
      // falls back to `z.unknown()` through the lazy branch above - a cache
      // entry that can never be set.
      active.delete(schema)
    }

    const nullable = isNullable(schema) ? built.nullable() : built
    // Metadata only - `.describe()` never changes what parses or what fails,
    // only what `z.toJSONSchema` reports. Attached last (outermost) so it
    // survives on the same node a provider actually reads, rather than
    // nesting inside the `anyOf` a nullable wrapper introduces.
    const final =
      schema.description !== undefined
        ? nullable.describe(schema.description)
        : nullable
    cache.set(schema, final)
    return final
  }

  /** The union itself, before any sibling shape is intersected with it. */
  function buildUnion(kind: Extract<SchemaKind, { kind: 'union' }>): ZodType {
    const variants = kind.variants.map((variant) => compile(variant))
    const key = kind.discriminator
    // zod 4 does not validate discriminated-union variants at
    // construction - it throws on first parse instead. So the shape must
    // be checked here, or a document zod cannot model that way becomes a
    // crash at request time rather than a slower plain union.
    if (key !== undefined && kind.variants.every((variant) => usable(variant, key))) {
      // A discriminator already guarantees at most one match.
      return z.discriminatedUnion(key, variants as never) as ZodType
    }
    if (kind.mode === 'one') {
      // oneOf means EXACTLY one variant matches; a plain union means at
      // least one, which is anyOf's rule.
      return z.unknown().superRefine((value, context) => {
        const matched = variants.filter(
          (variant) => variant.safeParse(value).success
        ).length
        if (matched !== 1) {
          context.addIssue({
            code: 'custom',
            message: `Expected exactly one oneOf variant to match, ${matched} did`
          })
        }
      }) as ZodType
    }
    return z.union(variants as never) as ZodType
  }

  /**
   * `if`/`then`/`else`, applied on top of whatever the schema is otherwise.
   * Straight from the JSON Schema rule: a value that satisfies `if` must
   * satisfy `then`, one that does not must satisfy `else`, and a branch the
   * document does not declare constrains nothing.
   */
  function build(schema: Schema): ZodType {
    const base = buildBase(schema)
    const conditional = conditionalOf(schema)
    if (conditional === undefined) return base

    const when = compile(conditional.when)
    const onTrue =
      conditional.onTrue === undefined ? undefined : compile(conditional.onTrue)
    const onFalse =
      conditional.onFalse === undefined ? undefined : compile(conditional.onFalse)

    return base.superRefine((value, context) => {
      const took = when.safeParse(value).success
      const branch = took ? onTrue : onFalse
      if (branch === undefined) return
      if (branch.safeParse(value).success) return
      context.addIssue({
        code: 'custom',
        message: `Value does not satisfy the schema's \`${took ? 'then' : 'else'}\` branch`
      })
    }) as ZodType
  }

  function buildBase(schema: Schema): ZodType {
    const kind = classify(schema)
    // `classify` merges `allOf` internally to decide the shape, but
    // constraint keywords (`minLength`, `minimum`, `minItems`, ...) still need
    // reading from the merged view - otherwise a bound that lives only on an
    // `allOf` member is silently dropped here even though `classify` saw it.
    const merged = mergeAllOf(schema)

    switch (kind.kind) {
      case 'const':
        return z.literal(kind.value as never)
      case 'enum':
        return z.union(
          kind.values.map((value) => z.literal(value as never))
        ) as ZodType
      case 'string':
        return withStringRules(merged)
      case 'integer':
        return withNumberRules(merged, true)
      case 'number':
        return withNumberRules(merged, false)
      case 'boolean':
        return z.boolean()
      case 'null':
        return z.null()
      case 'union': {
        const union = buildUnion(kind)
        // A shape declared beside the union constrains the same instance, so
        // both must hold. Without this the declared properties went unchecked
        // - `classify` handed validation a bare union of the branches.
        if (kind.base === undefined) return union
        return z.intersection(compile(kind.base), union)
      }
      case 'array': {
        let out = z.array(compile(kind.items))
        if (merged.minItems !== undefined) out = out.min(merged.minItems)
        if (merged.maxItems !== undefined) out = out.max(merged.maxItems)
        if (merged.uniqueItems !== true) return out
        // Members compare through `canonicalKey`, the same identity generation
        // draws against - so an array this rejects is an array generation
        // would never have produced. `seen` is probed, never iterated, so it
        // brings no unordered traversal with it.
        return out.superRefine((items, context) => {
          const seen = new Set<string>()
          for (let index = 0; index < items.length; index++) {
            const key = canonicalKey(items[index])
            if (seen.has(key)) {
              context.addIssue({
                code: 'custom',
                message: 'Array items must be unique',
                path: [index]
              })
              return
            }
            seen.add(key)
          }
        }) as ZodType
      }
      case 'object': {
        const shape: Record<string, ZodType> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          const compiled = compile(property)
          shape[name] = kind.required.includes(name) ? compiled : compiled.optional()
        }
        // A `required` name with no declared property still has to be PRESENT,
        // and zod reads an unconstrained key as optional - so presence is
        // checked on its own. `then: { required: ['reason'] }` is exactly this
        // shape, and without the check it constrained nothing.
        const undeclared = kind.required.filter(
          (name) => !Object.hasOwn(kind.properties, name)
        )
        const object =
          kind.additional === false
            ? z.strictObject(shape)
            : // An `additionalProperties` SCHEMA constrains unknown keys rather
              // than merely allowing them, so it becomes a catchall.
              Object.keys(kind.additional).length > 0
              ? z.object(shape).catchall(compile(kind.additional))
              : z.looseObject(shape)
        if (undeclared.length === 0) return object
        return object.superRefine((value, context) => {
          if (typeof value !== 'object' || value === null) return
          for (const name of undeclared) {
            if (name in value) continue
            context.addIssue({
              code: 'custom',
              message: `Missing required property "${name}"`,
              path: [name]
            })
          }
        }) as ZodType
      }
      case 'never':
        return z.never()
      default:
        return z.unknown()
    }
  }

  return { compile }
}

const shared = createCompiler()

export function compileSchema(schema: SchemaNode): ZodType {
  return shared.compile(schema)
}

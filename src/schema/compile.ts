import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Schema } from '../spec/types.ts'
import { classify, isNullable, mergeAllOf } from './walk.ts'

/**
 * Compiles an OpenAPI schema to a zod schema THROUGH `classify()` - the same
 * interpretation value generation uses. That shared reading is the whole point:
 * what we generate and what we validate can never disagree about a schema.
 */
export interface Compiler {
  compile(schema: Schema): ZodType
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
function usable(variant: Schema, key: string): boolean {
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

  function compile(schema: Schema): ZodType {
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

  function build(schema: Schema): ZodType {
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
      case 'array': {
        let out = z.array(compile(kind.items))
        if (merged.minItems !== undefined) out = out.min(merged.minItems)
        if (merged.maxItems !== undefined) out = out.max(merged.maxItems)
        return out
      }
      case 'object': {
        const shape: Record<string, ZodType> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          const compiled = compile(property)
          shape[name] = kind.required.includes(name) ? compiled : compiled.optional()
        }
        if (kind.additional === false) return z.strictObject(shape)
        // An `additionalProperties` SCHEMA constrains unknown keys rather than
        // merely allowing them, so it becomes a catchall.
        if (Object.keys(kind.additional).length > 0) {
          return z.object(shape).catchall(compile(kind.additional))
        }
        return z.looseObject(shape)
      }
      default:
        return z.unknown()
    }
  }

  return { compile }
}

const shared = createCompiler()

export function compileSchema(schema: Schema): ZodType {
  return shared.compile(schema)
}

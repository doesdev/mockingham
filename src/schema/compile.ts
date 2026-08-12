import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Schema } from '../spec/types.ts'
import { classify, isNullable } from './walk.ts'

/**
 * Compiles an OpenAPI schema to a zod schema THROUGH `classify()` — the same
 * interpretation value generation uses. That shared reading is the whole point:
 * what we generate and what we validate can never disagree about a schema.
 */
export interface Compiler {
  compile(schema: Schema): ZodType
}

function withStringRules(schema: Schema): ZodType {
  let out = z.string()
  if (schema.minLength !== undefined) out = out.min(schema.minLength)
  if (schema.maxLength !== undefined) out = out.max(schema.maxLength)
  if (schema.pattern !== undefined) out = out.regex(new RegExp(schema.pattern))
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
    const built = build(schema)
    active.delete(schema)

    const final = isNullable(schema) ? built.nullable() : built
    cache.set(schema, final)
    return final
  }

  function build(schema: Schema): ZodType {
    const kind = classify(schema)

    switch (kind.kind) {
      case 'const':
        return z.literal(kind.value as never)
      case 'enum':
        return z.union(
          kind.values.map((value) => z.literal(value as never))
        ) as ZodType
      case 'string':
        return withStringRules(schema)
      case 'integer':
        return withNumberRules(schema, true)
      case 'number':
        return withNumberRules(schema, false)
      case 'boolean':
        return z.boolean()
      case 'null':
        return z.null()
      case 'union': {
        const variants = kind.variants.map((variant) => compile(variant))
        if (kind.discriminator !== undefined) {
          // A discriminated union parses faster and reports far better errors,
          // but zod requires every variant to be an object with that key. Fall
          // back to a plain union when the shape does not allow it.
          try {
            return z.discriminatedUnion(
              kind.discriminator,
              variants as never
            ) as ZodType
          } catch {
            return z.union(variants as never) as ZodType
          }
        }
        return z.union(variants as never) as ZodType
      }
      case 'array': {
        let out = z.array(compile(kind.items))
        if (schema.minItems !== undefined) out = out.min(schema.minItems)
        if (schema.maxItems !== undefined) out = out.max(schema.maxItems)
        return out
      }
      case 'object': {
        const shape: Record<string, ZodType> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          const compiled = compile(property)
          shape[name] = kind.required.includes(name)
            ? compiled
            : compiled.optional()
        }
        return kind.additional === false
          ? z.strictObject(shape)
          : z.looseObject(shape)
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

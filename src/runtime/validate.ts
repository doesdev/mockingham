import type { Operation, Schema } from '../spec/types.ts'
import { compileSchema } from '../schema/compile.ts'
import { classify } from '../schema/walk.ts'
import { cookieValue } from './auth.ts'
import type { Ctx } from './types.ts'

const JSON_TYPE = 'application/json'

export interface ValidationFailure {
  path: string
  message: string
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationFailure[] }

/**
 * Path and query values arrive from the wire as strings. Without coercion every
 * `{petId}` declared `integer` would fail against a compiled `z.number()`.
 *
 * A value that does not convert is left as the original string on purpose, so
 * validation reports "expected number, received string" rather than NaN.
 */
export function coerce(value: string, schema: Schema): unknown {
  const kind = classify(schema)
  if (kind.kind === 'integer' || kind.kind === 'number') {
    const asNumber = Number(value)
    return value.trim() !== '' && !Number.isNaN(asNumber) ? asNumber : value
  }
  if (kind.kind === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }
  return value
}

function check(
  schema: Schema,
  value: unknown,
  prefix: string,
  errors: ValidationFailure[]
): void {
  const result = compileSchema(schema).safeParse(value)
  if (result.success) return
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? `${prefix}.${issue.path.join('.')}` : prefix
    errors.push({ path, message: issue.message })
  }
}

export function validateRequest(
  ctx: Ctx,
  operation: Operation
): ValidationResult {
  const errors: ValidationFailure[] = []

  for (const parameter of operation.parameters) {
    const source =
      parameter.location === 'path'
        ? ctx.params[parameter.name]
        : parameter.location === 'query'
          ? ctx.query[parameter.name]
          : parameter.location === 'header'
            ? ctx.headers[parameter.name.toLowerCase()]
            : parameter.location === 'cookie'
              ? cookieValue(ctx.headers['cookie'], parameter.name)
              : undefined

    if (source === undefined) {
      if (parameter.required) {
        errors.push({
          path: `${parameter.location}.${parameter.name}`,
          message: 'Required'
        })
      }
      continue
    }

    // An array parameter needs two things the scalar path cannot give it: each
    // entry coerced against the ITEM schema rather than the array schema, and a
    // lone occurrence (`?tags=a`, the ordinary form/explode case) widened to a
    // one-element array. The item schema comes from `classify` so validation
    // reads `items` exactly the way generation does.
    const kind = classify(parameter.schema)
    const value =
      kind.kind === 'array'
        ? (Array.isArray(source) ? source : [source]).map((entry) =>
            coerce(entry, kind.items)
          )
        : Array.isArray(source)
          ? source.map((entry) => coerce(entry, parameter.schema))
          : coerce(source, parameter.schema)

    check(parameter.schema, value, `${parameter.location}.${parameter.name}`, errors)
  }

  // Raw bytes mean the media type was not one we parse. Validating them would
  // be guessing, so they are skipped, per the master spec's body-parsing rules.
  const body = ctx.body
  const declared = operation.requestBody?.[JSON_TYPE]
  if (declared && body !== undefined && !(body instanceof Uint8Array)) {
    check(declared.schema, body, 'body', errors)
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

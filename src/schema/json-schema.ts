import { z } from 'zod'
import type { Schema } from '../spec/types.ts'
import type { Compiler } from './compile.ts'

/**
 * The single Schema → JSON Schema derivation. `schemaHash`, `buildRequest`,
 * and `describe_operation` all route through here, because invariant 1's
 * reasoning applies to this conversion too: three copies would eventually
 * disagree, and a fixture hashed against one shape while described as another
 * is the exact bug class that invariant exists to prevent.
 *
 * Returns `undefined` for a schema zod cannot express as JSON Schema, which
 * callers treat as "nothing to say" rather than fabricating a shape. Recursion
 * is NOT such a case — zod emits `{"$ref":"#"}` and this returns it.
 */
export function toJsonSchema(
  schema: Schema,
  compiler: Compiler
): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(compiler.compile(schema)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

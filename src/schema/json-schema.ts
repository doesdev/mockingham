import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Schema } from '../spec/types.ts'
import type { Compiler } from './compile.ts'

/**
 * The single Schema → JSON Schema derivation. `schemaHash`, `buildRequest`,
 * and `describe_operation` all route through here, because invariant 1's
 * reasoning applies to this conversion too: three copies would eventually
 * disagree, and a fixture hashed against one shape while described as another
 * is the exact bug class that invariant exists to prevent.
 *
 * The `undefined` branch covers exactly one thing: `z.toJSONSchema` refusing a
 * compiled zod schema it cannot express, which callers treat as "nothing to
 * say" rather than fabricating a shape. Recursion is NOT such a case - zod
 * emits `{"$ref":"#"}` and this returns it.
 *
 * `compile` is called OUTSIDE the try deliberately. A compiler throw means the
 * document itself is broken, not that a shape resists JSON Schema, and it must
 * propagate rather than be laundered into "nothing to say" - which is how this
 * behaved at its original site in `fixtures/source.ts`.
 */
export function toJsonSchema(
  schema: Schema,
  compiler: Compiler
): Record<string, unknown> | undefined {
  const compiled = compiler.compile(schema)
  return fromZod(compiled)
}

/**
 * The same conversion for a caller that already holds the compiled zod schema,
 * so `buildRequest` does not compile the same schema twice to get both halves.
 * Still one derivation - `toJsonSchema` is this function plus a compile.
 */
export function fromZod(compiled: ZodType): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(compiled) as Record<string, unknown>
  } catch {
    return undefined
  }
}

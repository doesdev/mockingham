import { z } from 'zod'
import type { ZodType } from 'zod'
import { classify } from '../schema/walk.ts'
import type { Compiler } from '../schema/compile.ts'
import type { Operation, Schema } from '../spec/types.ts'
import { operationSlug } from './key.ts'
import type { FixtureMeta } from './store.ts'

export interface FixtureRequest {
  operationId: string
  method: string
  path: string
  status: number
  key: string
  params: Record<string, string>
  /**
   * The response body as plain JSON Schema. This is the field that makes the
   * interface genuinely provider-neutral: a source for another provider needs
   * this and nothing else from us — design section 2.3.
   */
  jsonSchema: Record<string, unknown>
  /** The same schema compiled, for client-side validation by any source. */
  zodSchema: ZodType
  summary?: string
  description?: string
  example?: unknown
  persona?: string
}

export interface FixtureResult {
  value: unknown
  meta?: FixtureMeta
}

/**
 * A provider. Results are positionally aligned with `reqs`; `null` is a miss,
 * never an error. Implementations need not be defensive — the driver wraps
 * them and treats a throw as all-nulls.
 */
export interface ContentSource {
  generate(reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]>
}

/**
 * Structured outputs do not support recursive schemas, so a recursive response
 * never reaches any source and stays generator-only. Walks through
 * `classify()`, like everything else that reads a schema.
 *
 * `seen` tracks visited schemas by identity along the current path only (a
 * fresh copy is threaded into each recursive call rather than mutated in
 * place), so a schema reachable twice via two different branches — a diamond,
 * not a cycle — is not mistaken for recursion.
 *
 * `classify()` merges `allOf` internally and that merge allocates a new
 * object on every call, but the merge never re-wraps nested `items` or
 * `properties` values — `mergeAllOf`'s `absorb` copies those references
 * through untouched. So the schema objects this walk actually recurses into
 * are always the original, pre-merge references, and identity tracked in
 * `seen` still lines up across a cycle expressed through `allOf`.
 */
export function isRecursive(schema: Schema): boolean {
  const walk = (node: Schema, seen: Set<Schema>): boolean => {
    if (seen.has(node)) return true
    const nested = new Set(seen)
    nested.add(node)
    const kind = classify(node)
    if (kind.kind === 'array') return walk(kind.items, nested)
    if (kind.kind === 'object') {
      return Object.keys(kind.properties)
        .sort()
        .some((name) => walk(kind.properties[name] as Schema, nested))
    }
    return false
  }
  return walk(schema, new Set())
}

export interface BuildRequestInput {
  operation: Operation
  status: number
  key: string
  params: Record<string, string>
  schema: Schema
  compiler: Compiler
  schemaNames: Map<Schema, string>
  example?: unknown
  persona?: string
}

/** Returns undefined when the schema cannot be sent to a source at all. */
export function buildRequest(input: BuildRequestInput): FixtureRequest | undefined {
  if (isRecursive(input.schema)) return undefined
  const zodSchema = input.compiler.compile(input.schema)
  let jsonSchema: Record<string, unknown>
  try {
    jsonSchema = z.toJSONSchema(zodSchema) as Record<string, unknown>
  } catch {
    // A schema zod cannot express as JSON Schema is a miss, not an error.
    return undefined
  }
  return {
    operationId: operationSlug(input.operation),
    method: input.operation.method,
    path: input.operation.path,
    status: input.status,
    key: input.key,
    params: input.params,
    jsonSchema,
    zodSchema,
    summary: input.operation.summary,
    description: input.operation.description,
    example: input.example,
    persona: input.persona
  }
}

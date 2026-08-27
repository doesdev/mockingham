import type { ZodType } from 'zod'
import { classify } from '../schema/walk.ts'
import type { Compiler } from '../schema/compile.ts'
import { toJsonSchema, fromZod } from '../schema/json-schema.ts'
import { fnv1a } from '../generate/rng.ts'
import type { Api, Operation, Schema } from '../spec/types.ts'
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
   * this and nothing else from us - design section 2.3.
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
 * never an error. Implementations need not be defensive - the driver wraps
 * them and treats a throw as all-nulls.
 */
export interface ContentSource {
  generate(reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]>
  /**
   * How many requests this source wants per `generate` call. Optional: omit it
   * and the driver uses its own budget, which is what a third-party source
   * should do.
   *
   * It exists because a source can have a threshold the driver cannot know.
   * The Anthropic source only switches to the Batches API at or above its
   * `batchThreshold`, and the driver's default budget is far below that - so
   * without this the batch path was unreachable under default configuration.
   */
  chunkSize?: number
}

/**
 * Structured outputs do not support recursive schemas, so a recursive response
 * never reaches any source and stays generator-only. Walks through
 * `classify()`, like everything else that reads a schema - every branch that
 * can hold a nested `Schema` (`array` items, `object` properties AND its
 * `additional` schema, `union` variants) is followed, or a cycle routed
 * through the branch this walk skips would build a request whose JSON Schema
 * contains a live self-reference no provider can act on.
 *
 * `seen` tracks visited schemas by identity along the current path only (a
 * fresh copy is threaded into each recursive call rather than mutated in
 * place), so a schema reachable twice via two different branches - a diamond,
 * not a cycle - is not mistaken for recursion.
 *
 * `classify()` merges `allOf` internally and that merge allocates a new
 * object on every call, but the merge never re-wraps nested `items` or
 * `properties` values - `mergeAllOf`'s `absorb` copies those references
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
    if (kind.kind === 'array') {
      // Both schema-bearing branches: the tail AND every tuple position.
      // Following only the tail would let a cycle routed through a
      // `prefixItems` entry build a request whose JSON Schema self-references.
      if (walk(kind.items, nested)) return true
      return kind.prefix.some((position) => walk(position, nested))
    }
    if (kind.kind === 'union') {
      if (kind.variants.some((variant) => walk(variant, nested))) return true
      // The shape declared BESIDE the union carries properties no variant
      // mentions, so a cycle can live there and nowhere else.
      return kind.base !== undefined && walk(kind.base, nested)
    }
    if (kind.kind === 'object') {
      const throughProperties = Object.keys(kind.properties)
        .sort()
        .some((name) => walk(kind.properties[name] as Schema, nested))
      if (throughProperties) return true
      if (kind.additional === false) return false
      return walk(kind.additional, nested)
    }
    return false
  }
  return walk(schema, new Set())
}

/**
 * A fingerprint of a schema's compiled JSON Schema form, used to detect when
 * a stored fixture was generated against a document that has since moved -
 * design section 2.13. `bake` and the startup staleness check both call this
 * one function so their hashes can never drift apart; two independent
 * derivations would produce spurious warnings the moment they disagreed.
 *
 * Same derivation `buildRequest` uses - both route through `toJsonSchema` -
 * so a schema this hashes is exactly a schema `buildRequest` could turn into
 * a request. A schema zod cannot express as JSON Schema yields no hash at
 * all, which the caller treats as "nothing to compare" rather than a
 * fabricated mismatch.
 */
export function schemaHash(schema: Schema, compiler: Compiler): string | undefined {
  const jsonSchema = toJsonSchema(schema, compiler)
  if (jsonSchema === undefined) return undefined
  return fnv1a(JSON.stringify(jsonSchema)).toString(16).padStart(8, '0')
}

/**
 * The lookup `warnOnStaleFixtures` needs: given a stored fixture's operation id
 * and status, the hash that operation's response schema has NOW.
 *
 * Shared rather than written at each call site. Both `createMock` and the CLI's
 * serve path run this check, and two copies of the derivation would eventually
 * disagree - at which point every fixture reports stale against a document that
 * never changed, which is worse than not checking at all.
 */
export function schemaHashLookup(
  api: Api,
  compiler: Compiler
): (operationId: string, status: number) => string | undefined {
  return (operationId, status) => {
    const operation = api.operations.find(
      (candidate) => operationSlug(candidate) === operationId
    )
    const media = operation?.responses.find((entry) => entry.status === status)
      ?.content['application/json']
    return media ? schemaHash(media.schema, compiler) : undefined
  }
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
  // Compiled once and converted from that result: toJsonSchema(schema, compiler)
  // would compile a second time for the identical (cached) output.
  const zodSchema = input.compiler.compile(input.schema)
  // A schema zod cannot express as JSON Schema is a miss, not an error.
  const jsonSchema = fromZod(zodSchema)
  if (jsonSchema === undefined) return undefined
  // An undiscriminated `oneOf` compiles to `z.unknown().superRefine(...)`
  // (compile.ts's shared interpretation, deliberately not changed here - see
  // Finding 3), which converts to a JSON Schema carrying none of these keys:
  // no type, no properties, nothing a provider could shape a body around. A
  // shapeless schema cannot yield a conforming response, so this is a miss
  // like any other unsendable schema, not a request built on a false promise.
  const structural = ['type', 'properties', 'items', 'anyOf', 'oneOf', 'allOf', 'enum', 'const']
  if (!structural.some((key) => jsonSchema[key] !== undefined)) return undefined
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

import type { ResponseSpec, Schema } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { generateValue } from '../generate/generate.ts'
import type { ResolverLookup } from '../resolve/resolvers.ts'
import { applyOverrides } from '../resolve/layer.ts'
import type { OverrideNode } from './types.ts'
import { markCallback } from './errors.ts'

export interface HeaderInput {
  spec: ResponseSpec
  globals?: Record<string, OverrideNode>
  resolvers?: ResolverLookup
  overrides?: Record<string, OverrideNode>
  ctx: unknown
  rngFor(name: string): Rng
  generateOptions: GenerateOptions
}

function evaluate(node: OverrideNode, ctx: unknown): unknown {
  if (typeof node !== 'function') return node
  try {
    return (node as (context: unknown) => unknown)(ctx)
  } catch (error) {
    throw markCallback(error)
  }
}

/**
 * Builds response headers through master spec §5's layers, in increasing
 * precedence. Transport headers are layer 5 and are applied by the caller after
 * this returns, which is what makes them non-overridable.
 */
export async function buildHeaders(input: HeaderInput): Promise<Headers> {
  const values: Record<string, unknown> = {}

  // 1. Declared in the operation's response object, generated from schemas.
  for (const [name, schema] of Object.entries(input.spec.headers)) {
    values[name.toLowerCase()] = generateValue(
      schema as Schema,
      input.rngFor(name),
      input.generateOptions
    )
  }

  // 2. Global defaults from config.
  for (const [name, node] of Object.entries(input.globals ?? {})) {
    values[name.toLowerCase()] = evaluate(node, input.ctx)
  }

  // 3. byName resolvers. These resolve values for headers some layer already
  //    set; they do not invent headers of their own. `name` is already
  //    lowercased here, so the lookup matches patterns case-insensitively -
  //    otherwise a pattern written 'X-Request-Id' could never fire.
  if (input.resolvers) {
    for (const name of Object.keys(values)) {
      const hit = input.resolvers.resolveHeader(name, input.ctx)
      if (hit.hit) values[name] = hit.value
    }
  }

  // 4. Per-operation overrides.
  for (const [name, node] of Object.entries(input.overrides ?? {})) {
    if (node === undefined) continue
    values[name.toLowerCase()] = evaluate(node, input.ctx)
  }

  // Settled through the same pass bodies use, so a header override returning a
  // promise-of-a-promise behaves identically to a body override that does.
  const settled = (await applyOverrides(values, undefined, input.ctx)) as Record<
    string,
    unknown
  >

  const headers = new Headers()
  for (const name of Object.keys(settled)) {
    const value = settled[name]
    if (value !== null && value !== undefined) headers.set(name, String(value))
  }
  return headers
}

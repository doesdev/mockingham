import type { ResponseSpec } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { applyOverrides } from '../resolve/layer.ts'
import type { ResolverLookup } from '../resolve/resolvers.ts'
import { buildHeaders } from './headers.ts'
import type { Ctx, OverrideNode } from './types.ts'

const JSON_TYPE = 'application/json'

export interface RenderDebug {
  seed: string
  source: string
  operationId?: string
  override?: string
}

export interface RenderInput {
  ctx: Ctx
  chosen: ResponseSpec
  bodyOverrides: OverrideNode[]
  /**
   * A scoped fixture, applied BENEATH the user's layers. This is what makes
   * `override > fixture > example > generated` fall out of the existing
   * override machinery instead of a bespoke merge — design section 3.
   */
  fixtureLayer?: OverrideNode
  headerOverrides: Record<string, OverrideNode>
  globals?: Record<string, OverrideNode>
  resolvers: ResolverLookup
  rngFor(label: string): Rng
  generateOptions: GenerateOptions
  exampleName?: string
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
  debug?: RenderDebug
}

/**
 * Pipeline stages 8 and 9: generate the body, overlay the override layers, build
 * the headers, then stamp the transport headers.
 *
 * Transport headers are set here, AFTER `buildHeaders` returns, which is what
 * makes them non-overridable rather than merely last. `Content-Length` is left
 * to `Response`, per design amendment 1.4.
 */
export async function renderResponse(input: RenderInput): Promise<Response> {
  const { chosen } = input

  const headers = await buildHeaders({
    spec: chosen,
    globals: input.globals,
    resolvers: input.resolvers,
    overrides: input.headerOverrides,
    ctx: input.ctx,
    rngFor: (name) => input.rngFor(`header|${name}`),
    generateOptions: { ...input.generateOptions, ctx: input.ctx }
  })

  if (input.debug) {
    headers.set('x-mock-seed', input.debug.seed)
    headers.set('x-mock-status-source', input.debug.source)
    if (input.debug.operationId) {
      headers.set('x-mock-operation', input.debug.operationId)
    }
    if (input.debug.override) {
      headers.set('x-mock-override', input.debug.override)
    }
  }

  let body: unknown
  if (input.exampleName !== undefined) {
    body = input.example(chosen.status, input.exampleName)
  }
  // The same call ctx.generate(status) makes, not a second copy — a response
  // callback and the pipeline must never produce different bodies.
  if (body === undefined) body = input.generate(chosen.status)

  // The fixture goes first so the user's layers land on top of it.
  const layers = input.fixtureLayer === undefined
    ? input.bodyOverrides
    : [input.fixtureLayer, ...input.bodyOverrides]

  if (layers.length === 0) {
    // Still one pass: resolvers may have left promises in the tree.
    if (body !== undefined) body = await applyOverrides(body, undefined, input.ctx)
  } else {
    for (const override of layers) {
      body = await applyOverrides(body, override, input.ctx)
    }
  }

  if (body === undefined) {
    return new Response(null, { status: chosen.status, headers })
  }

  headers.set('content-type', JSON_TYPE)
  return new Response(JSON.stringify(body), { status: chosen.status, headers })
}

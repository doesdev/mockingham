import type { Operation } from '../spec/types.ts'
import { compileTarget, resolveTarget } from '../resolve/target.ts'
import type { Ctx, EmitCtx, OverrideNode } from './types.ts'

export interface StatusConfig {
  body?: OverrideNode
  headers?: Record<string, OverrideNode>
}

export interface EmitConfig {
  webhook: string
  /** Delay before delivery, awaited through the injected `sleep`. */
  afterMs?: number | ((ctx: EmitCtx) => number)
  /** Layered over the generated payload, exactly as a response body override is. */
  body?: OverrideNode
}

export type OperationConfig = {
  status?: number
  respond?: (ctx: Ctx) => Response | Promise<Response>
  emits?: EmitConfig[]
} & { [status: number]: StatusConfig }

export interface CompiledConfig {
  matches(operation: Operation): boolean
  config: OperationConfig
}

/**
 * Targets are resolved here, at construction, so a typo throws immediately
 * rather than silently never firing on any request.
 */
export function compileConfigs(
  operations: Record<string, OperationConfig> | undefined,
  known: Operation[]
): CompiledConfig[] {
  return Object.entries(operations ?? {}).map(([target, config]) => {
    resolveTarget(target, known)
    return { matches: compileTarget(target).matches, config }
  })
}

export interface ResolvedConfig {
  status?: number
  respond?: OperationConfig['respond']
  emits: EmitConfig[]
  /** Every matching config's body override for a status, in declaration order. */
  bodies(status: number): OverrideNode[]
  headers(status: number): Record<string, OverrideNode>
}

/**
 * Matching configs are deliberately NOT merged into one object. A broad target
 * and a specific one both setting `200.body` must layer - the specific refining
 * the broad one's result - so bodies stay a list applied in sequence. Headers
 * are flat, so a shallow merge in declaration order is already right.
 */
export function resolveConfigs(
  operation: Operation,
  compiled: CompiledConfig[]
): ResolvedConfig {
  const matching = compiled
    .filter((entry) => entry.matches(operation))
    .map((entry) => entry.config)

  let status: number | undefined
  let respond: OperationConfig['respond']
  const emits: EmitConfig[] = []
  for (const entry of matching) {
    if (entry.status !== undefined) status = entry.status
    if (entry.respond !== undefined) respond = entry.respond
    if (entry.emits !== undefined) emits.push(...entry.emits)
  }

  return {
    status,
    respond,
    emits,
    bodies(forStatus) {
      const out: OverrideNode[] = []
      for (const entry of matching) {
        const scoped = entry[forStatus]
        if (scoped !== undefined && scoped.body !== undefined) out.push(scoped.body)
      }
      return out
    },
    headers(forStatus) {
      let out: Record<string, OverrideNode> = {}
      for (const entry of matching) {
        const scoped = entry[forStatus]
        if (scoped !== undefined && scoped.headers) {
          out = { ...out, ...scoped.headers }
        }
      }
      return out
    }
  }
}

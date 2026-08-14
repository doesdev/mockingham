import type { Api, Operation } from '../spec/types.ts'
import type { ZodType } from 'zod'
import type { Delivery } from '../webhooks/deliver.ts'
import type { EmitOptions } from '../server/handler.ts'
import type { CompiledConfig } from '../runtime/config.ts'
import type { RuntimeOverride } from '../runtime/overrides.ts'

export interface McpFailNextOptions {
  times?: number
  status?: number
}

export interface McpOutageOptions {
  forMs?: number
  status?: number
}

/**
 * What a tool is allowed to reach. Deliberately narrower than `Mock`: a tool
 * that can reach `close()` is a tool that can be made to close the mock, and a
 * narrow interface is one a test can build by hand. Options types are declared
 * here rather than imported from `../index.ts` — that module imports this one.
 */
export interface McpContext {
  api: Api
  fetch(request: Request): Promise<Response>
  failNext(target: string, opts?: McpFailNextOptions): Promise<void>
  outage(target: string, opts?: McpOutageOptions): Promise<void>
  override(target: string, value: RuntimeOverride): Promise<void>
  clearOverrides(target?: string): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(): Delivery[]
  /** Webhook name → the operation targets configured to emit it. See design §3.6. */
  emitters: Map<string, string[]>
  /**
   * Origin for the synthetic Requests `sample_response` builds. Route matching
   * uses only the pathname, so this never affects which operation is selected;
   * it exists because `new Request(url)` demands an absolute URL.
   */
  origin: string
}

/**
 * The ten members of `McpContext` a `Mock` supplies directly. Typed
 * structurally rather than as `Mock` on purpose: `../index.ts` imports this
 * module, so naming its type here would close a cycle. It is also the whole
 * point of the narrowing — this is every part of a `Mock` a tool may reach.
 */
export interface McpContextSource {
  api: Api
  fetch(request: Request): Promise<Response>
  failNext(target: string, opts?: McpFailNextOptions): Promise<void>
  outage(target: string, opts?: McpOutageOptions): Promise<void>
  override(target: string, value: RuntimeOverride): Promise<void>
  clearOverrides(target?: string): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(): Delivery[]
}

/**
 * The one construction path for an `McpContext`. `createMock().mcp()` and the
 * test helpers both call this, so there is no second literal that could drift
 * out of step with the first — a seam where two independently-correct
 * constructions disagree is the defect shape this exists to make impossible.
 */
export function createMcpContext(
  source: McpContextSource,
  configs: CompiledConfig[],
  origin = 'http://mock.local'
): McpContext {
  return {
    api: source.api,
    fetch: (request) => source.fetch(request),
    failNext: (target, opts) => source.failNext(target, opts),
    outage: (target, opts) => source.outage(target, opts),
    override: (target, value) => source.override(target, value),
    clearOverrides: (target) => source.clearOverrides(target),
    setSeed: (seed) => source.setSeed(seed),
    reset: () => source.reset(),
    emit: (name, opts) => source.emit(name, opts),
    deliveries: () => source.deliveries(),
    emitters: computeEmitters(source.api.operations, configs),
    origin
  }
}

export interface McpTool {
  name: string
  description: string
  /** A zod raw shape — the SDK's `registerTool` takes exactly this. */
  inputSchema: Record<string, ZodType>
  handler(ctx: McpContext, args: Record<string, unknown>): Promise<unknown> | unknown
}

/**
 * Which operations are configured to emit which webhook (design §3.6). A
 * top-level `webhooks` entry carries no declared emitter — the linkage lives
 * in mockingham's own operation config, which is why this is computed from the
 * compiled configs rather than from the document.
 */
export function computeEmitters(
  operations: Operation[],
  configs: CompiledConfig[]
): Map<string, string[]> {
  const emitters = new Map<string, string[]>()
  for (const operation of operations) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`
    for (const compiled of configs) {
      if (!compiled.matches(operation)) continue
      for (const emit of compiled.config.emits ?? []) {
        const existing = emitters.get(emit.webhook)
        if (existing === undefined) emitters.set(emit.webhook, [label])
        else if (!existing.includes(label)) existing.push(label)
      }
    }
  }
  return emitters
}

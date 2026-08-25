import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import { applyOverrides } from '../resolve/layer.ts'
import type { Ctx } from './types.ts'

export interface Counters {
  next(name: string): number
  reset(): void
}

export function createCounters(): Counters {
  const counts = new Map<string, number>()
  return {
    next(name) {
      const value = (counts.get(name) ?? 0) + 1
      counts.set(name, value)
      return value
    },
    reset() {
      counts.clear()
    }
  }
}

export interface ContextInput {
  request: Request
  url: URL
  operation: Operation
  params: Record<string, string>
  body: unknown
  mediaType?: string
  rng: Rng
  requestKey: string
  requestId: string
  counters: Counters
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
}

export function createContext(input: ContextInput): Ctx {
  // Built by iterating searchParams in order of appearance rather than through
  // a Set, so the result is deterministic - invariant 2 forbids unordered
  // iteration anywhere a generated value can depend on it.
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of input.url.searchParams) {
    const existing = query[key]
    if (existing === undefined) query[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else query[key] = [existing, value]
  }

  const headers: Record<string, string> = {}
  input.request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })

  const ctx: Ctx = {
    req: input.request,
    operation: input.operation,
    params: input.params,
    query,
    headers,
    body: input.body,
    mediaType: input.mediaType,
    rng: input.rng,
    requestKey: input.requestKey,
    requestId: input.requestId,
    log: {},
    decisions: {},
    seq: (name) => input.counters.next(name),
    generate: (status) => input.generate(status),
    example: (status, name) => input.example(status, name),
    // Async because serializing is the point at which promises must be gone.
    // `ctx.generate` deliberately stays synchronous and may hand back a tree
    // with unsettled promises in it - an async resolver leaves them there for
    // the override pass. The pipeline settles them through `applyOverrides`;
    // a response callback bypasses the pipeline, so `respond` runs the same
    // settle pass here rather than stringifying a Promise into `{}`.
    async respond(status, body, extra) {
      const out = new Headers(extra)
      if (body === undefined) return new Response(null, { status, headers: out })
      const settled = await applyOverrides(body, undefined, ctx)
      if (settled === undefined) return new Response(null, { status, headers: out })
      out.set('content-type', 'application/json')
      return new Response(JSON.stringify(settled), { status, headers: out })
    },
    deny(status, code) {
      return Response.json(
        { error: { code: code ?? 'MOCK_DENIED', message: `Denied with ${status}` } },
        { status }
      )
    }
  }

  return ctx
}

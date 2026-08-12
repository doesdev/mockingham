import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
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
  rng: Rng
  requestKey: string
  counters: Counters
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
}

export function createContext(input: ContextInput): Ctx {
  // Built by iterating searchParams in order of appearance rather than through
  // a Set, so the result is deterministic — invariant 2 forbids unordered
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

  return {
    req: input.request,
    operation: input.operation,
    params: input.params,
    query,
    headers,
    body: input.body,
    rng: input.rng,
    requestKey: input.requestKey,
    log: {},
    seq: (name) => input.counters.next(name),
    generate: (status) => input.generate(status),
    example: (status, name) => input.example(status, name),
    respond(status, body, extra) {
      const out = new Headers(extra)
      if (body === undefined) return new Response(null, { status, headers: out })
      out.set('content-type', 'application/json')
      return new Response(JSON.stringify(body), { status, headers: out })
    }
  }
}

import { createContext, createCounters } from '../../src/runtime/context.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Operation } from '../../src/spec/types.ts'
import type { Ctx, Fail } from '../../src/runtime/types.ts'

export interface BuildCtxInput {
  request: Request
  operation: Operation
  params?: Record<string, string>
  body?: unknown
  mediaType?: string
  requestKey?: string
}

/** A Ctx with no server behind it, for unit-testing one stage in isolation. */
export function buildCtx(input: BuildCtxInput): Ctx {
  return createContext({
    request: input.request,
    url: new URL(input.request.url),
    operation: input.operation,
    params: input.params ?? {},
    body: input.body,
    mediaType: input.mediaType,
    rng: createRng('test'),
    requestKey: input.requestKey ?? 'test-key',
    counters: createCounters(),
    generate: () => undefined,
    example: () => undefined
  })
}

/**
 * A `Fail` that records what it was asked for. The real one generates an
 * on-contract body; a stage's own test only cares which error it chose.
 */
export function recordingFail(): { fail: Fail; calls: Array<{ status: number; code: string }> } {
  const calls: Array<{ status: number; code: string }> = []
  const fail: Fail = async (status, code, message) => {
    calls.push({ status, code })
    return Response.json({ error: { code, message } }, { status })
  }
  return { fail, calls }
}

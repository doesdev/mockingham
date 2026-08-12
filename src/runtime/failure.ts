import type { Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { compileTarget } from '../resolve/target.ts'
import type { Ctx } from './types.ts'
import type { Store } from './store.ts'

export interface CircuitPolicy {
  after: number
  openFor: number
  then: number
}

export interface FailurePolicy {
  match: string
  rate?: number
  respond?: number
  latency?: number | ((ctx: Ctx) => number)
  circuit?: CircuitPolicy
}

export interface Directive {
  status: number
  code?: string
}

export type FailureOutcome =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

export interface FailureInput {
  operation: Operation
  ctx: Ctx
  policies: Array<{ matches(operation: Operation): boolean; policy: FailurePolicy }>
  decide?: (ctx: Ctx) => Directive | undefined
  store: Store
  chaosSeed: string
  requestKey: string
  /** Per-request-identity invocation count; see the seeding note below. */
  counter: () => number
  sleep: (ms: number) => Promise<void>
}

const DEFAULT_STATUS = 503

function targetKey(operation: Operation): string {
  return operation.operationId ?? `${operation.method} ${operation.path}`
}

function failure(status: number, message: string): FailureOutcome {
  return { ok: false, status, code: 'MOCK_FAILURE_INJECTED', message }
}

/**
 * Pipeline stage 6, evaluating in the master spec's order: `decide` → one-shot
 * `failNext` → outage → circuit state → rate → latency. Latency applies even when
 * the request succeeds.
 *
 * CHAOS SEEDING. Each roll is seeded from `hash(chaosSeed, requestKey, n)` where
 * `n` is a per-request-identity invocation counter. A single advancing PRNG
 * stream would make a request's outcome depend on how many other requests came
 * first, which breaks under concurrency and when a test runs alone. Seeding from
 * request identity alone would make a request permanently pass or permanently
 * fail, turning `rate: 0.05` into "5% of endpoints" rather than "5% of calls".
 * The counter gives reproducibility AND a rate that behaves like a rate.
 */
export async function checkFailure(input: FailureInput): Promise<FailureOutcome> {
  const key = targetKey(input.operation)
  const matching = input.policies
    .filter((entry) => entry.matches(input.operation))
    .map((entry) => entry.policy)

  // 1. decide() overrides everything.
  if (input.decide) {
    const directive = input.decide(input.ctx)
    if (directive) {
      return failure(directive.status, 'Failure injected by decide()')
    }
  }

  // 2. One-shot failNext.
  const pending = (await input.store.get(`failnext|${key}`)) as
    | { times: number; status?: number }
    | undefined
  if (pending && pending.times > 0) {
    const left = pending.times - 1
    if (left > 0) await input.store.set(`failnext|${key}`, { ...pending, times: left })
    else await input.store.delete(`failnext|${key}`)
    return failure(pending.status ?? DEFAULT_STATUS, 'Failure injected by failNext()')
  }

  // 3. Outage. Its TTL is the deadline, so an expired key simply reads as absent.
  const outage = (await input.store.get(`outage|${key}`)) as
    | { status?: number }
    | undefined
  if (outage) {
    return failure(outage.status ?? DEFAULT_STATUS, 'Failure injected by outage()')
  }

  for (const policy of matching) {
    // 4. Circuit state, before rolling — an open circuit answers immediately.
    if (policy.circuit) {
      const open = await input.store.get(`circuit-open|${key}`)
      if (open !== undefined) {
        return failure(policy.circuit.then, 'Circuit is open')
      }
    }

    // 5. Rate.
    if (policy.rate !== undefined && policy.rate > 0) {
      const seed = fnv1a(`${input.chaosSeed}|${input.requestKey}|${input.counter()}`)
      if (createRng(seed).next() < policy.rate) {
        if (policy.circuit) {
          const failures = await input.store.incr(`circuit-count|${key}`)
          if (failures >= policy.circuit.after) {
            await input.store.set(`circuit-open|${key}`, true, policy.circuit.openFor)
            await input.store.delete(`circuit-count|${key}`)
          }
        }
        return failure(policy.respond ?? DEFAULT_STATUS, 'Failure injected by rate')
      }
    }
  }

  // 6. Latency, applied even on success.
  for (const policy of matching) {
    if (policy.latency === undefined) continue
    const ms =
      typeof policy.latency === 'function' ? policy.latency(input.ctx) : policy.latency
    if (ms > 0) await input.sleep(ms)
  }

  return { ok: true }
}

/** Compiles policy targets once, throwing on one that matches no operation. */
export function compilePolicies(
  policies: FailurePolicy[] | undefined,
  known: Operation[]
): Array<{ matches(operation: Operation): boolean; policy: FailurePolicy }> {
  return (policies ?? []).map((policy) => {
    const matcher = compileTarget(policy.match)
    if (!known.some((operation) => matcher.matches(operation))) {
      throw new Error(
        `mockingham: failure policy target "${policy.match}" matches no operation ` +
          'in the document.'
      )
    }
    return { matches: matcher.matches, policy }
  })
}

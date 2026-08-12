import type { Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { compileTarget } from '../resolve/target.ts'
import { markCallback } from './errors.ts'
import type { Ctx, Fail, Stage } from './types.ts'
import type { Store } from './store.ts'

export interface CircuitPolicy {
  after: number
  openFor: number
  then: number
  /**
   * The window over which failures accumulate, in milliseconds. Without one the
   * counter never decays and `after: 5` eventually trips from failures spread
   * across the whole process lifetime rather than within any window. Defaults to
   * `openFor`: with no explicit window, the natural scale is how long the
   * circuit stays open once it trips.
   */
  within?: number
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
  policies: Array<{ id: string; matches(operation: Operation): boolean; policy: FailurePolicy }>
  decide?: (ctx: Ctx) => Directive | undefined
  store: Store
  chaosSeed: string
  requestKey: string
  /** Per-request-identity invocation count; see the seeding note below. */
  counter: () => number
  sleep: (ms: number) => Promise<void>
}

const DEFAULT_STATUS = 503
const DEFAULT_CODE = 'MOCK_FAILURE_INJECTED'

/**
 * The store-key convention, exported because the control plane in `index.ts`
 * WRITES the keys this module READS. Two independent spellings of the same
 * convention would drift silently — the control plane arming keys nothing reads,
 * with both test suites still green in isolation.
 */
export function targetKey(operation: Operation): string {
  return operation.operationId ?? `${operation.method} ${operation.path}`
}

export function failNextKey(key: string): string {
  return `failnext|${key}`
}

export function outageKey(key: string): string {
  return `outage|${key}`
}

function failure(
  status: number,
  message: string,
  code: string = DEFAULT_CODE
): FailureOutcome {
  return { ok: false, status, code, message }
}

/**
 * A fixed window from the first failure: arm the TTL on the first increment and
 * leave it alone afterward. `Store.incr` preserves an existing deadline and
 * cannot arm one, which is exactly right here — re-arming on every failure would
 * give a sliding window that never expires under sustained load.
 */
async function bumpCircuit(store: Store, key: string, within: number): Promise<number> {
  const current = await store.get(key)
  if (typeof current !== 'number') {
    await store.set(key, 1, within)
    return 1
  }
  return await store.incr(key)
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
  const matching = input.policies.filter((entry) => entry.matches(input.operation))

  // 1. decide() overrides everything.
  if (input.decide) {
    let directive: Directive | undefined
    try {
      directive = input.decide(input.ctx)
    } catch (error) {
      throw markCallback(error)
    }
    if (directive) {
      return failure(directive.status, 'Failure injected by decide()', directive.code)
    }
  }

  // 2. One-shot failNext.
  const pending = (await input.store.get(failNextKey(key))) as
    | { times: number; status?: number }
    | undefined
  if (pending && pending.times > 0) {
    const left = pending.times - 1
    if (left > 0) await input.store.set(failNextKey(key), { ...pending, times: left })
    else await input.store.delete(failNextKey(key))
    return failure(pending.status ?? DEFAULT_STATUS, 'Failure injected by failNext()')
  }

  // 3. Outage. Its TTL is the deadline, so an expired key simply reads as absent.
  const outage = (await input.store.get(outageKey(key))) as
    | { status?: number }
    | undefined
  if (outage) {
    return failure(outage.status ?? DEFAULT_STATUS, 'Failure injected by outage()')
  }

  for (const entry of matching) {
    const policy = entry.policy
    // Keyed by policy id alone, not id + operation. entry.id already carries
    // the policy's target string, which for the common case (an operationId or
    // a single method+path target) picks out exactly one operation. This keeps
    // the promise of item 5 (two policies matching the same operation get
    // independent circuits) without a redundant operation-key suffix.
    const openKey = `circuit-open|${entry.id}`
    const countKey = `circuit-count|${entry.id}`

    // 4. Circuit state, before rolling — an open circuit answers immediately.
    if (policy.circuit) {
      const open = await input.store.get(openKey)
      if (open !== undefined) {
        return failure(policy.circuit.then, 'Circuit is open')
      }
    }

    // 5. Rate.
    if (policy.rate !== undefined && policy.rate > 0) {
      const seed = fnv1a(`${input.chaosSeed}|${input.requestKey}|${input.counter()}`)
      if (createRng(seed).next() < policy.rate) {
        if (policy.circuit) {
          const window = policy.circuit.within ?? policy.circuit.openFor
          const failures = await bumpCircuit(input.store, countKey, window)
          if (failures >= policy.circuit.after) {
            await input.store.set(openKey, true, policy.circuit.openFor)
            await input.store.delete(countKey)
          }
        }
        return failure(policy.respond ?? DEFAULT_STATUS, 'Failure injected by rate')
      }
    }
  }

  // 6. Latency, applied even on success.
  for (const entry of matching) {
    const policy = entry.policy
    if (policy.latency === undefined) continue
    let ms: number
    if (typeof policy.latency === 'function') {
      try {
        ms = policy.latency(input.ctx)
      } catch (error) {
        throw markCallback(error)
      }
    } else {
      ms = policy.latency
    }
    if (ms > 0) await input.sleep(ms)
  }

  return { ok: true }
}

/** Compiles policy targets once, throwing on one that matches no operation. */
export function compilePolicies(
  policies: FailurePolicy[] | undefined,
  known: Operation[]
): Array<{ id: string; matches(operation: Operation): boolean; policy: FailurePolicy }> {
  return (policies ?? []).map((policy, index) => {
    const matcher = compileTarget(policy.match)
    if (!known.some((operation) => matcher.matches(operation))) {
      throw new Error(
        `mockingham: failure policy target "${policy.match}" matches no operation ` +
          'in the document.'
      )
    }
    // Policies are anonymous literals with no natural identity. The compiled
    // index is stable for a handler's lifetime, and pairing it with the target
    // keeps a store key readable when you are staring at one in Redis.
    return { id: `${index}|${policy.match}`, matches: matcher.matches, policy }
  })
}

export interface FailureStageInput {
  operation: Operation
  policies: Array<{ id: string; matches(operation: Operation): boolean; policy: FailurePolicy }>
  decide?: (ctx: Ctx) => Directive | undefined
  store: Store
  chaosSeed: string
  requestKey: string
  counter: () => number
  sleep: (ms: number) => Promise<void>
  fail: Fail
}

/** Pipeline stage 6. */
export function createFailureStage(input: FailureStageInput): Stage {
  return async function failureStage(ctx) {
    const outcome = await checkFailure({
      operation: input.operation,
      ctx,
      policies: input.policies,
      decide: input.decide,
      store: input.store,
      chaosSeed: input.chaosSeed,
      requestKey: input.requestKey,
      counter: input.counter,
      sleep: input.sleep
    })
    if (outcome.ok) {
      ctx.decisions.failure = 'ok'
      return undefined
    }
    ctx.decisions.failure = 'injected'
    return await input.fail(outcome.status, outcome.code, outcome.message, ctx)
  }
}

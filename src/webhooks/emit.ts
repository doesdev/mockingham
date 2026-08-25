import { generateValue } from '../generate/generate.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { applyOverrides } from '../resolve/layer.ts'
import { fnv1a } from '../generate/rng.ts'
import type { Rng } from '../generate/rng.ts'
import type { Api } from '../spec/types.ts'
import type { Store } from '../runtime/store.ts'
import type { OverrideNode } from '../runtime/types.ts'
import { deliver, resolveRetry } from './deliver.ts'
import type { Delivery, ResolvedRetry, RetryConfig } from './deliver.ts'
import { SIGNATURE_HEADER, sign } from './sign.ts'
import type { Registry } from './registry.ts'

/**
 * Where a registering or unregistering operation is declared - design §3.3.
 * `operationId` keeps the proposal's name for familiarity, but its documented
 * type is "a control-plane target": `compileTarget` reads `PUT /subs/{name}`
 * and `* /subs/**` too, and `resolveTarget` throws on one matching nothing, so
 * a typo fails at construction like every other target in the system.
 */
export interface RegisterVia {
  operationId: string
  /** A runtime expression. The bare form is accepted and wrapped (§3.3). */
  url: string
}

export interface UnregisterVia {
  operationId: string
}

export interface WebhookConfig {
  url?: string
  secret?: string
  retry?: RetryConfig
  headers?: Record<string, string>
  registerVia?: RegisterVia
  unregisterVia?: UnregisterVia
  /**
   * A runtime expression partitioning registrations. Without one, a document
   * that registers per tenant has every tenant overwriting one key, so the
   * second registration silently redirects the first tenant's webhooks - a
   * wrong answer that looks like a working mock (§3.4).
   */
  scopeBy?: string
}

export interface ResolvedWebhook {
  url?: string
  secret?: string
  retry: ResolvedRetry
  headers: Record<string, string>
}

export function resolveWebhook(config: WebhookConfig = {}): ResolvedWebhook {
  return {
    url: config.url,
    secret: config.secret,
    retry: resolveRetry(config.retry),
    headers: config.headers ?? {}
  }
}

/**
 * Where a callback URL captured from a runtime expression is stored. Exported
 * because the capture side (the request pipeline) WRITES the key this module
 * READS - two independent spellings of one convention drift silently, with both
 * test suites green in isolation. The same reasoning as `failure.ts`'s exported
 * key builders.
 */
export function callbackKey(name: string): string {
  return `callback|${name}`
}

/**
 * Delivery identity - refinements design §7.2. Derived, never random:
 * invariant 2 requires that replaying a request sequence in another process
 * produce the same ids, which rules out a UUID. Deliberately NOT exported: a
 * test that derives its expected id by calling this would move both sides of
 * its assertion under a mutation and could never fail.
 */
function deliveryId(seed: string, webhook: string, ordinal: number): string {
  return fnv1a(`${seed}|delivery|${webhook}|${ordinal}`).toString(16)
}

/** Design §2.6. A documented constant rather than a config knob. */
export const MAX_DELIVERIES = 1000

export interface DeliveryLog {
  record(delivery: Delivery): void
  /** Oldest first. */
  all(): Delivery[]
  clear(): void
  /** The entry bound this log was built with. Reported when an id ages out. */
  max: number
  /**
   * How many records this log has dropped off its front. Redelivery needs it to
   * tell a typo apart from an id that aged out, which it cannot do by scanning
   * the entries alone. A count rather than a set of evicted ids: the set would
   * grow without bound in exactly the long-lived process the bound exists for.
   */
  evictions(): number
}

/**
 * In memory rather than in the `Store`: `deliveries()` returns an array, and
 * `Store` has no enumeration primitive. Widening that interface for one caller
 * was rejected when the same trade-off arose for `reset()`. The consequence is
 * documented - retry attempt state is shared when the Store is, the capture log
 * is per-process.
 */
export function createDeliveryLog(max: number = MAX_DELIVERIES): DeliveryLog {
  let entries: Delivery[] = []
  let evicted = 0
  return {
    max,
    record(delivery) {
      entries.push(delivery)
      if (entries.length > max) {
        const drop = entries.length - max
        entries = entries.slice(drop)
        evicted += drop
      }
    },
    all: () => [...entries],
    evictions: () => evicted,
    clear() {
      entries = []
      // `clear()` is a reset, not an eviction: nothing aged out, the caller
      // asked for an empty log. Counting it would make `reset()` turn every
      // subsequent unknown id into an "aged out" diagnosis.
      evicted = 0
    }
  }
}

export interface EmitInput {
  name: string
  api: Api
  config: ResolvedWebhook
  store: Store
  captureOnly: boolean
  seed: string
  /**
   * The per-webhook emission ordinal - the same counter value that seeds
   * `rng`. Passed in rather than derived here because the counter lives with
   * the handler, and because the id and the payload rng must key off the same
   * number: two independent counters would drift the moment either grew a
   * caller the other did not have.
   */
  ordinal: number
  rng: Rng
  generateOptions: GenerateOptions
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Destination tier 1. */
  to?: string
  /**
   * Destination tier 2 - refinements design §3.7. REQUIRED, and `undefined`
   * where there is no registry, rather than optional. Optional reads the same
   * at every existing call site but fails differently at a future one: a caller
   * who forgets the field compiles, and silently emits to the tier BELOW the
   * registry - a captured or configured URL in place of the registered one.
   * Requiring it turns that into a compile error.
   */
  registry: Registry | undefined
  /**
   * The scope a registration is looked up under. Empty when absent, which
   * addresses the unscoped registration (design §3.4).
   */
  scope?: string
  /** Layered over the generated payload, exactly as a response body override is. */
  bodyOverride?: OverrideNode
  /** Passed to override functions; an `EmitCtx` for an operation-linked emit. */
  ctx?: unknown
}

/**
 * Resolve a destination, generate and layer a payload, sign it, deliver it.
 *
 * An unknown webhook name THROWS rather than resolving to a failed delivery.
 * §13's "an emit never hard-fails" is about delivery - a name that is not in
 * the document is a typo, and `compileTarget` and `resolveTarget` already fail
 * loudly on those rather than silently never firing.
 */
export async function emitWebhook(input: EmitInput): Promise<Delivery> {
  const spec = input.api.webhooks[input.name]
  if (spec === undefined) {
    throw new Error(
      `mockingham: no webhook named "${input.name}" is declared in the document. ` +
        'Declare it under the top-level `webhooks`, or as an operation `callbacks` entry.'
    )
  }

  // Tier 1 explicit, tier 2 a registration for this scope, tier 3 captured,
  // tier 4 config, tier 5 nothing. The registry sits above the captured tier
  // because a registration is a deliberate, persistent statement about where a
  // webhook goes, while a captured callback URL is incidental to whichever
  // request last happened to carry one - design §3.7.
  const registered = await input.registry?.lookup(input.name, input.scope ?? '')
  const captured = (await input.store.get(callbackKey(input.name))) as string | undefined
  const url = input.to ?? registered ?? captured ?? input.config.url

  const schema = spec.body?.['application/json']?.schema
  const generated = schema === undefined
    ? undefined
    : generateValue(schema, input.rng, input.generateOptions)
  const settled = await applyOverrides(generated, input.bodyOverride, input.ctx)
  const body = settled === undefined ? '' : JSON.stringify(settled)

  // Header parameters the document declares on the webhook, generated from
  // their schemas the same way `renderResponse` generates spec-declared
  // response headers. Config headers layer over them, so an explicit value
  // always wins over a generated one.
  const headers: Record<string, string> = {}
  for (const parameter of spec.headers) {
    const value = generateValue(parameter.schema, input.rng, input.generateOptions)
    if (value !== undefined && value !== null) headers[parameter.name.toLowerCase()] = String(value)
  }
  for (const [name, value] of Object.entries(input.config.headers)) {
    headers[name.toLowerCase()] = value
  }
  if (body !== '') headers['content-type'] = 'application/json'
  if (input.config.secret !== undefined) {
    const signature = await sign(input.config.secret, body, input.now())
    headers[SIGNATURE_HEADER] = signature.header
  }

  return await deliver({
    // One id for the whole emission, built before the attempt loop, so a
    // retry sequence stays one delivery with one identity.
    id: deliveryId(input.seed, input.name, input.ordinal),
    webhook: input.name,
    url,
    method: spec.method.toUpperCase(),
    body,
    headers,
    captureOnly: input.captureOnly,
    retry: input.config.retry,
    seed: input.seed,
    fetch: input.fetch,
    sleep: input.sleep
  })
}

export interface RedeliverInput {
  /** The `Delivery.id` to re-send. The webhook name comes from the record. */
  id: string
  api: Api
  log: DeliveryLog
  /**
   * Retry policy lookup, by webhook name. A function rather than a resolved
   * config because the name is not known until the record is found, and the
   * caller holds the config map.
   */
  configFor: (webhook: string) => ResolvedWebhook
  captureOnly: boolean
  seed: string
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}

/**
 * Re-send a recorded delivery - refinements design §7.3.
 *
 * Keyed by id alone: the webhook name is recoverable from the record, and a
 * two-argument form that could disagree with itself is a defect surface for no
 * benefit.
 *
 * The recorded bytes go back out verbatim - same body, same headers, same
 * destination, same id. It deliberately does NOT regenerate the payload and
 * does NOT re-resolve the destination: the point is to prove that a duplicate
 * carries the same identity, and either would defeat it. In particular the
 * signature header is REPLAYED, not recomputed. `sign` takes a timestamp, so
 * recomputing would emit a different header for identical bytes - realistic in
 * production, but not what "identical bytes, identical ids" asks for.
 *
 * An unknown or aged-out id throws, consistent with `emitWebhook`'s treatment
 * of an unknown webhook name: that is a caller error, not a delivery outcome.
 * A delivery FAILURE is still a recorded outcome and never a throw - invariant
 * 6 is unchanged by redelivery being an emission.
 */
export async function redeliverWebhook(input: RedeliverInput): Promise<Delivery> {
  const record = input.log.all().find((entry) => entry.id === input.id)
  if (record === undefined) {
    const evicted = input.log.evictions()
    throw new Error(
      `mockingham: no delivery with id "${input.id}" is in the delivery log. ` +
        (evicted === 0
          ? 'Redeliver an id returned by emit() or listed by deliveries().'
          : `The log keeps only the most recent ${input.log.max} deliveries and ` +
            `${evicted} older ${evicted === 1 ? 'one has' : 'ones have'} been ` +
            'evicted, so this id may have aged out.')
    )
  }

  return await deliver({
    // The SAME id, not a fresh one: a redelivery is the same delivery sent
    // again, which is the whole observable point of §7.
    id: record.id,
    webhook: record.webhook,
    url: record.url,
    method: input.api.webhooks[record.webhook]?.method.toUpperCase(),
    body: record.body,
    headers: { ...record.headers },
    captureOnly: input.captureOnly,
    retry: input.configFor(record.webhook).retry,
    seed: input.seed,
    fetch: input.fetch,
    sleep: input.sleep
  })
}

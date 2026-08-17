import { generateValue } from '../generate/generate.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { applyOverrides } from '../resolve/layer.ts'
import type { Rng } from '../generate/rng.ts'
import type { Api } from '../spec/types.ts'
import type { Store } from '../runtime/store.ts'
import type { OverrideNode } from '../runtime/types.ts'
import { deliver, resolveRetry } from './deliver.ts'
import type { Delivery, ResolvedRetry, RetryConfig } from './deliver.ts'
import { SIGNATURE_HEADER, sign } from './sign.ts'

export interface WebhookConfig {
  url?: string
  secret?: string
  retry?: RetryConfig
  headers?: Record<string, string>
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

/** Design §2.6. A documented constant rather than a config knob. */
export const MAX_DELIVERIES = 1000

export interface DeliveryLog {
  record(delivery: Delivery): void
  /** Oldest first. */
  all(): Delivery[]
  clear(): void
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
  return {
    record(delivery) {
      entries.push(delivery)
      if (entries.length > max) entries = entries.slice(entries.length - max)
    },
    all: () => [...entries],
    clear() {
      entries = []
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
  rng: Rng
  generateOptions: GenerateOptions
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Destination tier 1. */
  to?: string
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

  // Tier 1 explicit, tier 2 captured, tier 3 config, tier 4 nothing.
  const captured = (await input.store.get(callbackKey(input.name))) as string | undefined
  const url = input.to ?? captured ?? input.config.url

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

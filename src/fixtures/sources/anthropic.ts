import type { ContentSource, FixtureRequest, FixtureResult } from '../source.ts'
import { stripUnsupportedKeywords } from './json-schema-strip.ts'

/**
 * The narrow slice of `@anthropic-ai/sdk`'s surface this source actually
 * calls. `@anthropic-ai/sdk` is an optional peer dependency and is not
 * installed in this repository — this interface exists precisely so a test
 * (or a consumer without the package) can supply a structurally-compatible
 * stub instead of the real client, per the dependency rule in design 2.2.
 * `batches` backs the Message Batches path above `batchThreshold` — design
 * 2.4/2.5/2.6.
 */
export interface AnthropicMessagesParseResponse {
  stop_reason: string
  /**
   * Populated only on a genuine refusal, and even then may be null (design
   * 2.10) — never branch on its presence.
   */
  stop_details?: { category?: string | null; explanation?: string | null } | null
  parsed_output: unknown
}

export interface AnthropicLike {
  messages: {
    parse: (
      params: Record<string, unknown>,
      options?: { timeout?: number }
    ) => Promise<AnthropicMessagesParseResponse>
    batches: {
      create: (params: Record<string, unknown>) => Promise<{ id: string }>
      retrieve: (id: string) => Promise<unknown>
      results: (id: string) => AsyncIterable<unknown>
    }
  }
}

export interface AnthropicSourceOptions {
  model?: string
  apiKey?: string
  /**
   * Above this many requests in one `generate()` call, the source switches
   * from the single-call path to the Message Batches API (design 2.4).
   * Default 20.
   */
  batchThreshold?: number
  timeoutMs?: number
  /** Injectable so the suite never needs the SDK installed. */
  client?: AnthropicLike
  /**
   * Injectable delay for batch polling, so a test can drive a stuck or slow
   * batch to its deadline without a real wall-clock wait. Defaults to a real
   * `setTimeout`-backed sleep — the same shape as `webhooks/deliver.ts`'s
   * injected `sleep`.
   */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MODEL = 'claude-opus-5'
export const DEFAULT_BATCH_THRESHOLD = 20
const MAX_TOKENS = 16000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
// Poll cadence for the Batches API. `timeoutMs` (design 4's default 30_000)
// is converted to a bounded attempt count — `timeoutMs / POLL_INTERVAL_MS` —
// rather than checked against a `Date.now()` deadline (invariant 2). That
// keeps the loop's termination a pure function of attempt count, so a test
// can drive it to its end deterministically by stubbing `retrieve` and
// `sleep`, the same shape as the bounded retry loop in webhooks/deliver.ts.
const POLL_INTERVAL_MS = 1000
const DEFAULT_BATCH_TIMEOUT_MS = 30_000

const SYSTEM = [
  'You generate realistic sample data for an HTTP API mock.',
  'Return only the JSON value for the response body.',
  'Every field must be coherent with the others: names, emails, and companies',
  'must belong to the same fictional entity.'
].join(' ')

function systemFor(request: FixtureRequest): string {
  // Combined into ONE block with the persona, and never split across two
  // blocks: the cache_control breakpoint below needs a combined prefix long
  // enough to clear the 512-token minimum cacheable prefix (design 2.8's
  // sibling note plus the model's cache minimum) — a short persona alone
  // would never reach it.
  return request.persona ? `${SYSTEM} Domain: ${request.persona}` : SYSTEM
}

function promptFor(request: FixtureRequest): string {
  const lines = [
    `Operation: ${request.method.toUpperCase()} ${request.path}`,
    `Response status: ${request.status}`
  ]
  if (request.summary) lines.push(`Summary: ${request.summary}`)
  if (request.description) lines.push(`Description: ${request.description}`)
  if (Object.keys(request.params).length > 0) {
    // Sorted: the prompt must be byte-identical across processes.
    const params = Object.keys(request.params)
      .sort()
      .map((name) => `${name}=${request.params[name]}`)
      .join(', ')
    lines.push(`Resolved path parameters (honor these exactly): ${params}`)
  }
  if (request.example !== undefined) {
    lines.push(`An example from the document: ${JSON.stringify(request.example)}`)
  }
  return lines.join('\n')
}

/**
 * The `output_config.format` payload. The real SDK offers a `zodOutputFormat`
 * helper (`@anthropic-ai/sdk/helpers/zod`) that does this same conversion,
 * but calling it would mean a *second* lazy import that must succeed before
 * a request can even be attempted with an injected `client` — defeating the
 * point of dependency injection for tests, and the point of the package
 * being optional at all. `request.jsonSchema` is already the schema/walk.ts
 * derived, zod-compiled JSON Schema every other source uses (source.ts's
 * `buildRequest`, per the single-schema-interpretation invariant), so this
 * reuses it rather than re-deriving an equivalent schema through the SDK.
 *
 * `stripUnsupportedKeywords` runs UNCONDITIONALLY here, unlike the OpenAI
 * source where it is gated on `strict`. Anthropic's `output_config.format`
 * has no non-strict mode to gate on — `messages.parse` always validates the
 * schema and returns a 400 on `minLength`/`minimum`/`pattern`/etc, so an
 * unstripped schema is a deterministic, permanent miss for any document
 * carrying one of these keywords (the rejection depends only on schema
 * shape, never on model behavior — no retry recovers it). No `extraKeywords`
 * are added: Anthropic documents `format` as a supported keyword, so it is
 * left in place rather than stripped away for no reason (see
 * json-schema-strip.ts's doc comment on why `format` is not in the shared
 * set). `request.jsonSchema` itself is never mutated by this call.
 */
function outputFormatFor(request: FixtureRequest): Record<string, unknown> {
  return { type: 'json_schema', schema: stripUnsupportedKeywords(request.jsonSchema) }
}

/**
 * `fallback: true` is the single-call path only (design 2.5) — the Batches
 * API rejects `fallbacks` outright, so the batch path calls this with
 * `fallback: false` and the keys are omitted entirely, not set to a falsy
 * value. A per-request params object built this way is what design 2.5's
 * "the two cannot be combined" resolves to in code.
 */
function bodyFor(model: string, request: FixtureRequest, mode: { fallback: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: MAX_TOKENS,
    // `thinking` is deliberately omitted, not disabled: on claude-opus-5
    // thinking is adaptive by default, and max_tokens above is sized for
    // thinking plus the response body (design 2.7).
    system: [{ type: 'text', text: systemFor(request), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: promptFor(request) }],
    output_config: { format: outputFormatFor(request), effort: 'low' }
  }
  if (mode.fallback) {
    body.fallbacks = 'default'
    body.betas = [FALLBACK_BETA]
  }
  return body
}

/**
 * One entry from `batches.results()`. Only `type: 'succeeded'` carries a
 * usable `message`; `errored`, `canceled`, and `expired` (and anything else
 * the API might add) are treated identically — a miss, per invariant 4.
 * `message` is intentionally loose (not `AnthropicMessagesParseResponse`):
 * unlike the single-call response, nothing here guarantees `stop_reason` is
 * present.
 */
interface BatchResultEntry {
  custom_id: string
  result?: {
    type?: string
    message?: { stop_reason?: string; parsed_output?: unknown }
  }
}

/**
 * Polls `retrieve` until `processing_status === 'ended'` or `maxAttempts` is
 * exhausted, sleeping `POLL_INTERVAL_MS` between attempts (never after the
 * last). `maxAttempts` is the injected timeout converted to a poll budget —
 * see the constants above — so a batch stuck in `in_progress` forever still
 * returns `false` rather than hanging `generate()`.
 */
async function pollUntilEnded(
  client: AnthropicLike,
  batchId: string,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = (await client.messages.batches.retrieve(batchId)) as { processing_status?: string }
    if (status.processing_status === 'ended') return true
    if (attempt < maxAttempts - 1) await sleep(POLL_INTERVAL_MS)
  }
  return false
}

const INSTALL_ERROR =
  'mockingham: provider "anthropic" requires @anthropic-ai/sdk. ' +
  'Install it, or use the default openai-compatible provider.'

/**
 * Loads the injected client, or lazily imports the real SDK. The module
 * specifier is read through a non-literal variable so `tsc` cannot resolve
 * it statically — the standard way to keep an optional dependency's dynamic
 * `import()` from failing `--noEmit` when the package isn't installed.
 */
async function loadClient(options: AnthropicSourceOptions): Promise<AnthropicLike> {
  if (options.client) return options.client
  const specifier = '@anthropic-ai/sdk'
  try {
    // A non-literal specifier types this import Promise<any> (see the doc
    // comment above) — that is precisely what keeps `tsc --noEmit` clean
    // with the package absent, but it also means the cast below is NEVER
    // checked by the compiler, even once @anthropic-ai/sdk IS installed. If
    // the real package renames its default export or changes the
    // constructor signature, `tsc` will not catch it — only a runtime
    // failure here would, and that failure is caught below and silently
    // becomes a miss (invariant 4). Review this cast by hand whenever
    // @anthropic-ai/sdk is bumped.
    const mod = (await import(specifier)) as {
      default: new (opts: { apiKey?: string }) => AnthropicLike
    }
    return new mod.default({ apiKey: options.apiKey })
  } catch {
    throw new Error(INSTALL_ERROR)
  }
}

export function createAnthropicSource(options: AnthropicSourceOptions): ContentSource {
  const model = options.model ?? DEFAULT_MODEL
  const batchThreshold = options.batchThreshold ?? DEFAULT_BATCH_THRESHOLD
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  // Branch on stop_reason BEFORE reading parsed_output — never on the
  // presence of stop_details, which can be null on a genuine refusal
  // (design 2.10). Shared by both paths: the single-call response and a
  // successful batch entry's `message` are both consumed here.
  const toResult = (
    request: FixtureRequest,
    message: { stop_reason?: string; parsed_output?: unknown } | undefined
  ): FixtureResult | null => {
    if (!message) return null
    if (message.stop_reason === 'refusal') return null
    if (message.parsed_output === null || message.parsed_output === undefined) return null
    const checked = request.zodSchema.safeParse(message.parsed_output)
    if (!checked.success) return null
    return { value: checked.data, meta: { source: 'anthropic', model, promptVersion: 1 } }
  }

  const attempt = async (client: AnthropicLike, request: FixtureRequest): Promise<FixtureResult | null> => {
    const response = await client.messages.parse(
      bodyFor(model, request, { fallback: true }),
      options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined
    )
    return toResult(request, response)
  }

  /**
   * `request.key` is `fixtureKey()`, which deliberately excludes the status
   * (the store namespaces by status separately — design section 2.1). Using
   * it bare as `custom_id` means every status of one operation shares a
   * `custom_id`, so the Batches API's realignment-by-`custom_id` collapses
   * two different requests into one: the results loop below would silently
   * overwrite one status's result with the other's, and the real Batches API
   * rejects a duplicate `custom_id` outright. Folding the status in makes
   * `custom_id` unique per request without touching `fixtureKey` itself,
   * whose status exclusion is load-bearing elsewhere (bake's wildcard-key
   * fallback in resolve.ts). The separator is `-`, not `|`: the Batches API
   * constrains `custom_id` to `^[a-zA-Z0-9_-]{1,64}$` and rejects anything
   * outside that set with a 400 — a `|` would make every batched bake fail
   * against the real API even though the local fake client in this file's
   * tests accepts any string and would never catch it.
   */
  const customId = (request: FixtureRequest): string => `${request.key}-${request.status}`

  const generateBatch = async (client: AnthropicLike, reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]> => {
    const requests = reqs.map((request) => ({
      custom_id: customId(request),
      params: bodyFor(model, request, { fallback: false })
    }))
    const batch = await client.messages.batches.create({ requests })
    const maxAttempts = Math.max(1, Math.floor((options.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS) / POLL_INTERVAL_MS))
    const ended = await pollUntilEnded(client, batch.id, maxAttempts, sleep)
    // A batch that never reaches `ended` within its deadline is a miss for
    // every request in it, not an exception (invariant 4) — results() is
    // never even opened, since nothing in it would be trustworthy yet.
    if (!ended) return reqs.map(() => null)

    const byKey = new Map(reqs.map((request) => [customId(request), request] as const))
    const byId = new Map<string, FixtureResult | null>()
    for await (const raw of client.messages.batches.results(batch.id)) {
      const entry = raw as BatchResultEntry
      const request = byKey.get(entry.custom_id)
      if (!request || entry.result?.type !== 'succeeded') {
        byId.set(entry.custom_id, null)
        continue
      }
      byId.set(entry.custom_id, toResult(request, entry.result.message))
    }
    // Design 2.6: results arrive in arbitrary order, so `reqs` — the
    // caller's ORIGINAL request array, never the order results streamed in
    // — is what gets mapped through `byId`. A `custom_id` never seen in the
    // stream (refused before it was ever emitted, or the stream ended
    // early) is a miss at its own index via `?? null`; it never shifts any
    // other result.
    return reqs.map((request) => byId.get(customId(request)) ?? null)
  }

  return {
    // Ask the driver for chunks big enough to reach the batch threshold. Its
    // own default is far below this, so without asking, `reqs.length >=
    // batchThreshold` below could never hold and the batch path was dead
    // whatever the user configured.
    chunkSize: batchThreshold,

    // Sequential, like the OpenAI-compatible source: the driver decides how
    // many requests arrive per call, and a source that fanned out underneath
    // that would mean two layers each believing they control the load. The
    // batch path is the one exception — it is a single round trip to the API
    // regardless of how many requests it carries, so there is nothing to fan
    // out.
    async generate(reqs) {
      // Invariant 4/6: every failure mode here — a missing package, a
      // refusal, a null parse, a validation failure, a thrown SDK call, a
      // batch that never ends — is a miss, never an error. Nothing
      // propagates out of generate().
      try {
        const client = await loadClient(options)
        if (reqs.length >= batchThreshold) {
          return await generateBatch(client, reqs)
        }
        const out: (FixtureResult | null)[] = []
        for (const request of reqs) {
          try {
            out.push(await attempt(client, request))
          } catch {
            out.push(null)
          }
        }
        return out
      } catch {
        return reqs.map(() => null)
      }
    }
  }
}

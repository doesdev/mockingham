import type { ContentSource, FixtureRequest, FixtureResult } from '../source.ts'
import { stripUnsupportedKeywords } from './json-schema-strip.ts'

/**
 * The narrow slice of `@anthropic-ai/sdk`'s surface this source actually
 * calls. `@anthropic-ai/sdk` is an optional peer dependency and is not
 * installed in this repository — this interface exists precisely so a test
 * (or a consumer without the package) can supply a structurally-compatible
 * stub instead of the real client, per the dependency rule in design 2.2.
 * `batches` is unused by this task (single-call path only — design 2.5) but
 * is part of the shape a real client, or a future batch-path test, expects.
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
   * Reserved for the batch path (design 2.4) — a later task switches to the
   * Message Batches API above this many requests in one `generate()` call.
   * Accepted here so the config surface and this source's options are
   * stable across that task; unused until then.
   */
  batchThreshold?: number
  timeoutMs?: number
  /** Injectable so the suite never needs the SDK installed. */
  client?: AnthropicLike
}

const DEFAULT_MODEL = 'claude-opus-5'
const MAX_TOKENS = 16000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

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

function bodyFor(model: string, request: FixtureRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_TOKENS,
    // `thinking` is deliberately omitted, not disabled: on claude-opus-5
    // thinking is adaptive by default, and max_tokens above is sized for
    // thinking plus the response body (design 2.7).
    system: [{ type: 'text', text: systemFor(request), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: promptFor(request) }],
    output_config: { format: outputFormatFor(request), effort: 'low' },
    // Single-call path only (design 2.5) — the Batches API rejects `fallbacks`.
    fallbacks: 'default',
    betas: [FALLBACK_BETA]
  }
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

  const attempt = async (client: AnthropicLike, request: FixtureRequest): Promise<FixtureResult | null> => {
    const response = await client.messages.parse(
      bodyFor(model, request),
      options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined
    )
    // Branch on stop_reason BEFORE reading parsed_output — never on the
    // presence of stop_details, which can be null on a genuine refusal
    // (design 2.10).
    if (response.stop_reason === 'refusal') return null
    if (response.parsed_output === null || response.parsed_output === undefined) return null
    const checked = request.zodSchema.safeParse(response.parsed_output)
    if (!checked.success) return null
    return { value: checked.data, meta: { source: 'anthropic', model, promptVersion: 1 } }
  }

  return {
    // Sequential, like the OpenAI-compatible source: the driver owns
    // concurrency, and a source that fanned out on its own would make
    // maxConcurrency a lie.
    async generate(reqs) {
      // Invariant 4/6: every failure mode here — a missing package, a
      // refusal, a null parse, a validation failure, a thrown SDK call — is
      // a miss, never an error. Nothing propagates out of generate().
      try {
        const client = await loadClient(options)
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

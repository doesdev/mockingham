import { z } from 'zod'
import { createOpenAiSource } from './sources/openai.ts'
import { createAnthropicSource } from './sources/anthropic.ts'
import type { AnthropicSourceOptions } from './sources/anthropic.ts'
import type { ContentSource } from './source.ts'
import type { ResolvedLlm } from './resolve.ts'

const scopeSchema = z
  .object({ byName: z.array(z.string()).optional(), bySchema: z.array(z.string()).optional() })
  .strict()

const configSchema = z
  .object({
    mode: z.enum(['off', 'bake', 'lazy', 'live']).optional(),
    provider: z.enum(['openai-compatible', 'anthropic']).optional(),
    source: z.custom<ContentSource>((v) => typeof (v as ContentSource)?.generate === 'function').optional(),
    persona: z.string().optional(),
    scope: scopeSchema.optional(),
    budget: z
      .object({
        maxCalls: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional()
      })
      .strict()
      .optional(),
    openai: z
      .object({
        baseUrl: z.string(),
        model: z.string(),
        apiKey: z.string().optional(),
        structuredOutput: z.enum(['json_schema', 'json_object', 'none']).optional(),
        // Passed straight through to createOpenAiSource's own `strict` option
        // (correction 1 in the task brief) - kept here, in the openai block,
        // rather than promoted to a shared namespace, for the same reason
        // every other provider knob lives here: a `.strict()` block is what
        // makes a misplaced option fail loudly instead of doing nothing.
        strict: z.boolean().optional()
      })
      .strict()
      .optional(),
    anthropic: z
      .object({
        model: z.string().optional(),
        apiKey: z.string().optional(),
        batchThreshold: z.number().int().positive().optional()
      })
      .strict()
      .optional()
  })
  // Strict throughout: a key in the wrong provider block must fail rather than
  // silently do nothing. Master spec section 16.
  .strict()

export type LlmConfig = z.input<typeof configSchema>

/**
 * Pulled out of `resolveLlm` so the mapping from parsed config to
 * `AnthropicSourceOptions` is independently testable. `createAnthropicSource`
 * never imports the real SDK until `generate()` runs (and `LlmConfig` has no
 * `client` field to inject one through), so calling it and inspecting the
 * returned `ContentSource` cannot prove `model`/`apiKey`/`batchThreshold`
 * reached it - this function is what makes that threading observable
 * without touching the SDK at all.
 */
export function anthropicOptionsFrom(
  parsed: { anthropic?: { model?: string; apiKey?: string; batchThreshold?: number } },
  budget: { timeoutMs: number }
): AnthropicSourceOptions {
  return {
    model: parsed.anthropic?.model,
    apiKey: parsed.anthropic?.apiKey,
    batchThreshold: parsed.anthropic?.batchThreshold,
    timeoutMs: budget.timeoutMs
  }
}

export function resolveLlm(
  config: LlmConfig | undefined,
  deps: { fetch?: typeof fetch }
): ResolvedLlm | undefined {
  if (config === undefined) return undefined
  const parsed = configSchema.parse(config)
  const mode = parsed.mode ?? 'off'
  const budget = {
    maxCalls: parsed.budget?.maxCalls,
    maxConcurrency: parsed.budget?.maxConcurrency ?? 4,
    timeoutMs: parsed.budget?.timeoutMs ?? 30_000
  }

  const base = { mode, persona: parsed.persona, scope: parsed.scope, budget }

  if (parsed.source) return { ...base, source: parsed.source }
  if (mode === 'off') return base

  const provider = parsed.provider ?? 'openai-compatible'

  if (provider === 'openai-compatible') {
    if (!parsed.openai?.baseUrl) {
      throw new Error(
        'mockingham: llm.openai.baseUrl is required when an llm mode is set. ' +
          'For a local model try http://localhost:11434/v1, or pass llm.source directly.'
      )
    }
    return {
      ...base,
      source: createOpenAiSource({
        baseUrl: parsed.openai.baseUrl,
        model: parsed.openai.model,
        apiKey: parsed.openai.apiKey,
        structuredOutput: parsed.openai.structuredOutput,
        strict: parsed.openai.strict,
        fetch: deps.fetch,
        timeoutMs: budget.timeoutMs
      })
    }
  }

  return {
    ...base,
    source: createAnthropicSource(anthropicOptionsFrom(parsed, budget))
  }
}

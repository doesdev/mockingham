/**
 * JSON Schema keywords no structured-output provider this project talks to
 * accepts on a request schema — sending one of these is not "ignored", it is
 * a hard rejection (Anthropic: 400 on `output_config.format.schema`; OpenAI
 * strict mode: 400 on `response_format.json_schema.schema`). Stripping them
 * is therefore a correctness requirement, not an optional cleanup, and this
 * is the single canonical list both sources strip from — duplicating it per
 * source would let one drift out of sync with what the API actually rejects.
 *
 * `format` is deliberately NOT in this shared set: Anthropic's structured
 * outputs document `format` as a supported keyword (date-time, email, uuid,
 * etc.), so stripping it there would be a needless loss of generation
 * guidance. OpenAI strips it anyway, for its own, already-documented reason
 * (which formats are accepted is model/version-specific) — that is provider
 * policy, not a correctness-relevant keyword every provider rejects, so it
 * is passed as `extraKeywords` at the OpenAI call site rather than folded
 * into this shared set.
 */
export const UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern'
])

export interface StripOptions {
  /** Extra keywords to strip beyond the shared set above (e.g. OpenAI's `format`). */
  extraKeywords?: Iterable<string>
  /**
   * Fold each stripped keyword into the node's `description` as prose,
   * rather than discarding it outright, so a model that can no longer see
   * the constraint structurally still sees it as generation guidance — the
   * same thing the real `@anthropic-ai/sdk` `zodOutputFormat` helper does.
   * Defaults to true.
   */
  describeStripped?: boolean
}

/**
 * One line of deterministic prose describing a stripped keyword+value, so
 * the same input always folds into the same description text. `value` comes
 * straight from parsed JSON — a plain scalar in every case the keywords
 * above ever carry — so `String(value)` is a stable, sufficient rendering;
 * this is not a general-purpose formatter for arbitrary JSON.
 */
function describeConstraint(keyword: string, value: unknown): string {
  switch (keyword) {
    case 'minLength':
      return `Minimum length: ${String(value)}.`
    case 'maxLength':
      return `Maximum length: ${String(value)}.`
    case 'minimum':
      return `Minimum value: ${String(value)}.`
    case 'maximum':
      return `Maximum value: ${String(value)}.`
    case 'exclusiveMinimum':
      return `Value must be strictly greater than ${String(value)}.`
    case 'exclusiveMaximum':
      return `Value must be strictly less than ${String(value)}.`
    case 'multipleOf':
      return `Must be a multiple of ${String(value)}.`
    case 'pattern':
      return `Must match the pattern: ${String(value)}.`
    case 'format':
      return `Format: ${String(value)}.`
    default:
      return `${keyword}: ${String(value)}.`
  }
}

/**
 * Strips keywords a structured-output API rejects, recursing into every
 * nested value generically (object properties, array `items`, and the
 * `anyOf`/`oneOf`/`allOf` arrays) rather than special-casing each — anything
 * reachable is walked. Never mutates its input; every level is rebuilt
 * fresh, so a caller's own schema object is untouched and other consumers
 * keep seeing the original.
 *
 * Keys are visited in sorted order at every node (not just for the rebuilt
 * object's own key order, but as the source of iteration for which
 * constraints get folded into `description`), so the same input schema
 * always produces byte-identical output across processes — required
 * because the rendered request must be byte-identical for prompt caching
 * and reproducible bake runs.
 */
export function stripUnsupportedKeywords(node: unknown, options: StripOptions = {}): unknown {
  const strip = new Set(UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS)
  if (options.extraKeywords) {
    for (const keyword of options.extraKeywords) strip.add(keyword)
  }
  const describeStripped = options.describeStripped ?? true

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== 'object') return value
    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const notes: string[] = []
    for (const key of Object.keys(input).sort()) {
      if (strip.has(key)) {
        if (describeStripped) notes.push(describeConstraint(key, input[key]))
        continue
      }
      out[key] = walk(input[key])
    }
    if (notes.length > 0) {
      const existing = typeof out.description === 'string' ? out.description : undefined
      out.description = [existing, ...notes].filter((part): part is string => Boolean(part)).join(' ')
    }
    return out
  }

  return walk(node)
}

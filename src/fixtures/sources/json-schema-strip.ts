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

// The three keyword shapes that hold nested schemas, and nothing else does.
// A key not in one of these sets (`type`, `required`, `enum`, `const`,
// `default`, `examples`, an existing `description`, ...) is copied through
// verbatim rather than walked — it is data, not a schema position, and
// walking it would apply strip/describe logic to values that only coincide
// in shape with a schema node.
//
// - MAP: `properties`, `patternProperties`, `$defs` — a map from a NAME
//   (a property name, a regex, a def id — author-chosen, never a keyword)
//   to a schema. Only the VALUES are schema nodes; the keys are copied
//   through untouched and never checked against the strip set.
// - VALUE: `items`, `additionalProperties`, `not` — a single nested schema
//   (`additionalProperties` may also be a plain boolean, which the walk
//   below passes through unchanged).
// - LIST: `allOf`, `anyOf`, `oneOf`, `prefixItems` — an array whose
//   elements are schemas.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs'])
const SCHEMA_VALUE_KEYWORDS = new Set(['items', 'additionalProperties', 'not'])
const SCHEMA_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

/**
 * Strips keywords a structured-output API rejects. The walk is structurally
 * aware of JSON Schema's shape rather than generic: earlier this recursed
 * into every nested value as if it were itself a schema node, which is wrong
 * in one specific, damaging way — a `properties` map's KEYS are user-chosen
 * property names, not schema keywords, so a document with a property
 * literally named `format`, `pattern`, or `minimum` had that property
 * deleted outright (and, for the object it lived on, a phantom `description`
 * injected from the "stripped keyword" it was mistaken for). Only the
 * positions listed above ever hold a schema; everything else is copied
 * through untouched. Never mutates its input; every level that IS walked is
 * rebuilt fresh, so a caller's own schema object is untouched and other
 * consumers keep seeing the original.
 *
 * Keys are visited in sorted order at every node walked as a schema or a
 * schema map (not just for the rebuilt object's own key order, but as the
 * source of iteration for which constraints get folded into `description`),
 * so the same input schema always produces byte-identical output across
 * processes — required because the rendered request must be byte-identical
 * for prompt caching and reproducible bake runs.
 */
export function stripUnsupportedKeywords(node: unknown, options: StripOptions = {}): unknown {
  const strip = new Set(UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS)
  if (options.extraKeywords) {
    for (const keyword of options.extraKeywords) strip.add(keyword)
  }
  const describeStripped = options.describeStripped ?? true

  // A schema NODE — the shape strip/describe applies to directly.
  const walkSchema = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const notes: string[] = []
    for (const key of Object.keys(input).sort()) {
      if (strip.has(key)) {
        if (describeStripped) notes.push(describeConstraint(key, input[key]))
        continue
      }
      if (SCHEMA_MAP_KEYWORDS.has(key)) {
        out[key] = walkMap(input[key])
      } else if (SCHEMA_LIST_KEYWORDS.has(key)) {
        out[key] = walkList(input[key])
      } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
        out[key] = walkSchema(input[key])
      } else {
        out[key] = input[key]
      }
    }
    if (notes.length > 0) {
      const existing = typeof out.description === 'string' ? out.description : undefined
      out.description = [existing, ...notes].filter((part): part is string => Boolean(part)).join(' ')
    }
    return out
  }

  // A MAP OF SCHEMAS (`properties`, `patternProperties`, `$defs`): the map
  // object itself is never treated as a schema node — only its values are.
  const walkMap = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) {
      out[key] = walkSchema(input[key])
    }
    return out
  }

  // A LIST OF SCHEMAS (`allOf`, `anyOf`, `oneOf`, `prefixItems`).
  const walkList = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value
    return value.map(walkSchema)
  }

  return walkSchema(node)
}

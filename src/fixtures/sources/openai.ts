import type { ContentSource, FixtureRequest, FixtureResult } from '../source.ts'

export interface OpenAiSourceOptions {
  /** For example `http://localhost:11434/v1` for Ollama. */
  baseUrl: string
  model: string
  apiKey?: string
  /**
   * What the server supports, declared rather than probed. A probe costs a
   * round trip on every cold start and its result is not deterministic —
   * design section 4.
   */
  structuredOutput?: 'json_schema' | 'json_object' | 'none'
  /** Injectable so the suite never reaches the network. */
  fetch?: typeof fetch
  timeoutMs?: number
}

const SYSTEM = [
  'You generate realistic sample data for an HTTP API mock.',
  'Return only the JSON value for the response body.',
  'Every field must be coherent with the others: names, emails, and companies',
  'must belong to the same fictional entity.'
].join(' ')

function promptFor(request: FixtureRequest, includeSchema: boolean): string {
  const lines = [
    `Operation: ${request.method.toUpperCase()} ${request.path}`,
    `Response status: ${request.status}`
  ]
  if (request.summary) lines.push(`Summary: ${request.summary}`)
  if (request.description) lines.push(`Description: ${request.description}`)
  if (Object.keys(request.params).length > 0) {
    // Sorted: the prompt must be byte-identical across processes so a cache
    // read is possible and a bake run is reproducible.
    const params = Object.keys(request.params)
      .sort()
      .map((name) => `${name}=${request.params[name]}`)
      .join(', ')
    lines.push(`Resolved path parameters (honor these exactly): ${params}`)
  }
  if (request.example !== undefined) {
    lines.push(`An example from the document: ${JSON.stringify(request.example)}`)
  }
  if (includeSchema) {
    lines.push(`The value must satisfy this JSON Schema: ${JSON.stringify(request.jsonSchema)}`)
  }
  return lines.join('\n')
}

export function createOpenAiSource(options: OpenAiSourceOptions): ContentSource {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const mode = options.structuredOutput ?? 'json_schema'
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = options.timeoutMs ?? 30_000

  const bodyFor = (request: FixtureRequest): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [
        { role: 'system', content: request.persona ? `${SYSTEM} Domain: ${request.persona}` : SYSTEM },
        { role: 'user', content: promptFor(request, mode !== 'json_schema') }
      ]
    }
    if (mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response_body', schema: request.jsonSchema, strict: true }
      }
    } else if (mode === 'json_object') {
      body.response_format = { type: 'json_object' }
    }
    return body
  }

  const attempt = async (request: FixtureRequest): Promise<FixtureResult | null> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`

    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(request)),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    // Validated in EVERY mode, including json_schema. A server that claims
    // strict support it does not have degrades to a miss here rather than
    // putting an off-contract body into the store.
    const checked = request.zodSchema.safeParse(parsed)
    if (!checked.success) return null

    return {
      value: checked.data,
      meta: { source: 'openai-compatible', model: options.model, promptVersion: 1 }
    }
  }

  const once = async (request: FixtureRequest): Promise<FixtureResult | null> => {
    // Invariant 4: every failure mode here is a miss. Nothing this source does
    // may stop the mock from serving.
    try {
      const first = await attempt(request)
      if (first) return first
      return await attempt(request)
    } catch {
      return null
    }
  }

  return {
    // Sequential rather than concurrent. The driver owns concurrency and its
    // budget; a source that fanned out independently would make maxConcurrency
    // a lie.
    async generate(reqs) {
      const out: (FixtureResult | null)[] = []
      for (const request of reqs) out.push(await once(request))
      return out
    }
  }
}

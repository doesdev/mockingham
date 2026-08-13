import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createOpenAiSource } from '../../../src/fixtures/sources/openai.ts'
import type { FixtureRequest } from '../../../src/fixtures/source.ts'

function request(overrides: Partial<FixtureRequest> = {}): FixtureRequest {
  return {
    operationId: 'getUser',
    method: 'get',
    path: '/users/{id}',
    status: 200,
    key: 'a3f19c2e',
    params: { id: '42' },
    jsonSchema: { type: 'object', properties: { bio: { type: 'string' } } },
    zodSchema: z.object({ bio: z.string() }),
    persona: 'B2B logistics SaaS',
    ...overrides
  }
}

function reply(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

test('json_schema mode sends a response_format and returns the value', async () => {
  const seen: { url?: string; body?: Record<string, unknown> } = {}
  const source = createOpenAiSource({
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.3',
    fetch: async (url, init) => {
      seen.url = String(url)
      seen.body = JSON.parse(String(init?.body))
      return reply({ bio: 'ships containers' })
    }
  })

  const [result] = await source.generate([request()])
  assert.deepEqual(result?.value, { bio: 'ships containers' })
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions')
  const format = seen.body?.response_format as { type: string; json_schema: { strict: boolean } }
  assert.equal(format.type, 'json_schema')
  assert.equal(seen.body?.model, 'llama3.3')
})

test('strict defaults to false: a typical OpenAPI-derived schema would be rejected by real strict mode', async () => {
  let format: { strict?: boolean } = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      format = body.response_format.json_schema
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.equal(format.strict, false)
})

test('strict: true is honored when explicitly passed', async () => {
  let format: { strict?: boolean } = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    strict: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      format = body.response_format.json_schema
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.equal(format.strict, true)
})

test('json_schema mode with strict:true strips constraints real OpenAI strict mode rejects outright', async () => {
  // Stripping is only justified when strict mode is what would otherwise
  // reject these keywords, so this test must opt into strict explicitly —
  // it is no longer the default.
  let schema: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    strict: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      schema = body.response_format.json_schema.schema
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([
    request({
      jsonSchema: {
        type: 'object',
        properties: {
          bio: { type: 'string', minLength: 1, maxLength: 500, format: 'email', pattern: '^a' },
          count: { type: 'integer', minimum: 0, maximum: 100, multipleOf: 1, exclusiveMinimum: -1 }
        }
      }
    })
  ])
  const bioProps = (schema.properties as Record<string, unknown>).bio as Record<string, unknown>
  const countProps = (schema.properties as Record<string, unknown>).count as Record<string, unknown>
  // None of the stripped keywords survive on the schema itself...
  assert.equal(bioProps.type, 'string')
  assert.equal(bioProps.minLength, undefined)
  assert.equal(bioProps.maxLength, undefined)
  assert.equal(bioProps.format, undefined)
  assert.equal(bioProps.pattern, undefined)
  assert.equal(countProps.type, 'integer')
  assert.equal(countProps.minimum, undefined)
  assert.equal(countProps.maximum, undefined)
  assert.equal(countProps.multipleOf, undefined)
  assert.equal(countProps.exclusiveMinimum, undefined)
  // ...but each stripped constraint is folded into description as prose
  // guidance instead of being discarded outright (json-schema-strip.ts),
  // in sorted-keyword order so the request stays byte-identical across
  // processes.
  assert.equal(
    bioProps.description,
    'Format: email. Maximum length: 500. Minimum length: 1. Must match the pattern: ^a.'
  )
  assert.equal(
    countProps.description,
    'Value must be strictly greater than -1. Maximum value: 100. Minimum value: 0. Must be a multiple of 1.'
  )
})

test('json_schema mode with the default strict:false sends constraints intact', async () => {
  // With strict false (the default), OpenAI imposes no subset restriction
  // and local grammar decoders (GBNF, outlines, xgrammar) genuinely use
  // these keywords as generation guidance, so nothing should be stripped.
  // Nothing pinned this before round 2 of task 8 — the stripping helper was
  // (wrongly) called unconditionally in json_schema mode.
  let schema: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      schema = body.response_format.json_schema.schema
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([
    request({
      jsonSchema: {
        type: 'object',
        properties: { bio: { type: 'string', minLength: 1, format: 'email' } }
      }
    })
  ])
  const bioProps = (schema.properties as Record<string, unknown>).bio as Record<string, unknown>
  assert.deepEqual(bioProps, { type: 'string', minLength: 1, format: 'email' })
})

test('json_object mode does NOT strip constraints: the full schema is useful guidance and nothing validates it server-side', async () => {
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    structuredOutput: 'json_object',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([
    request({
      jsonSchema: {
        type: 'object',
        properties: { bio: { type: 'string', minLength: 1, format: 'email' } }
      }
    })
  ])
  const messages = body.messages as Array<{ role: string; content: string }>
  const content = messages[1]?.content as string
  assert.match(content, /"minLength": ?1/)
  assert.match(content, /"format": ?"email"/)
})

test('stripping for strict mode does not mutate request.jsonSchema itself', async () => {
  // strict: true is required here: stripping is now gated on it, and with
  // the default (false) this test would never call stripForStrictMode at
  // all — request.jsonSchema would pass through by reference, unprocessed,
  // and the assertion below would pass for a reason that has nothing to do
  // with what this test's name claims.
  const req = request({
    jsonSchema: {
      type: 'object',
      properties: {
        bio: { type: 'string', minLength: 1, format: 'email' },
        address: {
          type: 'object',
          properties: { city: { type: 'string', minLength: 1, pattern: '^[A-Z]' } }
        }
      }
    }
  })
  const before = JSON.stringify(req.jsonSchema)
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    strict: true,
    fetch: async () => reply({ bio: 'ok' })
  })
  await source.generate([req])
  assert.equal(JSON.stringify(req.jsonSchema), before)
  // A shallow copy at the top level only would leave nested objects shared
  // by reference with the rebuilt/stripped tree, so a caller reading
  // req.jsonSchema.properties.address.properties.city after generate() could
  // see its minLength/pattern stripped out even though the top-level
  // JSON.stringify comparison above still matched (a shallow copy that
  // stripped in place would corrupt shared nested objects while the outer
  // object reference itself stays swapped out, not stringified differently
  // at the top until the shared nested node is actually inspected). Check
  // the nested constraint directly so this can't pass by only inspecting a
  // level the rebuild happened to leave alone.
  const properties = req.jsonSchema.properties as Record<string, unknown>
  const address = properties.address as Record<string, unknown>
  const addressProperties = address.properties as Record<string, unknown>
  const city = addressProperties.city as Record<string, unknown>
  assert.deepEqual(city, { type: 'string', minLength: 1, pattern: '^[A-Z]' })
})

test('json_object mode sends the simpler format and carries the schema in the prompt', async () => {
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    structuredOutput: 'json_object',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.deepEqual(body.response_format, { type: 'json_object' })
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.match(messages[1]?.content as string, /"type": ?"object"/)
})

test('none mode sends no response_format at all', async () => {
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    structuredOutput: 'none',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.equal('response_format' in body, false)
})

test('an authorization header is sent only when an api key is configured', async () => {
  const headers: Array<string | null> = []
  const capture = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    headers.push(new Headers(init?.headers).get('authorization'))
    return reply({ bio: 'ok' })
  }
  await createOpenAiSource({ baseUrl: 'http://x/v1', model: 'm', fetch: capture })
    .generate([request()])
  await createOpenAiSource({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'sk-test', fetch: capture })
    .generate([request()])
  assert.deepEqual(headers, [null, 'Bearer sk-test'])
})

test('a response failing schema validation retries once, then misses', async () => {
  let calls = 0
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => {
      calls += 1
      return reply({ bio: 42 })
    }
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
  assert.equal(calls, 2)
})

test('a valid response on the retry is returned', async () => {
  let calls = 0
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply({ bio: 42 }) : reply({ bio: 'second time' })
    }
  })
  const [result] = await source.generate([request()])
  assert.deepEqual(result?.value, { bio: 'second time' })
})

test('malformed json is a miss, not a throw', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{ not json' } }] }))
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('a 200 response whose outer body is not JSON is a miss, not a throw', async () => {
  // Distinct from the malformed-JSON test above, which is about the INNER
  // `content` string being unparseable. Here the OUTER envelope itself is
  // not valid JSON, so `response.json()` throws before `payload.choices` is
  // even reachable — a different line, a different failure mode.
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => new Response('not json at all', { status: 200 })
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('an http 500 is a miss, not a throw', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => new Response('upstream is unhappy', { status: 500 })
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('a rejected fetch is a miss, not a throw', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => {
      throw new Error('connection refused')
    }
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('an abort-shaped rejection (what a real timeout produces) is a miss, not a throw', async () => {
  // We cannot exercise a real wall-clock timeout deterministically without
  // waiting on real time, which the brief for this task explicitly forbids.
  // What we CAN prove without a clock: (1) the configured timeout is wired
  // into an AbortSignal handed to fetch, and (2) the exact rejection shape a
  // real timeout produces at the fetch boundary — a DOMException named
  // 'AbortError' — is handled as a miss like any other fetch rejection.
  let sawSignal: AbortSignal | undefined
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    timeoutMs: 5,
    fetch: async (_url, init) => {
      sawSignal = init?.signal as AbortSignal
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
  assert.ok(sawSignal instanceof AbortSignal)
})

test('results are positionally aligned with the requests', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = (body.messages as Array<{ content: string }>)[1]?.content ?? ''
      return prompt.includes('"id":"1"') || prompt.includes('id=1')
        ? reply({ bio: 'first' })
        : reply({ bio: 'second' })
    }
  })
  const results = await source.generate([
    request({ key: 'k1', params: { id: '1' } }),
    request({ key: 'k2', params: { id: '2' } })
  ])
  assert.equal(results.length, 2)
  assert.deepEqual(results[0]?.value, { bio: 'first' })
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('results stay positionally aligned when the FIRST request misses and the second succeeds', async () => {
  // Deliberately the harder direction. An implementation that sorted
  // successes before misses (or otherwise compacted/reordered) would produce
  // [value, null] here too when the correct output is [null, value] — the
  // failure has to be caught at the front, not just proven present somewhere.
  // A miss-second variant (below) cannot catch that class of bug by itself:
  // a "successes first" implementation returns the SAME [value, null] shape
  // as the correct output whenever the failure already comes second.
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = (body.messages as Array<{ content: string }>)[1]?.content ?? ''
      return prompt.includes('id=1') ? reply({ bio: 999 }) : reply({ bio: 'second' })
    }
  })
  const results = await source.generate([
    request({ key: 'k1', params: { id: '1' } }),
    request({ key: 'k2', params: { id: '2' } })
  ])
  assert.equal(results.length, 2)
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('results stay positionally aligned when the SECOND request misses and the first succeeds', async () => {
  // The mirror image of the test above. Asserting both directions means
  // neither a "drop the misses" bug nor a "sort successes first" bug can
  // pass by only exercising the direction that happens to look correct.
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = (body.messages as Array<{ content: string }>)[1]?.content ?? ''
      return prompt.includes('id=1') ? reply({ bio: 'first' }) : reply({ bio: 999 })
    }
  })
  const results = await source.generate([
    request({ key: 'k1', params: { id: '1' } }),
    request({ key: 'k2', params: { id: '2' } })
  ])
  assert.equal(results.length, 2)
  assert.deepEqual(results[0]?.value, { bio: 'first' })
  assert.equal(results[1], null)
})

test('the meta records the provider and model', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'llama3.3',
    fetch: async () => reply({ bio: 'ok' })
  })
  const [result] = await source.generate([request()])
  assert.equal(result?.meta?.source, 'openai-compatible')
  assert.equal(result?.meta?.model, 'llama3.3')
})

test('a trailing slash on the base url does not double the separator', async () => {
  let url = ''
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1/',
    model: 'm',
    fetch: async (target) => {
      url = String(target)
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.equal(url, 'http://x/v1/chat/completions')
})

test('a per-property description from the json schema reaches the outgoing request', async () => {
  // buildRequest upstream now threads OpenAPI property descriptions into
  // jsonSchema.properties.*.description. That is deliberate prompt context;
  // this proves the source does not drop it on the way out — in json_schema
  // mode it travels inside response_format.json_schema.schema, which is the
  // only place it can go since the schema itself is withheld from the user
  // message in that mode.
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([
    request({
      jsonSchema: {
        type: 'object',
        properties: { bio: { type: 'string', description: 'A one-paragraph shipping bio.' } }
      }
    })
  ])
  const format = body.response_format as { json_schema: { schema: Record<string, unknown> } }
  assert.match(JSON.stringify(format.json_schema.schema), /A one-paragraph shipping bio\./)
})

test('a per-property description reaches the user message in json_object mode', async () => {
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    structuredOutput: 'json_object',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([
    request({
      jsonSchema: {
        type: 'object',
        properties: { bio: { type: 'string', description: 'A one-paragraph shipping bio.' } }
      }
    })
  ])
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.match(messages[1]?.content as string, /A one-paragraph shipping bio\./)
})

test('the request body is byte-identical across two calls with the same request, regardless of param key order', async () => {
  // A prompt (and the surrounding body) that varies by key order silently
  // defeats prompt caching and breaks bake reproducibility. Build the same
  // logical request twice with params inserted in opposite orders and
  // confirm the serialized bodies match exactly, not just some substring.
  const bodies: string[] = []
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  const forward = request({ params: { id: '1', region: 'eu' } })
  const backward = request({ params: { region: 'eu', id: '1' } })
  await source.generate([forward])
  await source.generate([backward])
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
})

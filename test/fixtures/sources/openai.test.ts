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

test('json_schema mode sends a strict response_format and returns the value', async () => {
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
  assert.equal(format.json_schema.strict, true)
  assert.equal(seen.body?.model, 'llama3.3')
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

test('results stay positionally aligned when the second request misses and the first succeeds', async () => {
  // The above alignment test has both requests succeed, which cannot
  // distinguish correct alignment from an implementation that just drops
  // failures and shifts everything down. This one fails request #2 (an id
  // of '2' always gets an invalid body) and asserts the miss lands at index
  // 1, not that it vanishes or bleeds into index 0.
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

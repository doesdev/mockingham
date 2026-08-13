import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createAnthropicSource } from '../../../src/fixtures/sources/anthropic.ts'
import type { FixtureRequest } from '../../../src/fixtures/source.ts'

function request(key: string): FixtureRequest {
  return {
    operationId: 'getUser', method: 'get', path: '/users/{id}', status: 200,
    key, params: {}, jsonSchema: { type: 'object' },
    zodSchema: z.object({ bio: z.string() })
  }
}

function requestWithSchema(key: string, jsonSchema: Record<string, unknown>): FixtureRequest {
  return {
    operationId: 'getUser', method: 'get', path: '/users/{id}', status: 200,
    key, params: {}, jsonSchema,
    zodSchema: z.object({ bio: z.string() })
  }
}

test('a parsed response becomes a result', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.deepEqual(result?.value, { bio: 'ok' })
  assert.equal(result?.meta?.source, 'anthropic')
})

test('a refusal is a miss, and a null stop_details does not throw', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'refusal', stop_details: null, parsed_output: null }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('a null parsed_output is a miss', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: null }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('a value failing schema validation is a miss', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: { bio: 42 } }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('the single-call path sends fallbacks and the effort setting', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          sent = params
          return { stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }
        },
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  await source.generate([request('k')])
  assert.equal(sent.fallbacks, 'default')
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01'])
  const output = sent.output_config as { effort: string; format: unknown }
  assert.equal(output.effort, 'low')
  assert.ok(output.format)
  assert.equal(sent.model, 'claude-opus-5')
})

// --- Gaps beyond the brief's Step 1 tests (see task-13-report.md for why) ---

test('a refusal is checked BEFORE parsed_output is read, even when parsed_output is valid', async () => {
  // Distinguishes "checked first" from "checked after": a stub that returns
  // both a refusal stop_reason AND a schema-valid parsed_output. Code that
  // read content before branching on stop_reason would return the valid
  // value here instead of null.
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'refusal', stop_details: null, parsed_output: { bio: 'ok' } }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('a refusal with no stop_details key at all does not throw', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'refusal', parsed_output: null }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('results stay positionally aligned when an earlier request misses and a later one succeeds', async () => {
  let call = 0
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => {
          call += 1
          if (call === 1) return { stop_reason: 'refusal', stop_details: null, parsed_output: null }
          return { stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }
        },
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const results = await source.generate([request('a'), request('b')])
  assert.equal(results.length, 2)
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'ok' })
})

test('a thrown SDK call is a miss, not an error', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => {
          throw new Error('network exploded')
        },
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('constructing the source does not import the SDK — only generate() does', async () => {
  // If createAnthropicSource ever started an un-awaited import('@anthropic-ai/sdk')
  // at construction time (rather than inside generate()), that import would
  // reject — the package is not installed in this repo — and surface as an
  // unhandled rejection shortly after construction, not as a thrown error
  // from the synchronous factory call itself.
  let caught: unknown
  const onUnhandledRejection = (error: unknown) => {
    caught = error
  }
  process.on('unhandledRejection', onUnhandledRejection)
  try {
    const source = createAnthropicSource({})
    assert.equal(typeof source.generate, 'function')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(caught, undefined)
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }
})

// --- Fix round 1: output_config.format.schema must be strippable ----------
// Anthropic validates output_config.format.schema strictly and returns a 400
// on minLength/minimum/pattern/etc — sending them unstripped would be a
// deterministic, permanent miss for any document using them.

test('output_config.format.schema carries no stripped keywords, and the stripped constraints reach description', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          sent = params
          return { stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }
        },
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const req = requestWithSchema('k', {
    type: 'object',
    properties: { bio: { type: 'string', minLength: 1, maxLength: 500 } }
  })
  await source.generate([req])
  const output = sent.output_config as { format: { schema: { properties: Record<string, unknown> } } }
  const bio = output.format.schema.properties.bio as Record<string, unknown>
  assert.equal(bio.minLength, undefined)
  assert.equal(bio.maxLength, undefined)
  assert.equal(bio.description, 'Maximum length: 500. Minimum length: 1.')
})

test('request.jsonSchema itself is not mutated by building output_config.format', async () => {
  const req = requestWithSchema('k', {
    type: 'object',
    properties: { bio: { type: 'string', minLength: 1 } }
  })
  const before = JSON.stringify(req.jsonSchema)
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  await source.generate([req])
  assert.equal(JSON.stringify(req.jsonSchema), before)
})

test('a schema with no constraints reaches output_config.format.schema unchanged', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          sent = params
          return { stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }
        },
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const jsonSchema = { type: 'object', properties: { bio: { type: 'string' } } }
  await source.generate([requestWithSchema('k', jsonSchema)])
  const output = sent.output_config as { format: { schema: unknown } }
  assert.deepEqual(output.format.schema, jsonSchema)
})

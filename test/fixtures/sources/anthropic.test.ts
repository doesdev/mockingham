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

function requestWithStatus(key: string, status: number): FixtureRequest {
  return {
    operationId: 'getUser', method: 'get', path: '/users/{id}', status,
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

// --- Task 14: the batch path -----------------------------------------------

test('above the threshold the batch path runs and results realign by custom_id', async () => {
  // Deliberately returned in reverse order — the API makes no ordering promise,
  // and getting this wrong attaches the wrong body to the wrong request with no
  // error at all. Design section 2.6.
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('the batch path must not call parse') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            yield { custom_id: 'k2|200', result: { type: 'succeeded', message: { parsed_output: { bio: 'second' } } } }
            yield { custom_id: 'k1|200', result: { type: 'succeeded', message: { parsed_output: { bio: 'first' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.deepEqual(results[0]?.value, { bio: 'first' })
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

// Every realignment test above uses distinct KEYS at the same status
// (200), which is exactly why a `custom_id` collision across DIFFERENT
// statuses of the SAME key went unmodelled: `fixtureKey()` deliberately
// excludes the status, so `request.key` alone is not unique across a
// two-status operation. This drives that shape directly: same key, two
// statuses, and checks each receives its OWN body rather than one status's
// result silently landing on the other.
test('same key, different statuses: each status realigns to its own body, not to the other status', async () => {
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('the batch path must not call parse') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            // Reverse order, same as the custom_id realignment test above —
            // the API makes no ordering promise.
            yield { custom_id: 'k|404', result: { type: 'succeeded', message: { parsed_output: { bio: 'not-found body' } } } }
            yield { custom_id: 'k|200', result: { type: 'succeeded', message: { parsed_output: { bio: 'ok body' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([requestWithStatus('k', 200), requestWithStatus('k', 404)])
  assert.deepEqual(results[0]?.value, { bio: 'ok body' })
  assert.deepEqual(results[1]?.value, { bio: 'not-found body' })
})

// Pins the outbound shape directly: two requests sharing a key but differing
// only in status must be sent with two DIFFERENT custom_ids. Without this,
// a fix that realigned correctly by accident (e.g. by index) could still
// leave the outbound `custom_id`s colliding, which is what the real
// Batches API rejects.
test('the outbound custom_id is unique per status even when the key is shared', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async (params: Record<string, unknown>) => {
            sent = params
            return { id: 'batch_1' }
          },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {}
        }
      }
    }
  })
  await source.generate([requestWithStatus('k', 200), requestWithStatus('k', 404)])
  const requests = sent.requests as Array<{ custom_id: string }>
  const ids = requests.map((r) => r.custom_id)
  assert.equal(new Set(ids).size, 2)
  assert.deepEqual(ids.sort(), ['k|200', 'k|404'])
})

test('a batch entry with no result is a miss, not a shift', async () => {
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            yield { custom_id: 'k2|200', result: { type: 'succeeded', message: { parsed_output: { bio: 'second' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('an errored batch entry is a miss', async () => {
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            yield { custom_id: 'k1|200', result: { type: 'errored', error: {} } }
            yield { custom_id: 'k2|200', result: { type: 'succeeded', message: { parsed_output: { bio: 'second' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('the batch path does not send fallbacks', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async (params: Record<string, unknown>) => {
            sent = params
            return { id: 'batch_1' }
          },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {}
        }
      }
    }
  })
  await source.generate([request('k1'), request('k2')])
  const requests = sent.requests as Array<{ params: Record<string, unknown> }>
  // fallbacks is rejected on the Batches API — design section 2.5.
  assert.equal('fallbacks' in (requests[0]?.params ?? {}), false)
})

// --- Gaps beyond the brief's Step 1 tests for task 14 -----------------------

test('the batch path also omits betas, not just fallbacks', async () => {
  // The brief's fallbacks test alone would still pass a mutant that dropped
  // ONLY the fallbacks key but left betas in place — betas is meaningless
  // without the fallbacks beta feature it enables, but a partial fix is still
  // a bug. This asserts both keys are gone from the SAME per-request params
  // object the fallbacks test inspects.
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async (params: Record<string, unknown>) => {
            sent = params
            return { id: 'batch_1' }
          },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {}
        }
      }
    }
  })
  await source.generate([request('k1'), request('k2')])
  const requests = sent.requests as Array<{ params: Record<string, unknown> }>
  assert.equal('betas' in (requests[0]?.params ?? {}), false)
  assert.equal('betas' in (requests[1]?.params ?? {}), false)
})

test('below the threshold the single-call path runs, not the batch path', async () => {
  // The brief only tests the batch side of the threshold. Without this, an
  // implementation that always uses the batch path (or gets the comparison
  // backward) would still pass every test above, since all of them meet or
  // exceed their configured threshold.
  let parseCalls = 0
  const source = createAnthropicSource({
    batchThreshold: 5,
    client: {
      messages: {
        parse: async () => {
          parseCalls += 1
          return { stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }
        },
        batches: {
          create: async () => { throw new Error('the single-call path must not create a batch') },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {}
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.equal(parseCalls, 2)
  assert.deepEqual(results[0]?.value, { bio: 'ok' })
  assert.deepEqual(results[1]?.value, { bio: 'ok' })
})

test('a request count exactly at the threshold takes the batch path', async () => {
  // Pins the boundary as inclusive (>=), matching the brief's Step 3
  // ("reqs.length >= batchThreshold"). A stray `>` would silently push every
  // exactly-at-threshold bake run onto the single-call path.
  let created = false
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('the batch path must not call parse') },
        batches: {
          create: async () => {
            created = true
            return { id: 'batch_1' }
          },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {}
        }
      }
    }
  })
  await source.generate([request('k1'), request('k2')])
  assert.equal(created, true)
})

test('polling terminates on a stuck batch rather than hanging, and every request misses', async () => {
  // The batch never reaches `ended`. `timeoutMs` bounds the poll loop to a
  // fixed number of attempts (POLL_INTERVAL_MS apart) rather than a
  // Date.now() deadline, so this test drives it to that bound deterministically:
  // `sleep` is stubbed to resolve immediately, so the test does not wait on
  // the real clock, and `retrieveCalls` proves the loop actually stopped
  // rather than running forever.
  let retrieveCalls = 0
  const source = createAnthropicSource({
    batchThreshold: 2,
    timeoutMs: 3000,
    sleep: async () => {},
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => {
            retrieveCalls += 1
            return { processing_status: 'in_progress' }
          },
          results: async function* () {
            throw new Error('results() must not be read — the batch never ended')
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.deepEqual(results, [null, null])
  assert.equal(retrieveCalls, 3)
})

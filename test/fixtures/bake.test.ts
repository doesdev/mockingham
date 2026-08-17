import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bake } from '../../src/fixtures/bake.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import { loadApi } from '../../src/spec/load.ts'
import { applyOverrides } from '../../src/resolve/layer.ts'
import { generateValue } from '../../src/generate/generate.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { ContentSource, FixtureResult } from '../../src/fixtures/source.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'object', properties: { bio: { type: 'string' } } }
                }
              }
            }
          },
          '404': {
            description: 'gone',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

function sourceReturning(value: unknown): ContentSource {
  return { generate: async (reqs) => reqs.map(() => ({ value }) as FixtureResult) }
}

test('bake fills the store for every declared status', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  assert.equal(summary.generated, 2)
  assert.equal(store.records().length, 2)
})

test('error statuses are baked too - they have declared schemas', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  const record = store.records().find((r) => r.status === 404)
  // Not just "some record exists at 404" - its stored value must be the one
  // the source actually produced for that status, proving this is the baked
  // error body and not, say, a leftover from the 200 branch.
  assert.deepEqual(record?.entry.value, { message: 'gone' })
})

test('a null result counts as failed and stores nothing', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map(() => null) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  assert.equal(summary.failed, 2)
  assert.equal(store.records().length, 0)
})

test('a throwing source reaches onError and stores nothing, counting the whole chunk failed', async () => {
  const store = createMemoryFixtureStore()
  const errors: unknown[] = []
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: { generate: async () => { throw new Error('provider down') } },
    compiler: createCompiler(),
    now: () => 1_000,
    onError: (error) => errors.push(error)
  })
  assert.equal(store.records().length, 0)
  assert.equal(summary.failed, 2)
  // Both statuses land in one chunk (default concurrency 4 covers both), so
  // the provider is called once and onError fires once - not once per
  // status. A per-item retry or a second attempt would show up here.
  assert.equal(errors.length, 1)
})

test('maxCalls stops the walk and counts the rest as skipped', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: sourceReturning([{ bio: 'a' }]),
    compiler: createCompiler(),
    now: () => 1_000,
    budget: { maxCalls: 1, maxConcurrency: 1 }
  })
  assert.equal(summary.generated, 1)
  assert.equal(summary.skipped, 1)
})

test('the stored meta records the injected clock, not wall time', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_700_000_000_000
  })
  const record = store.records()[0]
  assert.equal(record?.entry.meta?.generatedAt, new Date(1_700_000_000_000).toISOString())
})

test('a scoped config stores only the scoped paths, as the index-keyed shape narrow() now returns', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a', extra: 'dropped' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000,
    scope: { byName: ['bio'] }
  })
  const ok = store.records().find((r) => r.status === 200)
  // narrow() over an array now returns an index-keyed object, not a literal
  // array - a scoped array fixture stored as a literal array would replace
  // the base array wholesale on apply rather than merging per index.
  assert.deepEqual(ok?.entry.value, { '0': { bio: 'a' } })
})

test('a scoped bake marks the stored entry meta as scoped, so it is still applied as a layer even when served without a scope config', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a', extra: 'dropped' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000,
    scope: { byName: ['bio'] }
  })
  const ok = store.records().find((r) => r.status === 200)
  assert.equal(ok?.entry.meta?.scoped, true)
})

test('an unscoped bake does not mark the entry as scoped', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  const ok = store.records().find((r) => r.status === 200)
  assert.equal(ok?.entry.meta?.scoped, undefined)
})

// --- Beyond the brief -------------------------------------------------

// Three declared statuses on one operation, each with a distinct, simple,
// non-recursive JSON body - used below to exercise chunking, truncation and
// continuation across more than the two statuses `doc` provides.
const multiStatusDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/items': {
      get: {
        operationId: 'getItems',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
              }
            }
          },
          '404': {
            description: 'missing',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string' } } }
              }
            }
          },
          '500': {
            description: 'broken',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

test('the walk continues past a failed chunk: later statuses are still attempted and stored', async () => {
  const store = createMemoryFixtureStore()
  // maxConcurrency 1 puts every status in its own chunk, sorted ascending:
  // 200, then 404, then 500. The source throws only for 200. If the walk
  // stopped at the first failure - rather than merely counting it and
  // moving on - 404 and 500 would never be attempted and no record would
  // exist for either. Their presence is the actual proof of continuation;
  // a summary count alone cannot tell "continued" from "stopped early".
  const source: ContentSource = {
    generate: async (reqs) => {
      if (reqs[0]?.status === 200) throw new Error('boom')
      return reqs.map((r) => ({ value: { message: `ok-${r.status}` } }))
    }
  }
  const summary = await bake({
    api: loadApi(multiStatusDoc),
    store,
    source,
    compiler: createCompiler(),
    now: () => 1_000,
    budget: { maxConcurrency: 1 }
  })
  assert.equal(summary.failed, 1)
  assert.equal(summary.generated, 2)
  const statuses = store.records().map((r) => r.status).sort((a, b) => a - b)
  assert.deepEqual(statuses, [404, 500])
})

test('maxCalls truncates the same way on every run - the sorted prefix, not an arbitrary subset', async () => {
  const source: ContentSource = {
    generate: async (reqs) => reqs.map((r) => ({ value: { tag: `status-${r.status}` } }))
  }
  const run = async () => {
    const store = createMemoryFixtureStore()
    const summary = await bake({
      api: loadApi(multiStatusDoc),
      store,
      source,
      compiler: createCompiler(),
      now: () => 1_000,
      budget: { maxCalls: 2, maxConcurrency: 5 }
    })
    const statuses = store.records().map((r) => r.status).sort((a, b) => a - b)
    return { summary, statuses }
  }

  const first = await run()
  const second = await run()

  assert.deepEqual(first.summary, second.summary)
  assert.deepEqual(first.statuses, second.statuses)
  // Not just "the same set twice" - specifically the two lowest statuses in
  // sort order (200, 404), never 500, and never an arbitrary pair.
  assert.deepEqual(first.statuses, [200, 404])
  assert.equal(first.summary.generated, 2)
  assert.equal(first.summary.skipped, 1)
})

// All the tests above use a document with a single operation, so none of
// them exercise sorting ACROSS operations - only across statuses within one
// operation. A document that declares its later-alphabetical path first
// would defeat a truncated budget's determinism if the walk relied on
// declaration order instead of an explicit sort.
const twoOperationDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    // Declared out of alphabetical order on purpose.
    '/zebra': {
      get: {
        operationId: 'getZebra',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { z: { type: 'string' } } }
              }
            }
          }
        }
      }
    },
    '/apple': {
      get: {
        operationId: 'getApple',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { a: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

test('a maxCalls budget picks operations by path order, not declaration order', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(twoOperationDoc),
    store,
    source: sourceReturning({ ok: true }),
    compiler: createCompiler(),
    now: () => 1_000,
    budget: { maxCalls: 1, maxConcurrency: 1 }
  })
  assert.equal(summary.generated, 1)
  assert.equal(summary.skipped, 1)
  const record = store.records()[0]
  // '/apple' sorts before '/zebra' even though '/zebra' was declared first
  // in the document.
  assert.equal(record?.operationId, 'getApple')
})

// The scoped-config test above only proves narrow()'s output SHAPE. It says
// nothing about what happens when that shape is written to disk, read back,
// and actually merged over a freshly generated response - which is the one
// thing the index-keyed shape exists to get right. This test drives the
// real pipeline end to end: bake() -> JSON round trip (simulating the file
// on disk) -> applyOverrides() from src/resolve/layer.ts, over an
// independently generated base array, and checks that an item with nothing
// in scope keeps every generated field and the array is not truncated.
const arrayDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/widgets': {
      get: {
        operationId: 'listWidgets',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 2,
                  items: {
                    type: 'object',
                    properties: {
                      bio: { type: 'string' },
                      extra: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

test('a scoped array fixture survives bake and a JSON round trip: unmatched items keep every generated field, and the array is not truncated', async () => {
  const store = createMemoryFixtureStore()
  const api = loadApi(arrayDoc)

  await bake({
    api,
    store,
    source: {
      generate: async () => [{
        value: [
          { bio: 'scoped-bio', extra: 'dropped-extra' },
          // Nothing in scope at this index at all - no `bio` key.
          { extra: 'still-dropped' }
        ]
      }]
    },
    compiler: createCompiler(),
    now: () => 1_000,
    scope: { byName: ['bio'] }
  })

  const record = store.records()[0]
  assert.ok(record)

  // Simulate the disk round trip: serialize, then parse back.
  const override = JSON.parse(JSON.stringify(record.entry.value))
  assert.deepEqual(override, { '0': { bio: 'scoped-bio' } })

  // An independently generated base array for the same schema - nothing to
  // do with the fixture above except sharing the schema.
  const operation = api.operations[0]
  const responseSchema = operation?.responses.find((r) => r.status === 200)
    ?.content['application/json']?.schema
  assert.ok(responseSchema)
  const base = generateValue(responseSchema, createRng('round-trip-seed')) as Array<{
    bio: string
    extra: string
  }>
  assert.equal(base.length, 2)

  const merged = (await applyOverrides(base, override, undefined)) as Array<{
    bio: string
    extra: string
  }>

  assert.equal(merged.length, 2, 'the array must not be truncated to the scoped index')
  assert.equal(merged[0]?.bio, 'scoped-bio')
  // The unscoped field on the matched item is untouched, not dropped.
  assert.equal(merged[0]?.extra, base[0]?.extra)
  // The item with nothing in scope is left completely alone - every
  // generated field intact. If narrow() still returned a literal array here
  // instead of an index-keyed object, this item (and its fields) would be
  // gone entirely: overlay() replaces a base array wholesale when the
  // override is itself an array, rather than merging it per index.
  assert.deepEqual(merged[1], base[1])
})

/** Six bakeable entries: three operations, each declaring two statuses. */
function sixEntryDoc(): Record<string, unknown> {
  const responses = {
    '200': {
      description: 'ok',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { a: { type: 'string' } } }
        }
      }
    },
    '404': {
      description: 'gone',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { message: { type: 'string' } } }
        }
      }
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/a': { get: { operationId: 'a', responses } },
      '/b': { get: { operationId: 'b', responses } },
      '/c': { get: { operationId: 'c', responses } }
    }
  }
}

function recordingSource(chunkSize?: number): ContentSource & { sizes: number[] } {
  const sizes: number[] = []
  return {
    sizes,
    ...(chunkSize === undefined ? {} : { chunkSize }),
    generate: async (reqs) => {
      sizes.push(reqs.length)
      return reqs.map(() => null)
    }
  }
}

test('the driver hands a source its declared chunkSize, not maxConcurrency', async () => {
  // The Anthropic batch path is only reached at or above its batchThreshold
  // (20), but the driver chunked by maxConcurrency (4), so batching was dead
  // under default config. A source that knows it wants larger calls says so.
  const source = recordingSource(20)

  await bake({
    api: loadApi(sixEntryDoc()),
    store: createMemoryFixtureStore(),
    source,
    compiler: createCompiler(),
    now: () => 0,
    budget: { maxConcurrency: 4 }
  })

  assert.deepEqual(source.sizes, [6])
})

const rangeCollisionDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/thing': {
      get: {
        operationId: 'thing',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }
            }
          },
          '400': {
            description: 'exact',
            content: {
              'application/json': { schema: { type: 'object', properties: { exact: { type: 'string' } } } }
            }
          },
          '4XX': {
            description: 'range',
            content: {
              'application/json': { schema: { type: 'object', properties: { ranged: { type: 'string' } } } }
            }
          }
        }
      }
    }
  }
}

test('a range response does not overwrite the exact status it shares a bound with', async () => {
  // A range carries its bucket's LOWER BOUND in `status`, so `4XX` and an
  // exactly declared `400` both arrive here as 400 - and the store keys on
  // [operationId, status, key]. Baking both silently overwrote one and still
  // reported it generated: three generated, two stored.
  //
  // A range is skipped instead. Its concrete status is not knowable offline,
  // and a fixture stored at its bound is either unreachable (a request
  // resolving to 422 looks up 422 and misses) or standing on a real one.
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(rangeCollisionDoc),
    store,
    source: sourceReturning({ any: 'value' }),
    compiler: createCompiler(),
    now: () => 0
  })

  const records = store.records()
  assert.equal(records.length, 2, 'one fixture per concrete status')
  assert.deepEqual(records.map((record) => record.status), [200, 400])
  // The summary must agree with what is actually stored, or a silent
  // overwrite reads as success.
  assert.equal(summary.generated, records.length)
  assert.equal(summary.skipped, 1)
})

test('a source with no chunkSize still chunks by maxConcurrency', async () => {
  // The default path must not change: only a source that declares a size opts
  // out of it, and a third-party source that omits the field is unaffected.
  const source = recordingSource()

  await bake({
    api: loadApi(sixEntryDoc()),
    store: createMemoryFixtureStore(),
    source,
    compiler: createCompiler(),
    now: () => 0,
    budget: { maxConcurrency: 4 }
  })

  assert.deepEqual(source.sizes, [4, 2])
})

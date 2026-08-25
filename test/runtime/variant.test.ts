import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { targetKey } from '../../src/runtime/failure.ts'
import { variantKey, readVariant } from '../../src/runtime/variant.ts'

const api = loadApi({
  openapi: '3.1.0',
  info: { title: 'variants', version: '1' },
  paths: {
    '/upsert': {
      post: {
        operationId: 'upsert',
        responses: { '200': { description: 'ok' } }
      }
    }
  }
})

const operation = api.operations[0]!

test('variantKey namespaces the target key', () => {
  assert.equal(variantKey('post /upsert'), 'variant|post /upsert')
})

test('readVariant returns undefined when nothing is stored', async () => {
  const store = createMemoryStore()
  assert.equal(await readVariant(store, operation), undefined)
})

test('readVariant reads the key the surface writes', async () => {
  const store = createMemoryStore()
  await store.set(variantKey(targetKey(operation)), 'conflict')
  assert.equal(await readVariant(store, operation), 'conflict')
})

test('a non-string stored value reads as no variant', async () => {
  // The Store is advertised as shareable across processes, so another writer
  // putting a different shape here must not crash the request path.
  const store = createMemoryStore()
  await store.set(variantKey(targetKey(operation)), { name: 'conflict' })
  assert.equal(await readVariant(store, operation), undefined)
})

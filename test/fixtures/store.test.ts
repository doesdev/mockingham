import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'

test('a stored entry is readable by the same triple', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: { id: 42 } })
  assert.deepEqual(store.get('getUser', 200, 'a3f19c2e'), { value: { id: 42 } })
})

test('a different status is a different bucket', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: { id: 42 } })
  assert.equal(store.get('getUser', 404, 'a3f19c2e'), undefined)
})

test('a miss returns undefined rather than throwing', () => {
  const store = createMemoryFixtureStore()
  assert.equal(store.get('nope', 200, 'deadbeef'), undefined)
})

test('an entry without meta is accepted — hand-written fixtures have none', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: 1 })
  assert.equal(store.get('getUser', 200, 'a3f19c2e')?.meta, undefined)
})

test('records are returned in a stable order across stores', () => {
  const one = createMemoryFixtureStore()
  one.set('b', 200, 'k2', { value: 2 })
  one.set('a', 200, 'k1', { value: 1 })
  const two = createMemoryFixtureStore()
  two.set('a', 200, 'k1', { value: 1 })
  two.set('b', 200, 'k2', { value: 2 })
  assert.deepEqual(
    one.records().map((r) => `${r.operationId}|${r.status}|${r.key}`),
    two.records().map((r) => `${r.operationId}|${r.status}|${r.key}`)
  )
})

test('clear empties the store', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: 1 })
  store.clear()
  assert.equal(store.records().length, 0)
})

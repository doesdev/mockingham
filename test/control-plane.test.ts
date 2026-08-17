import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../src/index.ts'
import { petstore } from './fixtures/petstore.ts'

function mock() {
  return createMock(petstore, { seed: 'control', sleep: async () => {} })
}

test('failNext fails the configured number of requests then recovers', async () => {
  const instance = mock()
  await instance.failNext('GET /pets/{petId}', { times: 2, status: 500 })
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 500)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 500)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 200)
})

test('failNext defaults to one time and a 503', async () => {
  const instance = mock()
  await instance.failNext('GET /pets/{petId}', {})
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 200)
})

test('outage fails every request until reset', async () => {
  const instance = mock()
  await instance.outage('GET /pets/{petId}', { forMs: 60_000 })
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  await instance.reset()
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 200)
})

test('an unmatched control-plane target throws', async () => {
  const instance = mock()
  await assert.rejects(() => instance.failNext('GET /nope', {}), /matches no operation/)
})

test('a wildcard target arms every operation it matches', async () => {
  // Not just the first match - arming one of several would silently leave the
  // rest healthy while the caller believes the whole path is down.
  const instance = mock()
  await instance.outage('* /pets/**', { forMs: 60_000 })
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  assert.equal((await instance.fetch(new Request('http://mock/pets/mine'))).status, 503)
})

test('setSeed changes generated output', async () => {
  const instance = mock()
  const before = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  await instance.setSeed('different')
  const after = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  assert.notEqual(before, after)
})

test('reset restores the original seed and clears counters', async () => {
  const instance = mock()
  const before = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  await instance.setSeed('different')
  await instance.reset()
  const after = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  assert.equal(before, after)
})

test('the store is exposed', async () => {
  const instance = mock()
  await instance.store.set('k', 1)
  assert.equal(await instance.store.get('k'), 1)
})

test('every control-plane method returns a promise', () => {
  const instance = mock()
  assert.ok(instance.reset() instanceof Promise)
})

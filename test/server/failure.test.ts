import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

test('a rate of 1 turns every matching request into the configured status', async () => {
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', rate: 1, respond: 503 }],
    sleep: async () => {}
  }).fetch
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 503)
})

test('an unmatched operation is unaffected', async () => {
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', rate: 1, respond: 503 }],
    sleep: async () => {}
  }).fetch
  assert.equal((await handle(new Request('http://mock/pets'))).status, 200)
})

test('a failure status is emitted on contract when declared', async () => {
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', rate: 1, respond: 404 }],
    sleep: async () => {}
  }).fetch
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 404)
})

test('latency is applied through the injected sleep', async () => {
  const slept: number[] = []
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', latency: 300 }],
    sleep: async (ms) => { slept.push(ms) }
  }).fetch
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 200)
  assert.deepEqual(slept, [300])
})

test('a target matching no operation throws at construction', () => {
  assert.throws(
    () => createHandler(api, { failure: [{ match: 'GET /nope', rate: 1 }] }),
    /matches no operation/
  )
})

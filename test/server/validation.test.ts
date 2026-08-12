import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

test('a bad path param is a 400 with a flattened error list', async () => {
  const handle = createHandler(api, { seed: 'validate' })
  const response = await handle(new Request('http://mock/pets/abc'))
  assert.equal(response.status, 400)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_REQUEST_INVALID')
  assert.equal(body.error.errors[0].path, 'path.petId')
})

test('a valid request is unaffected', async () => {
  const handle = createHandler(api, { seed: 'validate' })
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 200)
})

test('validation can be turned off', async () => {
  const handle = createHandler(api, { seed: 'validate', validateRequests: false })
  assert.equal((await handle(new Request('http://mock/pets/abc'))).status, 200)
})

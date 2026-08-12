import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

test('extracts every operation', () => {
  const api = loadApi(petstore)
  assert.equal(api.version, '3.1.0')
  const ids = api.operations.map((op) => op.operationId).sort()
  assert.deepEqual(ids, ['createPet', 'listPets', 'myPet', 'showPetById'])
})

test('merges path-level parameters into each operation', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.ok(op)
  const petId = op.parameters.find((p) => p.name === 'petId')
  assert.ok(petId)
  assert.equal(petId.location, 'path')
  assert.equal(petId.required, true)
})

test('resolves refs inside response schemas', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  const schema = op?.responses[0]?.content['application/json']?.schema
  assert.equal(schema?.type, 'object')
  assert.equal(schema?.properties?.name?.type, 'string')
})

test('parses response status codes as numbers, in ascending order', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.deepEqual(op?.responses.map((r) => r.status), [200, 404])
})

test('throws when the document has no openapi version', () => {
  assert.throws(() => loadApi({ paths: {} }), /openapi/)
})

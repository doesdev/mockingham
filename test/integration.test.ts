import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../src/index.ts'
import { petstore } from './fixtures/petstore.ts'

test('in-process fetch needs no socket', async () => {
  const mock = createMock(petstore, { seed: 'integration' })
  const res = await mock.fetch(new Request('http://mock/pets/1'))
  assert.equal(res.status, 200)
})

test('the same request is byte-identical across separate instances', async () => {
  const a = createMock(petstore, { seed: 'stable' })
  const b = createMock(petstore, { seed: 'stable' })
  const left = await (await a.fetch(new Request('http://mock/pets/99'))).text()
  const right = await (await b.fetch(new Request('http://mock/pets/99'))).text()
  assert.equal(left, right)
})

test('a different root seed changes the output', async () => {
  const a = createMock(petstore, { seed: 'one' })
  const b = createMock(petstore, { seed: 'two' })
  const left = await (await a.fetch(new Request('http://mock/pets/99'))).text()
  const right = await (await b.fetch(new Request('http://mock/pets/99'))).text()
  assert.notEqual(left, right)
})

test('exposes the loaded api', () => {
  const mock = createMock(petstore)
  assert.equal(mock.api.operations.length, 4)
})

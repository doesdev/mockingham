import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../../src/spec/routes.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(method: Operation['method'], path: string, id: string): Operation {
  return { method, path, operationId: id, parameters: [], responses: [] }
}

test('matches a static path', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.equal(router.match('GET', '/pets')?.operation.operationId, 'listPets')
})

test('extracts path parameters', () => {
  const router = createRouter([op('get', '/pets/{petId}', 'showPet')])
  const found = router.match('GET', '/pets/42')
  assert.equal(found?.operation.operationId, 'showPet')
  assert.deepEqual(found?.params, { petId: '42' })
})

test('static segments beat dynamic ones at equal depth', () => {
  const router = createRouter([
    op('get', '/pets/{petId}', 'showPet'),
    op('get', '/pets/mine', 'myPet')
  ])
  assert.equal(router.match('GET', '/pets/mine')?.operation.operationId, 'myPet')
  assert.equal(router.match('GET', '/pets/9')?.operation.operationId, 'showPet')
})

test('is case-insensitive on method', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.ok(router.match('get', '/pets'))
})

test('percent-decodes path parameters', () => {
  const router = createRouter([op('get', '/pets/{name}', 'byName')])
  assert.deepEqual(router.match('GET', '/pets/a%20b')?.params, { name: 'a b' })
})

test('ignores a trailing slash', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.ok(router.match('GET', '/pets/'))
})

test('returns undefined for an unknown path', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.equal(router.match('GET', '/nope'), undefined)
})

test('reports allowed methods for a known path', () => {
  const router = createRouter([
    op('get', '/pets', 'listPets'),
    op('post', '/pets', 'createPet')
  ])
  assert.deepEqual(router.allowedMethods('/pets').sort(), ['GET', 'POST'])
  assert.deepEqual(router.allowedMethods('/nope'), [])
})

test('a malformed percent-escape is a non-match, not a crash', () => {
  const router = createRouter([op('get', '/pets/{name}', 'byName')])
  assert.equal(router.match('GET', '/pets/%'), undefined)
  assert.equal(router.match('GET', '/pets/%zz'), undefined)
  assert.deepEqual(router.allowedMethods('/pets/%'), [])
})

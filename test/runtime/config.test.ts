import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileConfigs, resolveConfigs } from '../../src/runtime/config.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(method: Operation['method'], path: string, id: string): Operation {
  return { method, path, operationId: id, parameters: [], responses: [], callbacks: [] }
}

const known = [op('get', '/pets/{petId}', 'showPet'), op('get', '/pets', 'listPets')]

test('an unmatched target throws at compile time', () => {
  assert.throws(
    () => compileConfigs({ 'GET /nope': { 200: { body: {} } } }, known),
    /matches no operation/
  )
})

test('no configuration compiles to an empty list', () => {
  assert.deepEqual(compileConfigs(undefined, known), [])
})

test('the last matching config wins for scalar settings', () => {
  const compiled = compileConfigs(
    { '* /pets/**': { status: 500 }, 'GET /pets/{petId}': { status: 404 } },
    known
  )
  assert.equal(resolveConfigs(known[0] as Operation, compiled).status, 404)
})

test('body overrides from every matching config are returned in order', () => {
  const compiled = compileConfigs(
    {
      '* /pets/**': { 200: { body: { a: 1 } } },
      'GET /pets/{petId}': { 200: { body: { b: 2 } } }
    },
    known
  )
  const bodies = resolveConfigs(known[0] as Operation, compiled).bodies(200)
  // Order matters: broad first so the specific one refines it.
  assert.deepEqual(bodies, [{ a: 1 }, { b: 2 }])
})

test('bodies for an unconfigured status are empty', () => {
  const compiled = compileConfigs({ 'GET /pets/{petId}': { 200: { body: {} } } }, known)
  assert.deepEqual(resolveConfigs(known[0] as Operation, compiled).bodies(404), [])
})

test('header overrides merge shallowly in declaration order', () => {
  const compiled = compileConfigs(
    {
      '* /pets/**': { 200: { headers: { 'x-a': '1', 'x-b': '1' } } },
      'GET /pets/{petId}': { 200: { headers: { 'x-b': '2' } } }
    },
    known
  )
  assert.deepEqual(resolveConfigs(known[0] as Operation, compiled).headers(200), {
    'x-a': '1',
    'x-b': '2'
  })
})

test('a config matching no operation in this request is ignored', () => {
  const compiled = compileConfigs({ 'GET /pets': { status: 201 } }, known)
  assert.equal(resolveConfigs(known[0] as Operation, compiled).status, undefined)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTarget, resolveTarget } from '../../src/resolve/target.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(method: Operation['method'], path: string, id: string): Operation {
  return { method, path, operationId: id, parameters: [], responses: [] }
}

const operations = [
  op('get', '/users/{id}', 'getUserById'),
  op('post', '/users', 'createUser'),
  op('get', '/orders/{id}/items', 'listOrderItems'),
  op('delete', '/orders/{id}', 'deleteOrder')
]

test('matches a method and exact path template', () => {
  const matcher = compileTarget('GET /users/{id}')
  assert.equal(matcher.matches(operations[0] as Operation), true)
  assert.equal(matcher.matches(operations[1] as Operation), false)
})

test('is case-insensitive on method', () => {
  assert.equal(compileTarget('get /users/{id}').matches(operations[0] as Operation), true)
})

test('a bare operationId matches by id', () => {
  const matcher = compileTarget('createUser')
  assert.equal(matcher.matches(operations[1] as Operation), true)
  assert.equal(matcher.matches(operations[0] as Operation), false)
})

test('a method wildcard matches any method at that path', () => {
  const matcher = compileTarget('* /users/{id}')
  assert.equal(matcher.matches(operations[0] as Operation), true)
  assert.equal(matcher.matches(op('put', '/users/{id}', 'putUser')), true)
  assert.equal(matcher.matches(operations[1] as Operation), false)
})

test('a single star matches exactly one segment', () => {
  const matcher = compileTarget('GET /orders/*')
  // /orders/{id}/items has two segments after /orders, so it must not match
  assert.equal(matcher.matches(operations[2] as Operation), false)
  assert.equal(matcher.matches(op('get', '/orders/{id}', 'getOrder')), true)
})

test('a double star matches the remaining segments', () => {
  const matcher = compileTarget('GET /orders/**')
  assert.equal(matcher.matches(operations[2] as Operation), true)
  assert.equal(matcher.matches(op('get', '/orders/{id}', 'getOrder')), true)
})

test('a double star also matches zero remaining segments', () => {
  assert.equal(compileTarget('GET /orders/**').matches(op('get', '/orders', 'listOrders')), true)
})

test('resolveTarget returns every matching operation', () => {
  const found = resolveTarget('* /users/{id}', operations)
  assert.deepEqual(found.map((o) => o.operationId), ['getUserById'])
})

test('resolveTarget throws when nothing matches, naming the target', () => {
  assert.throws(() => resolveTarget('GET /nope', operations), /GET \/nope/)
})

test('a path with no method is rejected with a usable message', () => {
  assert.throws(() => compileTarget('/users/{id}'), /has no method/)
})

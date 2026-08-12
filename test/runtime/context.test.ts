import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext, createCounters } from '../../src/runtime/context.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Operation } from '../../src/spec/types.ts'

const operation: Operation = {
  method: 'get', path: '/things/{id}', parameters: [], responses: []
}

function build(url: string, init?: RequestInit) {
  const request = new Request(url, init)
  return createContext({
    request,
    url: new URL(url),
    operation,
    params: { id: '7' },
    body: undefined,
    rng: createRng('ctx'),
    requestKey: 'key',
    requestId: 'test-id',
    counters: createCounters(),
    generate: () => ({ generated: true }),
    example: () => ({ example: true })
  })
}

test('counters start at one and increment per name', () => {
  const counters = createCounters()
  assert.equal(counters.next('order'), 1)
  assert.equal(counters.next('order'), 2)
  assert.equal(counters.next('user'), 1)
})

test('reset returns every counter to the start', () => {
  const counters = createCounters()
  counters.next('order')
  counters.reset()
  assert.equal(counters.next('order'), 1)
})

test('seq is synchronous and returns a number', () => {
  const ctx = build('http://mock/things/7')
  const first = ctx.seq('order')
  assert.equal(typeof first, 'number')
  assert.equal(ctx.seq('order'), first + 1)
})

test('exposes path params', () => {
  assert.deepEqual(build('http://mock/things/7').params, { id: '7' })
})

test('collects query parameters', () => {
  const ctx = build('http://mock/things/7?limit=5&sort=name')
  assert.deepEqual(ctx.query, { limit: '5', sort: 'name' })
})

test('a repeated query key becomes an array in order of appearance', () => {
  const ctx = build('http://mock/things/7?tag=a&tag=b&tag=c')
  assert.deepEqual(ctx.query, { tag: ['a', 'b', 'c'] })
})

test('header names are lowercased', () => {
  const ctx = build('http://mock/things/7', {
    headers: { 'X-Trace-Id': 'abc' }
  })
  assert.equal(ctx.headers['x-trace-id'], 'abc')
})

test('respond builds a JSON response', async () => {
  const ctx = build('http://mock/things/7')
  const response = await ctx.respond(201, { ok: true }, { 'x-custom': 'y' })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-custom'), 'y')
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { ok: true })
})

test('respond with no body sends no content type', async () => {
  const response = await build('http://mock/things/7').respond(204)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('content-type'), null)
})

test('log starts as an empty object callbacks can add to', () => {
  const ctx = build('http://mock/things/7')
  assert.deepEqual(ctx.log, {})
  ctx.log['tenant'] = 'acme'
  assert.deepEqual(ctx.log, { tenant: 'acme' })
})

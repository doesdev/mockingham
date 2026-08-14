import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBody, pickMedia } from '../../src/runtime/body.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    method: 'post', path: '/things', tags: [], parameters: [], responses: [], callbacks: [], ...overrides
  }
}

function post(body: string, contentType?: string): Request {
  const headers: Record<string, string> = {}
  if (contentType) headers['content-type'] = contentType
  return new Request('http://mock/things', { method: 'POST', body, headers })
}

test('parses a JSON body', async () => {
  const result = await parseBody(post('{"a":1}', 'application/json'), op())
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.body.value, { a: 1 })
})

test('honors a charset parameter on the content type', async () => {
  const result = await parseBody(
    post('{"a":1}', 'application/json; charset=utf-8'), op()
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.body.value, { a: 1 })
})

test('a malformed JSON body is a 400', async () => {
  const result = await parseBody(post('{not json', 'application/json'), op())
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 400)
    assert.equal(result.code, 'MOCK_BODY_MALFORMED')
  }
})

test('parses a form-urlencoded body', async () => {
  const result = await parseBody(
    post('a=1&b=two', 'application/x-www-form-urlencoded'), op()
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.body.value, { a: '1', b: 'two' })
})

test('parses a text body as a string', async () => {
  const result = await parseBody(post('hello', 'text/plain'), op())
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body.value, 'hello')
})

test('an unrecognized content type is exposed as raw bytes', async () => {
  const result = await parseBody(post('\x00\x01binary', 'application/octet-stream'), op())
  assert.equal(result.ok, true)
  if (result.ok) assert.ok(result.body.value instanceof Uint8Array)
})

test('an empty body yields undefined', async () => {
  const request = new Request('http://mock/things', { method: 'POST' })
  const result = await parseBody(request, op())
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body.value, undefined)
})

test('a content type the operation does not declare is a 415', async () => {
  const operation = op({
    requestBody: { 'application/json': { schema: { type: 'object' } } }
  })
  const result = await parseBody(post('x=1', 'application/x-www-form-urlencoded'), operation)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 415)
    assert.match(result.message, /application\/json/)
  }
})

test('an operation declaring no request body accepts anything', async () => {
  const result = await parseBody(post('x=1', 'application/x-www-form-urlencoded'), op())
  assert.equal(result.ok, true)
})

test('an empty body is not a 415 even when the type is undeclared', async () => {
  const operation = op({
    requestBody: { 'application/json': { schema: { type: 'object' } } }
  })
  const request = new Request('http://mock/things', {
    method: 'POST', headers: { 'content-type': 'application/xml' }
  })
  const result = await parseBody(request, operation)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body.value, undefined)
})

test('an empty body with a JSON content type is not a parse error', async () => {
  const request = new Request('http://mock/things', {
    method: 'POST', headers: { 'content-type': 'application/json' }
  })
  const result = await parseBody(request, op())
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body.value, undefined)
})

test('pickMedia matches an exact media type', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/json'))
})

test('pickMedia matches a +json suffix against a JSON entry', () => {
  // body.ts already PARSES application/vnd.api+json as JSON, so validation must
  // match it too, or a parsed body is silently never validated.
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/vnd.api+json'))
})

test('pickMedia matches a declared suffix type exactly', () => {
  const content = { 'application/vnd.api+json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/vnd.api+json'))
})

test('pickMedia ignores parameters on the media type', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/json; charset=utf-8'))
})

test('pickMedia returns undefined for an unrelated type', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.equal(pickMedia(content, 'text/plain'), undefined)
})

test('pickMedia falls back to the JSON entry when no type is given', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, undefined))
})

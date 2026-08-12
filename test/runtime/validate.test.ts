import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerce, validateRequest } from '../../src/runtime/validate.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { Operation } from '../../src/spec/types.ts'

function ctx(partial: Partial<Ctx>): Ctx {
  return {
    params: {}, query: {}, headers: {}, body: undefined, ...partial
  } as Ctx
}

function op(parameters: Operation['parameters'], requestBody?: Operation['requestBody']): Operation {
  return { method: 'post', path: '/x', parameters, responses: [], requestBody, callbacks: [] }
}

test('coerce turns numeric strings into numbers', () => {
  assert.equal(coerce('42', { type: 'integer' }), 42)
  assert.equal(coerce('4.5', { type: 'number' }), 4.5)
})

test('coerce leaves a non-numeric string alone so validation can report it', () => {
  assert.equal(coerce('abc', { type: 'integer' }), 'abc')
})

test('coerce handles booleans', () => {
  assert.equal(coerce('true', { type: 'boolean' }), true)
  assert.equal(coerce('false', { type: 'boolean' }), false)
  assert.equal(coerce('yes', { type: 'boolean' }), 'yes')
})

test('coerce leaves strings as strings', () => {
  assert.equal(coerce('42', { type: 'string' }), '42')
})

test('a valid request passes', () => {
  const operation = op([
    { name: 'petId', location: 'path', required: true, schema: { type: 'integer' } }
  ])
  assert.deepEqual(
    validateRequest(ctx({ params: { petId: '7' } }), operation),
    { ok: true }
  )
})

test('a path param of the wrong type is reported with a path', () => {
  const operation = op([
    { name: 'petId', location: 'path', required: true, schema: { type: 'integer' } }
  ])
  const result = validateRequest(ctx({ params: { petId: 'abc' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errors[0]?.path, 'path.petId')
    assert.ok(result.errors[0]?.message.length > 0)
  }
})

test('a missing required query param is reported', () => {
  const operation = op([
    { name: 'limit', location: 'query', required: true, schema: { type: 'integer' } }
  ])
  const result = validateRequest(ctx({}), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'query.limit')
})

test('a missing optional query param is fine', () => {
  const operation = op([
    { name: 'limit', location: 'query', required: false, schema: { type: 'integer' } }
  ])
  assert.deepEqual(validateRequest(ctx({}), operation), { ok: true })
})

test('headers are validated case-insensitively', () => {
  const operation = op([
    { name: 'X-Count', location: 'header', required: true, schema: { type: 'integer' } }
  ])
  assert.deepEqual(
    validateRequest(ctx({ headers: { 'x-count': '3' } }), operation),
    { ok: true }
  )
})

test('a body failing its schema is reported under body', () => {
  const operation = op([], {
    'application/json': {
      schema: { type: 'object', required: ['age'], properties: { age: { type: 'integer' } } }
    }
  })
  const result = validateRequest(ctx({ body: { age: 'old' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'body.age')
})

test('every failure is reported, not just the first', () => {
  const operation = op([
    { name: 'a', location: 'query', required: true, schema: { type: 'integer' } },
    { name: 'b', location: 'query', required: true, schema: { type: 'integer' } }
  ])
  const result = validateRequest(ctx({ query: { a: 'x', b: 'y' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors.length, 2)
})

test('raw bytes are skipped rather than guessed at', () => {
  const operation = op([], {
    'application/json': { schema: { type: 'object', required: ['a'], properties: {} } }
  })
  assert.deepEqual(
    validateRequest(ctx({ body: new Uint8Array([1, 2]) }), operation),
    { ok: true }
  )
})

test('an operation declaring no request body accepts any body', () => {
  assert.deepEqual(validateRequest(ctx({ body: { any: true } }), op([])), { ok: true })
})

test('coerces each entry of an array parameter against its item schema', () => {
  const operation = op([
    { name: 'ids', location: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } }
  ])
  assert.deepEqual(validateRequest(ctx({ query: { ids: ['1', '2'] } }), operation), { ok: true })
})

test('a single occurrence of an array parameter is accepted', () => {
  const operation = op([
    { name: 'tags', location: 'query', required: true, schema: { type: 'array', items: { type: 'string' } } }
  ])
  assert.deepEqual(validateRequest(ctx({ query: { tags: 'a' } }), operation), { ok: true })
})

test('an array parameter entry of the wrong type is still reported', () => {
  const operation = op([
    { name: 'ids', location: 'query', required: true, schema: { type: 'array', items: { type: 'integer' } } }
  ])
  const result = validateRequest(ctx({ query: { ids: ['1', 'abc'] } }), operation)
  assert.equal(result.ok, false)
})

test('a required cookie parameter present in the cookie header validates', () => {
  const operation = op([
    { name: 'session', location: 'cookie', required: true, schema: { type: 'string' } }
  ])
  assert.deepEqual(
    validateRequest(ctx({ headers: { cookie: 'other=1; session=abc123' } }), operation),
    { ok: true }
  )
})

test('a missing required cookie parameter is still reported', () => {
  const operation = op([
    { name: 'session', location: 'cookie', required: true, schema: { type: 'string' } }
  ])
  const result = validateRequest(ctx({ headers: { cookie: 'other=1' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'cookie.session')
})

test('a cookie parameter is coerced like any other wire value', () => {
  const operation = op([
    { name: 'count', location: 'cookie', required: true, schema: { type: 'integer' } }
  ])
  assert.deepEqual(
    validateRequest(ctx({ headers: { cookie: 'count=7' } }), operation),
    { ok: true }
  )
})

test('a missing required body is reported', () => {
  const operation = op([], {
    'application/json': { schema: { type: 'object' } }
  })
  operation.requestBodyRequired = true
  const result = validateRequest(ctx({ body: undefined }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'body')
})

test('a missing optional body is fine', () => {
  const operation = op([], { 'application/json': { schema: { type: 'object' } } })
  assert.deepEqual(validateRequest(ctx({ body: undefined }), operation), { ok: true })
})

test('a suffix JSON body is validated', () => {
  const operation = op([], {
    'application/json': {
      schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }
    }
  })
  const result = validateRequest(
    ctx({ body: { a: 1 }, mediaType: 'application/vnd.api+json' }), operation
  )
  assert.equal(result.ok, false)
})

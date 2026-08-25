import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preferred, responseForStatus, selectResponse } from '../../src/runtime/select.ts'
import type { Operation, ResponseSpec } from '../../src/spec/types.ts'

function res(status: number): ResponseSpec {
  return { status, headers: {}, content: {} }
}

function op(responses: ResponseSpec[], defaultResponse?: ResponseSpec): Operation {
  return {
    method: 'get', path: '/x', tags: [], parameters: [], responses, defaultResponse, callbacks: []
  }
}

function req(prefer?: string): Request {
  return new Request('http://mock/x', prefer ? { headers: { prefer } } : undefined)
}

test('preferred reads a status directive', () => {
  assert.equal(preferred(req('status=201'), 'status'), '201')
  assert.equal(preferred(req('example=empty'), 'example'), 'empty')
  assert.equal(preferred(req(), 'status'), undefined)
})

test('preferred reads one directive from several', () => {
  assert.equal(preferred(req('status=201, example=empty'), 'example'), 'empty')
})

test('the lowest declared 2xx is the default choice', () => {
  const found = selectResponse(op([res(404), res(200), res(201)]), req(), undefined)
  assert.equal(found?.spec.status, 200)
  assert.equal(found?.source, 'default')
})

test('Prefer beats the default', () => {
  const found = selectResponse(op([res(200), res(404)]), req('status=404'), undefined)
  assert.equal(found?.spec.status, 404)
  assert.equal(found?.source, 'prefer')
})

test('a configured status beats the default but loses to Prefer', () => {
  const responses = [res(200), res(404), res(500)]
  assert.equal(selectResponse(op(responses), req(), 500)?.spec.status, 500)
  assert.equal(selectResponse(op(responses), req(), 500)?.source, 'config')
  assert.equal(selectResponse(op(responses), req('status=404'), 500)?.spec.status, 404)
})

test('an undeclared Prefer status falls through rather than 404ing the mock', () => {
  const found = selectResponse(op([res(200)]), req('status=418'), undefined)
  assert.equal(found?.spec.status, 200)
  assert.equal(found?.source, 'default')
})

test('with no 2xx the first declared response is used', () => {
  assert.equal(selectResponse(op([res(404), res(500)]), req(), undefined)?.spec.status, 404)
})

test('an operation declaring only default is served as 200', () => {
  // `default` carries a schema but no status of its own, so the mock has to
  // choose one. Previously this returned 501 MOCK_NO_RESPONSE.
  const found = selectResponse(op([], res(0)), req(), undefined)
  assert.equal(found?.spec.status, 200)
})

test('an operation declaring nothing at all selects nothing', () => {
  assert.equal(selectResponse(op([]), req(), undefined), undefined)
})

test('responseForStatus prefers a declared response', () => {
  assert.equal(responseForStatus(op([res(200), res(401)]), 401)?.status, 401)
})

test('responseForStatus falls back to default, restamped with the status', () => {
  const found = responseForStatus(op([res(200)], res(0)), 401)
  assert.equal(found?.status, 401)
})

test('responseForStatus returns undefined when neither exists', () => {
  assert.equal(responseForStatus(op([res(200)]), 401), undefined)
})

/** A range response - `status` is the bucket's lower bound, per load.ts. */
function range(bound: number): ResponseSpec {
  return { status: bound, range: true, headers: {}, content: {} }
}

test('an exact declared status beats a range containing it', () => {
  const operation = op([res(400), range(400)])
  const exact = responseForStatus(operation, 400)
  assert.equal(exact?.range, undefined)
  // ...and the range still serves the rest of its own bucket.
  assert.equal(responseForStatus(operation, 401)?.range, true)
})

test('a range beats default, and default still serves outside every range', () => {
  const operation = op([range(400)], res(0))
  assert.equal(responseForStatus(operation, 404)?.range, true)
  // 503 is outside the 4XX bucket, so `default` takes it, restamped.
  const fallback = responseForStatus(operation, 503)
  assert.equal(fallback?.range, undefined)
  assert.equal(fallback?.status, 503)
})

test('a range serves the requested status, not its bound', () => {
  // A 422 served from a 4XX contract is a 422 on the wire.
  assert.equal(responseForStatus(op([range(400)]), 422)?.status, 422)
})

test('a range is never selected carrying its bound as a wire status', () => {
  // Shipped behavior was status 4, which new Response rejects outright.
  assert.equal(selectResponse(op([range(400)]), req(), undefined)?.spec.status, 400)
  assert.equal(selectResponse(op([range(500)]), req(), undefined)?.spec.status, 500)
})

test('a 2XX range is a success declaration and is stamped 200', () => {
  assert.equal(selectResponse(op([range(200)]), req(), undefined)?.spec.status, 200)
})

test('a 1XX range is never selected, because no status below 200 is servable', () => {
  // Degrades to nothing selectable rather than throwing at `new Response`.
  assert.equal(selectResponse(op([range(100)]), req(), undefined), undefined)
})

test('a 1XX range does not shadow a servable response', () => {
  assert.equal(selectResponse(op([range(100), res(200)]), req(), undefined)?.spec.status, 200)
})

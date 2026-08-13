import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupported, resolveExpression } from '../../src/webhooks/expr.ts'
import type { ExprInput } from '../../src/webhooks/expr.ts'

function inputFor(overrides: Partial<ExprInput> = {}): ExprInput {
  const request = new Request('http://mock/subs?tenant=acme', {
    method: 'POST',
    headers: { 'x-cb': 'http://hooks.test/x' }
  })
  return {
    request,
    url: new URL(request.url),
    method: 'POST',
    params: { id: '42' },
    body: { callbackUrl: 'http://hooks.test/orders', nested: { deep: 'yes' }, n: 7 },
    ...overrides
  }
}

test('resolves a whole-expression template', () => {
  const out = resolveExpression('{$request.body#/callbackUrl}', inputFor())
  assert.deepEqual(out, { ok: true, value: 'http://hooks.test/orders' })
})

test('resolves a mixed template of literal text and expressions', () => {
  // A document may write a base from the body and a fixed path after it.
  const out = resolveExpression('{$request.body#/callbackUrl}/ack/{$request.path.id}', inputFor())
  assert.deepEqual(out, { ok: true, value: 'http://hooks.test/orders/ack/42' })
})

test('resolves headers case-insensitively, query, path, url, and method', () => {
  const input = inputFor()
  const headerResult = resolveExpression('{$request.header.X-CB}', input)
  assert.equal(headerResult.ok && headerResult.value, 'http://hooks.test/x')
  assert.deepEqual(resolveExpression('{$request.query.tenant}', input), { ok: true, value: 'acme' })
  assert.deepEqual(resolveExpression('{$request.path.id}', input), { ok: true, value: '42' })
  assert.deepEqual(resolveExpression('{$method}', input), { ok: true, value: 'POST' })
  assert.deepEqual(resolveExpression('{$url}', input), { ok: true, value: 'http://mock/subs?tenant=acme' })
})

test('resolves a nested json pointer and coerces a number', () => {
  assert.deepEqual(
    resolveExpression('{$request.body#/nested/deep}', inputFor()),
    { ok: true, value: 'yes' }
  )
  assert.deepEqual(resolveExpression('{$request.body#/n}', inputFor()), { ok: true, value: '7' })
})

test('decodes json pointer escapes', () => {
  const input = inputFor({ body: { 'a/b': 'slash', 'c~d': 'tilde' } })
  assert.deepEqual(resolveExpression('{$request.body#/a~1b}', input), { ok: true, value: 'slash' })
  assert.deepEqual(resolveExpression('{$request.body#/c~0d}', input), { ok: true, value: 'tilde' })
})

test('resolves $response.* and $statusCode when a result is present', () => {
  const input = inputFor({
    result: { status: 201, headers: { location: '/orders/9' }, body: { id: 'o_1' } }
  })
  assert.deepEqual(resolveExpression('{$statusCode}', input), { ok: true, value: '201' })
  assert.deepEqual(resolveExpression('{$response.header.location}', input), { ok: true, value: '/orders/9' })
  assert.deepEqual(resolveExpression('{$response.body#/id}', input), { ok: true, value: 'o_1' })
})

test('a $response expression with no result fails rather than resolving empty', () => {
  // Capture happens at request time for some callers; silently producing '' would
  // hand delivery a malformed URL instead of falling through to the next tier.
  const out = resolveExpression('{$response.body#/id}', inputFor())
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.reason, '$response.body#/id')
})

test('a missing pointer target fails with the offending token as the reason', () => {
  const out = resolveExpression('{$request.body#/nope}', inputFor())
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.reason, '$request.body#/nope')
})

test('a non-scalar pointer target fails rather than stringifying an object', () => {
  const out = resolveExpression('{$request.body#/nested}', inputFor())
  assert.equal(out.ok, false)
})

test('isSupported accepts the documented subset', () => {
  for (const expression of [
    '{$url}', '{$method}', '{$statusCode}',
    '{$request.header.x}', '{$request.query.x}', '{$request.path.x}',
    '{$request.body}', '{$request.body#/a/b}',
    '{$response.header.x}', '{$response.body#/a}',
    'http://fixed.test/hook'
  ]) {
    assert.equal(isSupported(expression), true, expression)
  }
})

test('isSupported rejects anything outside it', () => {
  for (const expression of [
    '{$request.cookie.x}', '{$response.query.x}', '{$response.path.x}',
    '{$nonsense}', '{$request.}', '{$request.header.}'
  ]) {
    assert.equal(isSupported(expression), false, expression)
  }
})

test('isSupported is about form, not resolvability', () => {
  // A well-formed expression that happens to point at nothing is still
  // supported; it fails at resolution, which is a different tier of the
  // destination fallback.
  assert.equal(isSupported('{$request.body#/absent}'), true)
})

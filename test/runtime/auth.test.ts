import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAuth, credentialFor } from '../../src/runtime/auth.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { SecurityScheme } from '../../src/spec/types.ts'

function ctx(partial: Partial<Ctx> = {}): Ctx {
  return { headers: {}, query: {}, params: {}, ...partial } as Ctx
}

const bearer: SecurityScheme = { type: 'http', scheme: 'bearer' }
const apiKey: SecurityScheme = { type: 'apiKey', location: 'header', name: 'x-api-key' }

test('extracts a bearer token', () => {
  assert.equal(
    credentialFor(bearer, ctx({ headers: { authorization: 'Bearer abc' } })),
    'abc'
  )
})

test('bearer extraction is case-insensitive on the scheme word', () => {
  assert.equal(
    credentialFor(bearer, ctx({ headers: { authorization: 'bearer abc' } })),
    'abc'
  )
})

test('a missing or malformed authorization header yields no credential', () => {
  assert.equal(credentialFor(bearer, ctx()), undefined)
  assert.equal(
    credentialFor(bearer, ctx({ headers: { authorization: 'Basic abc' } })),
    undefined
  )
})

test('extracts an apiKey from a header, a query param, and a cookie', () => {
  assert.equal(credentialFor(apiKey, ctx({ headers: { 'x-api-key': 'k' } })), 'k')
  assert.equal(
    credentialFor(
      { type: 'apiKey', location: 'query', name: 'key' },
      ctx({ query: { key: 'k' } })
    ),
    'k'
  )
  assert.equal(
    credentialFor(
      { type: 'apiKey', location: 'cookie', name: 'sid' },
      ctx({ headers: { cookie: 'a=1; sid=k' } })
    ),
    'k'
  )
})

const schemes = { bearerAuth: bearer, apiKey }

test('no requirements means no auth', async () => {
  const outcome = await checkAuth({
    security: undefined, schemes, config: {}, ctx: ctx()
  })
  assert.equal(outcome.ok, true)
})

test('an empty requirement list means auth is explicitly not required', async () => {
  const outcome = await checkAuth({ security: [], schemes, config: {}, ctx: ctx() })
  assert.equal(outcome.ok, true)
})

test('a missing credential is a 401', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }], schemes, config: {}, ctx: ctx()
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 401)
})

test('a present credential passes a presence-only check', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: {},
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
})

test('requirements are OR across the array', async () => {
  // bearerAuth is absent, apiKey is present - one satisfied object is enough.
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }, { apiKey: [] }],
    schemes,
    config: {},
    ctx: ctx({ headers: { 'x-api-key': 'k' } })
  })
  assert.equal(outcome.ok, true)
})

test('requirements are AND within one object', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [], apiKey: [] }],
    schemes,
    config: {},
    ctx: ctx({ headers: { 'x-api-key': 'k' } })
  })
  assert.equal(outcome.ok, false)
})

test('verify returning a principal succeeds and the principal is returned', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: { bearerAuth: { verify: () => ({ sub: 'u_1' }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.principal?.sub, 'u_1')
})

test('verify may be async', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: { bearerAuth: { verify: async () => ({ sub: 'u_2' }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.principal?.sub, 'u_2')
})

test('verify returning a Response denies with it', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: { bearerAuth: { verify: () => new Response(null, { status: 401 }) } },
    ctx: ctx({ headers: { authorization: 'Bearer expired' } })
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.ok(outcome.response)
})

test('unmet scopes are a 403, not a 401', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: ['orders:write'] }],
    schemes,
    config: { bearerAuth: { verify: () => ({ scopes: ['orders:read'] }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 403)
})

test('met scopes pass', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: ['orders:read'] }],
    schemes,
    config: { bearerAuth: { verify: () => ({ scopes: ['orders:read', 'x'] }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
})

test('a requirement naming an undeclared scheme fails closed', async () => {
  const outcome = await checkAuth({
    security: [{ ghost: [] }], schemes, config: {}, ctx: ctx()
  })
  assert.equal(outcome.ok, false)
})

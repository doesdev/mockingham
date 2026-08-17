import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNATURE_HEADER, sign } from '../../src/webhooks/sign.ts'

// A KNOWN-ANSWER VECTOR, computed independently with WebCrypto. A test that
// only asserts a signature header exists passes against any hash, including a
// wrong one - which is the whole failure mode this vector rules out. The signed
// string is `${timestamp}.${body}`, here `1700000000.{"id":"o_1"}`.
const SECRET = 'topsecret'
const BODY = '{"id":"o_1"}'
const TIMESTAMP = 1_700_000_000
const EXPECTED = 'd59acd89488c9c1f46acbddca01afef5b53dcff2e5277aa939c3461939be60cc'

test('sign matches the known-answer vector', async () => {
  const signature = await sign(SECRET, BODY, TIMESTAMP)
  assert.equal(signature.hex, EXPECTED)
})

test('the header carries the timestamp and the v1 signature', async () => {
  const signature = await sign(SECRET, BODY, TIMESTAMP)
  assert.equal(signature.header, `t=${TIMESTAMP},v1=${EXPECTED}`)
  assert.equal(signature.timestamp, TIMESTAMP)
})

test('SIGNATURE_HEADER is the documented name', () => {
  assert.equal(SIGNATURE_HEADER, 'x-mockingham-signature')
})

test('the timestamp is part of what is signed', async () => {
  // Otherwise a captured signature could be replayed against a new timestamp.
  const other = await sign(SECRET, BODY, TIMESTAMP + 1)
  assert.notEqual(other.hex, EXPECTED)
})

test('a different secret produces a different signature', async () => {
  const other = await sign('other', BODY, TIMESTAMP)
  assert.notEqual(other.hex, EXPECTED)
})

test('a different body produces a different signature', async () => {
  const other = await sign(SECRET, '{"id":"o_2"}', TIMESTAMP)
  assert.notEqual(other.hex, EXPECTED)
})

test('the hex is 64 lowercase characters', async () => {
  const signature = await sign(SECRET, BODY, TIMESTAMP)
  assert.match(signature.hex, /^[0-9a-f]{64}$/)
})

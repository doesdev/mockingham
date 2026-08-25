import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createRecordedSource } from '../../../src/fixtures/sources/recorded.ts'
import type { FixtureRequest } from '../../../src/fixtures/source.ts'

function request(key: string, status = 200): FixtureRequest {
  return {
    operationId: 'getUser', method: 'get', path: '/users/{id}', status,
    key, params: {}, jsonSchema: { type: 'object' },
    zodSchema: z.object({ bio: z.string() })
  }
}

test('an entry matching operation and status is returned', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 200, value: { bio: 'recorded' } }
  ])
  const [result] = await source.generate([request('k')])
  assert.deepEqual(result?.value, { bio: 'recorded' })
  assert.equal(result?.meta?.source, 'recorded')
})

test('a key-specific entry beats a general one', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 200, value: { bio: 'general' } },
    { operationId: 'getUser', status: 200, key: 'k', value: { bio: 'specific' } }
  ])
  const [result] = await source.generate([request('k')])
  assert.deepEqual(result?.value, { bio: 'specific' })
})

test('no matching entry is a miss', async () => {
  const source = createRecordedSource([
    { operationId: 'other', status: 200, value: { bio: 'nope' } }
  ])
  assert.equal((await source.generate([request('k')]))[0], null)
})

test('a recorded value failing the schema is a miss', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 200, value: { bio: 42 } }
  ])
  assert.equal((await source.generate([request('k')]))[0], null)
})

// The brief's four tests above are necessary but not sufficient: the
// precedence test has both a general AND a specific entry present, which is
// good, but the remaining properties called out in the task (status
// discrimination, positional alignment across a miss, a wrong-key entry not
// masking a general fallback, and "miss not throw") have no coverage above.
// Each test below is written to fail if the behavior it names were removed.

test('an entry for a different status does not match', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 404, value: { bio: 'not found' } }
  ])
  // Same operationId, different status: without the status comparison this
  // entry would wrongly satisfy a 200 request.
  assert.equal((await source.generate([request('k', 200)]))[0], null)
})

test('an entry recorded for a different key does not shadow the general entry', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 200, key: 'other-key', value: { bio: 'wrong pin' } },
    { operationId: 'getUser', status: 200, value: { bio: 'general' } }
  ])
  // request('k') matches neither the specific entry pinned to 'other-key' nor
  // is itself unkeyed, so it must fall through to the general entry rather
  // than missing or picking up the other request's pinned recording.
  const [result] = await source.generate([request('k')])
  assert.deepEqual(result?.value, { bio: 'general' })
})

test('results stay positionally aligned when an earlier request misses and a later one matches', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 200, key: 'b', value: { bio: 'second' } }
  ])
  const results = await source.generate([request('a'), request('b')])
  // If the miss for 'a' were dropped instead of kept as a positional null,
  // the 'second' value would shift into index 0 and this would pass by
  // accident. Asserting both positions rules that out.
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('an invalid recording resolves as a miss rather than rejecting', async () => {
  const source = createRecordedSource([
    { operationId: 'getUser', status: 200, value: { bio: 42 } }
  ])
  // Distinguishes "caught and turned into a miss" from "would have thrown
  // past generate() had the miss path used request.zodSchema.parse instead
  // of safeParse" - invariant 4 requires the source never throw.
  await assert.doesNotReject(() => source.generate([request('k')]))
})

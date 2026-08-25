import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../../src/runtime/store.ts'

function clock(start = 0) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

test('get returns undefined for an unset key', async () => {
  assert.equal(await createMemoryStore().get('nope'), undefined)
})

test('set then get round-trips a value', async () => {
  const store = createMemoryStore()
  await store.set('a', { n: 1 })
  assert.deepEqual(await store.get('a'), { n: 1 })
})

test('set overwrites', async () => {
  const store = createMemoryStore()
  await store.set('a', 1)
  await store.set('a', 2)
  assert.equal(await store.get('a'), 2)
})

test('delete removes a key', async () => {
  const store = createMemoryStore()
  await store.set('a', 1)
  await store.delete('a')
  assert.equal(await store.get('a'), undefined)
})

test('incr starts at the increment and accumulates', async () => {
  const store = createMemoryStore()
  assert.equal(await store.incr('n'), 1)
  assert.equal(await store.incr('n'), 2)
  assert.equal(await store.incr('n', 5), 7)
})

test('incr on a non-numeric value restarts from the increment', async () => {
  const store = createMemoryStore()
  await store.set('n', 'not a number')
  assert.equal(await store.incr('n'), 1)
})

test('a value expires once its ttl elapses', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1, 1000)
  time.advance(999)
  assert.equal(await store.get('a'), 1)
  time.advance(2)
  assert.equal(await store.get('a'), undefined)
})

test('a value without a ttl never expires', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1)
  time.advance(1_000_000)
  assert.equal(await store.get('a'), 1)
})

test('setting a key again resets its ttl', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1, 1000)
  time.advance(900)
  await store.set('a', 2, 1000)
  time.advance(900)
  assert.equal(await store.get('a'), 2)
})

test('incr respects expiry', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('n', 5, 1000)
  time.advance(1001)
  assert.equal(await store.incr('n'), 1)
})

test('clear empties the store', async () => {
  const store = createMemoryStore()
  await store.set('a', 1)
  await store.clear()
  assert.equal(await store.get('a'), undefined)
})

test('an entry read at exactly its deadline is still alive', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1, 1000)
  time.advance(1000)
  assert.equal(await store.get('a'), 1)
  time.advance(1)
  assert.equal(await store.get('a'), undefined)
})

test('incr preserves the deadline of a live entry', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('n', 1, 1000)
  time.advance(500)
  await store.incr('n')
  time.advance(501)
  // Still expires on the ORIGINAL deadline; incr did not extend it.
  assert.equal(await store.get('n'), undefined)
})

test('setIfAbsent creates once and reports which call won', async () => {
  const store = createMemoryStore(() => 0)
  assert.equal(await store.setIfAbsent('k', 'first'), true)
  assert.equal(await store.setIfAbsent('k', 'second'), false)
  // The loser must not overwrite: a compare-and-set that clobbers is not one.
  assert.equal(await store.get('k'), 'first')
})

test('setIfAbsent treats an expired entry as absent', async () => {
  // Expiry is lazy, so this must go through the same liveness check `get`
  // uses rather than a bare `has` - otherwise a dead entry blocks the claim
  // forever and idempotency wedges permanently instead of for the TTL.
  const time = clock()
  const store = createMemoryStore(time.now)
  assert.equal(await store.setIfAbsent('k', 'first', 1000), true)
  time.advance(1001)
  assert.equal(await store.setIfAbsent('k', 'second'), true)
  assert.equal(await store.get('k'), 'second')
})

test('setIfAbsent honors a ttl on the entry it creates', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.setIfAbsent('k', 'v', 1000)
  time.advance(1001)
  assert.equal(await store.get('k'), undefined)
})

test('incr on an expired entry produces one with no deadline', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('n', 5, 1000)
  time.advance(1001)
  assert.equal(await store.incr('n'), 1)
  time.advance(1_000_000)
  // incr takes no ttlMs, so it cannot re-arm a deadline it was never given.
  // A caller wanting a decaying counter must set() it with a TTL.
  assert.equal(await store.get('n'), 1)
})

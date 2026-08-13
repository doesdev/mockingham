import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import type { FixtureEntry } from '../../src/fixtures/store.ts'
import { loadFixtures, writeFixtures, createDiskFixtureStore, warnOnStaleFixtures } from '../../src/fixtures/persist.ts'

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'mockingham-fixtures-'))
}

test('a written store round-trips', async () => {
  const dir = await scratch()
  const source = createMemoryFixtureStore()
  source.set('getUser', 200, 'a3f19c2e', { value: { id: 42 }, meta: { source: 'recorded' } })
  await writeFixtures(dir, source)

  const target = createMemoryFixtureStore()
  await loadFixtures(dir, target)
  assert.deepEqual(target.get('getUser', 200, 'a3f19c2e'), {
    value: { id: 42 },
    meta: { source: 'recorded' }
  })
})

test('a hand-written fixture with no meta loads', async () => {
  const dir = await scratch()
  await writeFile(
    join(dir, 'getUser.json'),
    JSON.stringify({ '200': { a3f19c2e: { value: { id: 7 } } } })
  )
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store)
  assert.deepEqual(store.get('getUser', 200, 'a3f19c2e'), { value: { id: 7 } })
})

test('a missing directory loads as empty rather than throwing', async () => {
  const store = createMemoryFixtureStore()
  await loadFixtures(join(await scratch(), 'does-not-exist'), store)
  assert.equal(store.records().length, 0)
})

test('a missing directory does not warn — the silence is deliberate', async () => {
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(join(await scratch(), 'does-not-exist'), store, (message) =>
    warnings.push(message)
  )
  assert.equal(warnings.length, 0)
})

test('malformed json warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'broken.json'), '{ not json')
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /broken\.json/)
})

test('a file that is valid JSON but not an object (null) warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'getUser.json'), 'null')
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser\.json/)
})

test('a file that is valid JSON but an array warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'getUser.json'), '[1, 2, 3]')
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser\.json/)
})

test('a status bucket that is null warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'getUser.json'), JSON.stringify({ '200': null }))
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser\.json/)
})

test('an entry that is null warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'getUser.json'), JSON.stringify({ '200': { k: null } }))
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser\.json/)
  assert.match(warnings[0] as string, /"k"/)
})

test('an entry that is a scalar, not an object, warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'getUser.json'), JSON.stringify({ '200': { k: 42 } }))
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
})

test('an entry that is an object but has no value property warns and is skipped rather than throwing', async () => {
  const dir = await scratch()
  await writeFile(
    join(dir, 'getUser.json'),
    JSON.stringify({ '200': { k: { meta: { source: 'recorded' } } } })
  )
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
})

// A well-formed entry alongside a malformed one in the same bucket: proves
// the bad entry is skipped INDIVIDUALLY, not that the whole bucket (or file)
// was discarded — which the bucket- and file-level tests above could not
// distinguish from this, since they only ever plant one entry.
test('a malformed entry does not take a sibling well-formed entry down with it', async () => {
  const dir = await scratch()
  await writeFile(
    join(dir, 'getUser.json'),
    JSON.stringify({ '200': { bad: null, good: { value: { id: 1 } } } })
  )
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 1)
  assert.deepEqual(store.get('getUser', 200, 'good'), { value: { id: 1 } })
  assert.equal(warnings.length, 1)
})

test('warnOnStaleFixtures does not throw when a record entry is null — defense in depth beyond loadFixtures for a store populated some other way', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'k', null as unknown as FixtureEntry)
  assert.doesNotThrow(() => warnOnStaleFixtures(store, () => 'some-hash', () => {}))
})

test('a non-numeric status key warns and is skipped rather than colliding into one entry', async () => {
  const dir = await scratch()
  await writeFile(
    join(dir, 'getUser.json'),
    JSON.stringify({ abc: { a3f19c2e: { value: 1 } } })
  )
  const warnings: string[] = []
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store, (message) => warnings.push(message))
  assert.equal(store.records().length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser\.json/)
  assert.match(warnings[0] as string, /abc/)
})

test('two writes of the same content produce byte-identical files', async () => {
  const dirA = await scratch()
  const dirB = await scratch()
  const a = createMemoryFixtureStore()
  a.set('b', 200, 'k2', { value: 2 })
  a.set('a', 200, 'k1', { value: 1 })
  const b = createMemoryFixtureStore()
  b.set('a', 200, 'k1', { value: 1 })
  b.set('b', 200, 'k2', { value: 2 })
  await writeFixtures(dirA, a)
  await writeFixtures(dirB, b)
  assert.equal(
    await readFile(join(dirA, 'a.json'), 'utf8'),
    await readFile(join(dirB, 'a.json'), 'utf8')
  )
})

// writeFixtures itself does no sorting of keys within a status bucket — it
// relies entirely on store.records() already being sorted. The test above
// never exercises two keys under the same operationId+status, so it cannot
// catch a regression in that reliance. This one can: two stores build the
// same bucket in opposite insertion order, and the written files must still
// be byte-identical.
test('byte-identical output holds even with multiple keys in one bucket, inserted in opposite order', async () => {
  const dirA = await scratch()
  const dirB = await scratch()
  const a = createMemoryFixtureStore()
  a.set('multi', 200, 'k2', { value: 2 })
  a.set('multi', 200, 'k1', { value: 1 })
  const b = createMemoryFixtureStore()
  b.set('multi', 200, 'k1', { value: 1 })
  b.set('multi', 200, 'k2', { value: 2 })
  await writeFixtures(dirA, a)
  await writeFixtures(dirB, b)
  assert.equal(
    await readFile(join(dirA, 'multi.json'), 'utf8'),
    await readFile(join(dirB, 'multi.json'), 'utf8')
  )
})

test('the disk store debounces writes and flush forces them', async () => {
  const dir = await scratch()
  const store = await createDiskFixtureStore({ dir, debounceMs: 50 })
  store.set('getUser', 200, 'a3f19c2e', { value: { id: 1 } })
  store.set('getUser', 200, 'b4f19c2e', { value: { id: 2 } })
  await store.flush()
  const written = JSON.parse(await readFile(join(dir, 'getUser.json'), 'utf8'))
  assert.equal(Object.keys(written['200']).length, 2)
})

test('a temp file is not left behind after a write', async () => {
  const dir = await scratch()
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: 1 })
  await writeFixtures(dir, store)
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(dir)
  assert.deepEqual(names, ['getUser.json'])
})

test('an operation slug that escapes the directory is rejected', async () => {
  const dir = await scratch()
  const store = createMemoryFixtureStore()
  store.set('../escape', 200, 'a3f19c2e', { value: 1 })
  await assert.rejects(() => writeFixtures(dir, store), /operation id/i)
})

test('an operation slug containing only a backslash is rejected', async () => {
  const dir = await scratch()
  const store = createMemoryFixtureStore()
  store.set('esc\\ape', 200, 'a3f19c2e', { value: 1 })
  await assert.rejects(() => writeFixtures(dir, store), /operation id/i)
})

test('an operation slug containing only a forward slash is rejected', async () => {
  const dir = await scratch()
  const store = createMemoryFixtureStore()
  store.set('esc/ape', 200, 'a3f19c2e', { value: 1 })
  await assert.rejects(() => writeFixtures(dir, store), /operation id/i)
})

test('an operation id containing only .. is rejected', async () => {
  const dir = await scratch()
  const store = createMemoryFixtureStore()
  store.set('esc..ape', 200, 'k', { value: 1 })
  await assert.rejects(() => writeFixtures(dir, store), /operation id/i)
})

test('a failed write does not stop later writes from succeeding', async () => {
  const dir = await scratch()
  const store = await createDiskFixtureStore({ dir, debounceMs: 10_000 })
  // An unsafe operation id makes writeFixtures reject.
  store.set('../escape', 200, 'k', { value: 1 })
  await assert.rejects(() => store.flush())
  // The chain must still be alive: a good record written afterwards lands.
  store.clear()
  store.set('getUser', 200, 'k', { value: 2 })
  await store.flush()
  const written = JSON.parse(await readFile(join(dir, 'getUser.json'), 'utf8'))
  assert.deepEqual(written['200'].k, { value: 2 })
})

test('a failed background write warns instead of rejecting unhandled', async () => {
  const dir = await scratch()
  const warnings: string[] = []
  let signal: () => void = () => {}
  const warned = new Promise<void>((resolve) => {
    signal = resolve
  })
  const store = await createDiskFixtureStore({
    dir,
    debounceMs: 5,
    onWarn: (message) => {
      warnings.push(message)
      signal()
    }
  })
  store.set('../escape', 200, 'k', { value: 1 })
  await Promise.race([
    warned,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('no warning arrived within 2s')), 2000)
    )
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /could not write fixtures/)
})

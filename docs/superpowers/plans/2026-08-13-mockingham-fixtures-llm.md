# Fixtures and the Content Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 11 - a content-addressed fixture store that serves reviewed
mock data ahead of seeded generation, plus the bake driver and three content
sources that populate it.

**Architecture:** A fixture is looked up once per request by a seed-independent
request hash. A whole-body fixture is returned at the `createResponders.generate`
seam in place of `generateValue`; a scoped fixture is applied as the first body
layer in `renderResponse`, beneath the user's override layers, which makes
precedence (`override > fixture > example > generated`) fall out of the existing
override machinery rather than a new merge. Disk and providers are injected: the
pure core sees a `FixtureStore` and a `ContentSource` interface and nothing else.

**Tech Stack:** TypeScript (erasable syntax only), Node >= 24, `node:test`, `zod`
(the only hard runtime dependency), `@anthropic-ai/sdk` (optional peer, lazily
imported, only for `provider: 'anthropic'`).

**Spec:** `docs/superpowers/specs/2026-08-13-mockingham-fixtures-llm-design.md`.
Read it alongside this plan. The master contract is
`docs/superpowers/specs/2026-08-11-mockingham-design.md` §14; where the two
disagree, the phase 11 design wins.

## Global Constraints

- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
  Use `const X = {...} as const`.
- **One schema interpretation.** Any schema walking goes through `classify()` /
  `mergeAllOf()` / `isNullable()` in `src/schema/walk.ts`. Never write a second
  reading of a schema. This applies to `fixtures/scope.ts` and
  `fixtures/source.ts` in particular - both walk schemas and both must use
  `classify()`.
- **Determinism.** No `Math.random()`, no `Date.now()`, no iteration over an
  unordered `Set`/object in any generation path. Time comes from the injected
  `now: () => number`. The single exception in this plan is `llm.mode: 'live'`,
  which is documented as non-deterministic by design.
- **The core is pure.** `src/server/handler.ts` and everything it imports at
  runtime must not touch Node APIs. `node:` may appear only in
  `src/server/node.ts`, `src/server/cli.ts`, and the new
  `src/fixtures/persist.ts`. `import type` is erased and is always safe.
- **A fixture or LLM miss is never an error.** A miss, timeout, refusal, budget
  exhaustion, failed validation, or thrown source all fall through to seeded
  generation. Nothing in this plan may make the mock stop serving.
- **Errors stay on-contract.** Nothing here changes error bodies.
- **Emission never affects the response.** Nothing here changes emission.
- **US English spelling** in identifiers, test names, comments, and docs -
  `honor`, `behavior`, `serialize`, `normalize`, `canceled`.
- **Tests** live in `test/` mirroring `src/`, run with `npm test`
  (`node --test`). Typecheck with `npx tsc --noEmit`.
- **Shell:** one plain command per Bash call, literal arguments, single quotes,
  no `&&`/`|`/`$()`/redirects/heredocs. Multi-paragraph commits use repeated
  `-m`. Never `cd`.
- **Every test in this plan must be verified by mutation** before the task is
  accepted: break the implementation, run the test, watch it fail, restore.
  "Falls through to seeded generation" is also what a test that is not wired up
  correctly does, so a passing fixture test proves nothing on its own.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/fixtures/key.ts` | Seed-independent fixture key and operation slug. Pure. |
| `src/fixtures/store.ts` | `FixtureStore` interface, in-memory implementation, entry types. Pure. |
| `src/fixtures/persist.ts` | Load a fixture directory, atomic debounced writes, staleness warning. **Node only.** |
| `src/fixtures/scope.ts` | Whether a config is scoped, and narrowing a value to the scoped paths via `classify()`. Pure. |
| `src/fixtures/source.ts` | `ContentSource`, `FixtureRequest`, `FixtureResult`, request building, recursion detection. Pure. |
| `src/fixtures/resolve.ts` | Lookup, single-flight, and the two application modes. Pure. |
| `src/fixtures/bake.ts` | The bake walk, budget, concurrency, summary. Pure. |
| `src/fixtures/config.ts` | `LlmConfig` zod validation and provider resolution. Imported by `index.ts`, not by the handler. |
| `src/fixtures/sources/openai.ts` | Default source. `fetch` + JSON, zero dependencies. |
| `src/fixtures/sources/anthropic.ts` | Optional peer dependency, lazily imported, batch path. |
| `src/fixtures/sources/recorded.ts` | Answers from supplied upstream responses. |
| `src/runtime/pipeline.ts` | **Modify** - `generate()` consults a whole-body fixture first. |
| `src/runtime/render.ts` | **Modify** - accepts one fixture layer beneath the user's. |
| `src/server/handler.ts` | **Modify** - resolves a fixture after status selection, wires options. |
| `src/index.ts` | **Modify** - `createMock` validates `llm`, resolves the provider, exposes `bake()`. |
| `src/server/cli.ts` | **Modify** - `bake` subcommand, environment defaults. |

---

## Task 1: Fixture key

**Files:**
- Create: `src/fixtures/key.ts`
- Test: `test/fixtures/key.test.ts`

**Interfaces:**
- Consumes: `fnv1a` from `src/generate/rng.ts`.
- Produces: `operationSlug(operation: Operation): string`,
  `fixtureKey(input: KeyInput): string`, and
  `interface KeyInput { method: string; path: string; params: Record<string, string>; contributors?: Record<string, string> }`.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/key.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureKey, operationSlug } from '../../src/fixtures/key.ts'
import type { Operation } from '../../src/spec/types.ts'

const base = { method: 'get', path: '/users/{id}', params: { id: '42' } }

test('the key is eight lowercase hex characters', () => {
  assert.match(fixtureKey(base), /^[0-9a-f]{8}$/)
})

test('the key does not vary with the root seed', () => {
  // The key input has no seed field at all - this is the amendment in design
  // section 2.1. A varied run must still read baked fixtures.
  assert.equal(fixtureKey(base), fixtureKey({ ...base }))
})

test('a different path param produces a different key', () => {
  assert.notEqual(fixtureKey(base), fixtureKey({ ...base, params: { id: '43' } }))
})

test('param order does not affect the key', () => {
  const a = { method: 'get', path: '/a/{x}/{y}', params: { x: '1', y: '2' } }
  const b = { method: 'get', path: '/a/{x}/{y}', params: { y: '2', x: '1' } }
  assert.equal(fixtureKey(a), fixtureKey(b))
})

test('the method is normalized', () => {
  assert.equal(fixtureKey(base), fixtureKey({ ...base, method: 'GET' }))
})

test('contributors change the key', () => {
  assert.notEqual(fixtureKey(base), fixtureKey({ ...base, contributors: { page: '2' } }))
})

test('operationSlug prefers operationId', () => {
  const operation = { method: 'get', path: '/users/{id}', operationId: 'getUser' }
  assert.equal(operationSlug(operation as Operation), 'getUser')
})

test('operationSlug falls back to a filesystem-safe method and path', () => {
  const operation = { method: 'get', path: '/users/{id}' }
  assert.equal(operationSlug(operation as Operation), 'get_users_id')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/key.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/key.ts`:

```ts
import { fnv1a } from '../generate/rng.ts'
import type { Operation } from '../spec/types.ts'

export interface KeyInput {
  method: string
  /** The templated path, not the concrete one. */
  path: string
  params: Record<string, string>
  /** Configured query and header contributors, already selected by the caller. */
  contributors?: Record<string, string>
}

/**
 * A filesystem-safe, stable identifier for an operation. `operationId` when the
 * document supplies one; otherwise method and path, which is unique because the
 * router already rejects duplicate method-path pairs.
 */
export function operationSlug(operation: Operation): string {
  if (operation.operationId) return operation.operationId
  const path = operation.path
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${operation.method}_${path}`
}

function ordered(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((name) => `${name}=${values[name]}`)
    .join('&')
}

/**
 * The fixture key is the request identity WITHOUT the root seed - design
 * section 2.1. Including the seed would mean a run started with a different
 * `seed` misses every fixture on disk, which turns varying the seed into
 * silently abandoning reviewed data.
 *
 * Eight hex characters, matching the master spec's storage example. Thirty-two
 * bits is narrow, but the key space is scoped per operation and per status, and
 * the store is a reviewed artifact where a collision shows up in the diff.
 */
export function fixtureKey(input: KeyInput): string {
  const canonical = [
    input.method.toLowerCase(),
    input.path,
    ordered(input.params),
    ordered(input.contributors ?? {})
  ].join('|')
  return fnv1a(canonical).toString(16).padStart(8, '0')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 8 new tests.

- [ ] **Step 5: Verify by mutation**

Add `input.method` a second time to the `canonical` array - the ordering tests
still pass but nothing fails, which tells you those tests do not pin ordering.
Then change `.sort()` to a no-op and confirm `param order does not affect the
key` fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/key.ts test/fixtures/key.test.ts
```

```sh
git commit -m 'feat: derive a seed-independent fixture key' -m 'Design section 2.1. The master spec reuses the PRNG seed hash, which includes the root seed, so setting seed would miss every baked fixture.'
```

---

## Task 2: The fixture store

**Files:**
- Create: `src/fixtures/store.ts`
- Test: `test/fixtures/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface FixtureMeta { source?: string; model?: string; schemaHash?: string; promptVersion?: number; generatedAt?: string }`,
  `interface FixtureEntry { value: unknown; meta?: FixtureMeta }`,
  `interface FixtureRecord { operationId: string; status: number; key: string; entry: FixtureEntry }`,
  `interface FixtureStore { get(operationId: string, status: number, key: string): FixtureEntry | undefined; set(operationId: string, status: number, key: string, entry: FixtureEntry): void; records(): FixtureRecord[]; clear(): void }`,
  `createMemoryFixtureStore(): FixtureStore`.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'

test('a stored entry is readable by the same triple', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: { id: 42 } })
  assert.deepEqual(store.get('getUser', 200, 'a3f19c2e'), { value: { id: 42 } })
})

test('a different status is a different bucket', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: { id: 42 } })
  assert.equal(store.get('getUser', 404, 'a3f19c2e'), undefined)
})

test('a miss returns undefined rather than throwing', () => {
  const store = createMemoryFixtureStore()
  assert.equal(store.get('nope', 200, 'deadbeef'), undefined)
})

test('an entry without meta is accepted - hand-written fixtures have none', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: 1 })
  assert.equal(store.get('getUser', 200, 'a3f19c2e')?.meta, undefined)
})

test('records are returned in a stable order across stores', () => {
  const one = createMemoryFixtureStore()
  one.set('b', 200, 'k2', { value: 2 })
  one.set('a', 200, 'k1', { value: 1 })
  const two = createMemoryFixtureStore()
  two.set('a', 200, 'k1', { value: 1 })
  two.set('b', 200, 'k2', { value: 2 })
  assert.deepEqual(
    one.records().map((r) => `${r.operationId}|${r.status}|${r.key}`),
    two.records().map((r) => `${r.operationId}|${r.status}|${r.key}`)
  )
})

test('clear empties the store', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'a3f19c2e', { value: 1 })
  store.clear()
  assert.equal(store.records().length, 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/store.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/store.ts`:

```ts
export interface FixtureMeta {
  /** The provider that produced it: 'openai-compatible', 'anthropic', 'recorded'. */
  source?: string
  model?: string
  /** Detects drift when the document changes. Absent on hand-written fixtures. */
  schemaHash?: string
  promptVersion?: number
  generatedAt?: string
}

export interface FixtureEntry {
  value: unknown
  /**
   * Absent on a hand-written fixture, which is why it is optional. A fixture
   * with no meta is never reported stale - design section 2.13.
   */
  meta?: FixtureMeta
}

export interface FixtureRecord {
  operationId: string
  status: number
  key: string
  entry: FixtureEntry
}

export interface FixtureStore {
  get(operationId: string, status: number, key: string): FixtureEntry | undefined
  set(operationId: string, status: number, key: string, entry: FixtureEntry): void
  /** Sorted, so persistence writes byte-identical files across processes. */
  records(): FixtureRecord[]
  clear(): void
}

function id(operationId: string, status: number, key: string): string {
  return `${operationId}|${status}|${key}`
}

export function createMemoryFixtureStore(): FixtureStore {
  const entries = new Map<string, FixtureRecord>()

  return {
    get: (operationId, status, key) =>
      entries.get(id(operationId, status, key))?.entry,

    set(operationId, status, key, entry) {
      entries.set(id(operationId, status, key), { operationId, status, key, entry })
    },

    // Sorted rather than insertion-ordered. Insertion order depends on the order
    // requests arrived, which would make the file on disk differ between two
    // runs that produced identical content - against the determinism invariant
    // in the one place it reaches a committed artifact.
    records: () =>
      [...entries.values()].sort((a, b) =>
        id(a.operationId, a.status, a.key).localeCompare(
          id(b.operationId, b.status, b.key)
        )
      ),

    clear: () => entries.clear()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 6 new tests.

- [ ] **Step 5: Verify by mutation**

Replace the `records()` sort with `[...entries.values()]` and confirm `records
are returned in a stable order across stores` fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/store.ts test/fixtures/store.test.ts
```

```sh
git commit -m 'feat: add the in-memory fixture store' -m 'Records sort rather than preserving insertion order, so two runs that produce identical content write identical files.'
```

---

## Task 3: Persistence

**Files:**
- Create: `src/fixtures/persist.ts`
- Test: `test/fixtures/persist.test.ts`

**Interfaces:**
- Consumes: `FixtureStore`, `FixtureEntry`, `FixtureRecord` from `src/fixtures/store.ts`.
- Produces: `loadFixtures(dir: string, store: FixtureStore): Promise<void>`,
  `writeFixtures(dir: string, store: FixtureStore): Promise<void>`,
  `createDiskFixtureStore(options: DiskStoreOptions): Promise<FixtureStore & { flush(): Promise<void> }>`
  where `interface DiskStoreOptions { dir: string; debounceMs?: number; onWarn?: (message: string) => void }`.

**This is the only new file allowed to import `node:` modules.**

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/persist.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { loadFixtures, writeFixtures, createDiskFixtureStore } from '../../src/fixtures/persist.ts'

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/persist.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/persist.ts`:

```ts
import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixtureEntry, FixtureStore } from './store.ts'

export interface DiskStoreOptions {
  dir: string
  debounceMs?: number
  onWarn?: (message: string) => void
}

/**
 * An operation id reaches the filesystem as a file name. It comes from the
 * document's `operationId`, which is author-controlled, so it is checked rather
 * than trusted.
 */
function safeName(operationId: string): string {
  if (operationId.includes('/') || operationId.includes('\\') || operationId.includes('..')) {
    throw new Error(
      `mockingham: operation id ${JSON.stringify(operationId)} is not a safe file name`
    )
  }
  return `${operationId}.json`
}

export async function loadFixtures(
  dir: string,
  store: FixtureStore,
  onWarn?: (message: string) => void
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // No fixture directory is the common case, not an error.
    return
  }

  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const operationId = name.slice(0, -'.json'.length)
    let parsed: Record<string, Record<string, FixtureEntry>>
    try {
      parsed = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      // Invariant 4: a broken fixture file must not stop the mock from serving.
      onWarn?.(`mockingham: could not read fixture file ${name}; skipping it`)
      continue
    }
    for (const status of Object.keys(parsed).sort()) {
      const bucket = parsed[status] ?? {}
      for (const key of Object.keys(bucket).sort()) {
        store.set(operationId, Number(status), key, bucket[key] as FixtureEntry)
      }
    }
  }
}

export async function writeFixtures(dir: string, store: FixtureStore): Promise<void> {
  const files = new Map<string, Record<string, Record<string, FixtureEntry>>>()
  for (const record of store.records()) {
    const file = safeName(record.operationId)
    const byStatus = files.get(file) ?? {}
    const bucket = byStatus[String(record.status)] ?? {}
    bucket[record.key] = record.entry
    byStatus[String(record.status)] = bucket
    files.set(file, byStatus)
  }

  await mkdir(dir, { recursive: true })
  for (const [file, content] of [...files.entries()].sort()) {
    // Temp file plus rename: a reader never sees a half-written file, and a
    // crash mid-write leaves the previous version intact.
    const temp = join(dir, `.${file}.tmp`)
    await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`)
    await rename(temp, join(dir, file))
  }
}

export async function createDiskFixtureStore(
  options: DiskStoreOptions
): Promise<FixtureStore & { flush(): Promise<void> }> {
  const { createMemoryFixtureStore } = await import('./store.ts')
  const memory = createMemoryFixtureStore()
  await loadFixtures(options.dir, memory, options.onWarn)

  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined

  const write = async (): Promise<void> => {
    timer = undefined
    pending = writeFixtures(options.dir, memory)
    await pending
    pending = undefined
  }

  return {
    get: memory.get,
    records: memory.records,
    clear: memory.clear,

    set(operationId, status, key, entry) {
      memory.set(operationId, status, key, entry)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void write(), debounceMs)
    },

    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await write()
      if (pending) await pending
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 8 new tests.

- [ ] **Step 5: Verify by mutation**

Remove the `.sort()` from the `files.entries()` loop and confirm the
byte-identical test still passes (it compares one file), then remove the
`Object.keys(...).sort()` inside `writeFixtures`' bucket construction and
confirm it fails. Replace `rename` with a direct `writeFile` and confirm the
temp-file test still passes - it does, which means that test only pins cleanup,
not atomicity. Note that limitation in the commit body. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/persist.ts test/fixtures/persist.test.ts
```

```sh
git commit -m 'feat: persist fixtures to disk atomically' -m 'Temp file plus rename, debounced. Malformed files warn and are skipped rather than stopping the mock, per invariant 4.' -m 'The temp-file test pins cleanup, not atomicity; a crash mid-rename is not covered by the suite.'
```

---

## Task 4: Scope narrowing

**Files:**
- Create: `src/fixtures/scope.ts`
- Test: `test/fixtures/scope.test.ts`

**Interfaces:**
- Consumes: `classify`, `mergeAllOf` from `src/schema/walk.ts`; `Schema` from `src/spec/types.ts`.
- Produces: `interface ScopeConfig { byName?: string[]; bySchema?: string[] }`,
  `isScoped(config?: ScopeConfig): boolean`,
  `narrow(value: unknown, schema: Schema, config: ScopeConfig, schemaNames: Map<Schema, string>): unknown`.

**This task walks schemas. It must use `classify()` from `src/schema/walk.ts`
and must not read `schema.type`, `schema.properties`, `schema.oneOf`, or
`schema.allOf` directly.** That is invariant 1 and it is the single easiest
place in this plan to break it.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/scope.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScoped, narrow } from '../../src/fixtures/scope.ts'
import type { Schema } from '../../src/spec/types.ts'

const user: Schema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    bio: { type: 'string' },
    address: { type: 'object', properties: { city: { type: 'string' } } }
  }
}

test('an empty config is not scoped', () => {
  assert.equal(isScoped(undefined), false)
  assert.equal(isScoped({}), false)
  assert.equal(isScoped({ byName: [] }), false)
})

test('a config naming a field is scoped', () => {
  assert.equal(isScoped({ byName: ['bio'] }), true)
})

test('byName keeps only the named property', () => {
  const value = { id: 1, bio: 'hello', address: { city: 'Leeds' } }
  assert.deepEqual(narrow(value, user, { byName: ['bio'] }, new Map()), { bio: 'hello' })
})

test('byName reaches a nested property', () => {
  const value = { id: 1, bio: 'hello', address: { city: 'Leeds' } }
  assert.deepEqual(
    narrow(value, user, { byName: ['city'] }, new Map()),
    { address: { city: 'Leeds' } }
  )
})

test('bySchema keeps a whole named subschema', () => {
  const address = user.properties?.address as Schema
  const names = new Map<Schema, string>([[address, 'Address']])
  const value = { id: 1, bio: 'hello', address: { city: 'Leeds' } }
  assert.deepEqual(
    narrow(value, user, { bySchema: ['Address'] }, names),
    { address: { city: 'Leeds' } }
  )
})

test('narrowing an array applies per item', () => {
  const list: Schema = { type: 'array', items: user }
  const value = [{ id: 1, bio: 'a' }, { id: 2, bio: 'b' }]
  assert.deepEqual(narrow(value, list, { byName: ['bio'] }, new Map()), [
    { bio: 'a' },
    { bio: 'b' }
  ])
})

test('nothing in scope narrows to undefined rather than an empty object', () => {
  const value = { id: 1, bio: 'hello' }
  assert.equal(narrow(value, user, { byName: ['nope'] }, new Map()), undefined)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/scope.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/scope.ts`:

```ts
import { classify } from '../schema/walk.ts'
import type { Schema } from '../spec/types.ts'

export interface ScopeConfig {
  byName?: string[]
  bySchema?: string[]
}

export function isScoped(config?: ScopeConfig): boolean {
  return (config?.byName?.length ?? 0) > 0 || (config?.bySchema?.length ?? 0) > 0
}

/**
 * Reduces a full value to only the parts the scope config claims, so a scoped
 * fixture stores prose and nothing else and the rest stays seeded and fast.
 *
 * Walks THROUGH `classify()` - the same reading generation and compilation use.
 * A second interpretation of a schema here is the worst bug class in this
 * project, and "what we asked the model for" diverging from "what we generate"
 * is exactly that bug wearing a different hat.
 *
 * Returns `undefined` when nothing is in scope, which the caller reads as
 * "no fixture" rather than "an empty fixture".
 */
export function narrow(
  value: unknown,
  schema: Schema,
  config: ScopeConfig,
  schemaNames: Map<Schema, string>
): unknown {
  const names = new Set(config.byName ?? [])
  const schemas = new Set(config.bySchema ?? [])

  const walk = (node: unknown, current: Schema, seen: Set<Schema>): unknown => {
    // A named schema in scope claims its whole subtree, checked before
    // recursing so `bySchema: ['Address']` keeps every field of an Address.
    const name = schemaNames.get(current)
    if (name !== undefined && schemas.has(name)) return node

    // Recursion guard. A recursive schema is excluded from the content path
    // anyway, but narrow() is also called on generated values during bake and
    // must not spin.
    if (seen.has(current)) return undefined
    const nested = new Set(seen)
    nested.add(current)

    const kind = classify(current)

    if (kind.kind === 'array') {
      if (!Array.isArray(node)) return undefined
      const items = node.map((item) => walk(item, kind.items, nested))
      return items.some((item) => item !== undefined) ? items : undefined
    }

    if (kind.kind === 'object') {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        return undefined
      }
      const source = node as Record<string, unknown>
      const out: Record<string, unknown> = {}
      let kept = false
      // Sorted so the narrowed object serializes identically across processes.
      for (const property of Object.keys(kind.properties).sort()) {
        if (!(property in source)) continue
        const child = kind.properties[property] as Schema
        if (names.has(property)) {
          out[property] = source[property]
          kept = true
          continue
        }
        const narrowed = walk(source[property], child, nested)
        if (narrowed !== undefined) {
          out[property] = narrowed
          kept = true
        }
      }
      return kept ? out : undefined
    }

    return undefined
  }

  return walk(value, schema, new Set())
}
```

**Note for the implementer:** `classify()` returns a discriminated union. Read
`src/schema/walk.ts` for the exact member names of the `array` and `object`
variants before writing this - if they differ from `kind.items` and
`kind.properties`, use the real ones and keep everything else identical.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 7 new tests.

- [ ] **Step 5: Verify by mutation**

Move the `schemaNames` check to after the `classify()` switch and confirm
`bySchema keeps a whole named subschema` fails. Change `return kept ? out :
undefined` to `return out` and confirm `nothing in scope narrows to undefined`
fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/scope.ts test/fixtures/scope.test.ts
```

```sh
git commit -m 'feat: narrow a value to its scoped fixture paths' -m 'Walks through classify() rather than reading the schema directly, so scope narrowing cannot become a second interpretation.'
```

---

## Task 5: The whole-body fixture seam

**Files:**
- Modify: `src/runtime/pipeline.ts`
- Test: `test/runtime/pipeline.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RespondersInput` gains `fixture?: (status: number) => unknown`.
  `Responders.generate` returns the fixture value when the hook supplies one.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime/pipeline.test.ts`:

```ts
test('generate returns a whole-body fixture instead of generating', () => {
  let generated = 0
  const responders = createResponders({
    operation: petstoreListOperation(),
    request: new Request('https://x/pets'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: { schemaNames: new Map() },
    fixture: (status) => {
      generated += 1
      return status === 200 ? [{ id: 99, name: 'Fixture' }] : undefined
    }
  })
  assert.deepEqual(responders.generate(), [{ id: 99, name: 'Fixture' }])
  assert.equal(generated, 1)
})

test('generate falls through to generation when the fixture hook returns undefined', () => {
  const responders = createResponders({
    operation: petstoreListOperation(),
    request: new Request('https://x/pets'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: { schemaNames: new Map() },
    fixture: () => undefined
  })
  assert.ok(Array.isArray(responders.generate()))
})

test('generate is unchanged when no fixture hook is supplied', () => {
  const responders = createResponders({
    operation: petstoreListOperation(),
    request: new Request('https://x/pets'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: { schemaNames: new Map() }
  })
  assert.ok(Array.isArray(responders.generate()))
})
```

**Note for the implementer:** `petstoreListOperation()` is illustrative. Reuse
whatever operation-building helper `test/runtime/pipeline.test.ts` already uses;
read the top of that file first and match its existing style exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /opt/claude-projects/mockingham/test/runtime/pipeline.test.ts`
Expected: FAIL - the first test returns a generated array, not the fixture.

- [ ] **Step 3: Write the implementation**

In `src/runtime/pipeline.ts`, add to `RespondersInput`:

```ts
  /**
   * Consulted before generating. Returns a whole-body fixture, or undefined to
   * fall through. Synchronous by design: a store hit is a Map read, and a lazy
   * fetch is awaited earlier in `produce()` - design section 2.12. A full
   * response callback therefore sees baked fixtures but never triggers a fetch.
   */
  fixture?: (status: number) => unknown
```

and change `generate` to:

```ts
    generate(status) {
      const target = targetFor(status)
      if (target === undefined) return undefined
      // Before mediaFor: a fixture answers even where the media type lookup
      // would not, and it must not pay for generation it replaces.
      const fixed = input.fixture?.(target)
      if (fixed !== undefined) return fixed
      const media = mediaFor(target)
      if (!media) return undefined
      return generateValue(media.schema, rngFor(String(target)), {
        ...input.generateOptions,
        ctx: input.ctx?.()
      })
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 3 new tests, all 600 existing tests still passing.

- [ ] **Step 5: Verify by mutation**

Move the `input.fixture?.(target)` call to after the `generateValue` return and
confirm the first test fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/runtime/pipeline.ts test/runtime/pipeline.test.ts
```

```sh
git commit -m 'feat: consult a whole-body fixture at the generate seam' -m 'The hook is synchronous. A lazy fetch is awaited in produce() before this point, so a full response callback sees baked fixtures but never triggers one.'
```

---

## Task 6: The scoped fixture layer

**Files:**
- Modify: `src/runtime/render.ts`
- Test: `test/runtime/render.test.ts` (extend)

**Interfaces:**
- Consumes: `applyOverrides` from `src/resolve/layer.ts` (already imported).
- Produces: `RenderInput` gains `fixtureLayer?: OverrideNode`.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime/render.test.ts`:

```ts
test('a scoped fixture layer overlays the generated body', async () => {
  const response = await renderResponse({
    ...baseRenderInput(),
    generate: () => ({ id: 1, bio: 'generated' }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'from the fixture' })
})

test('a user override beats the fixture layer', async () => {
  const response = await renderResponse({
    ...baseRenderInput(),
    generate: () => ({ id: 1, bio: 'generated' }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: [{ bio: 'from the override' }]
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'from the override' })
})

test('the fixture layer beats a spec example', async () => {
  const response = await renderResponse({
    ...baseRenderInput(),
    exampleName: 'sample',
    example: () => ({ id: 1, bio: 'from the example' }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'from the fixture' })
})

test('no fixture layer leaves rendering unchanged', async () => {
  const response = await renderResponse({
    ...baseRenderInput(),
    generate: () => ({ id: 1, bio: 'generated' }),
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'generated' })
})
```

**Note for the implementer:** `baseRenderInput()` is illustrative. Read
`test/runtime/render.test.ts` and reuse whatever `RenderInput` fixture builder it
already has, matching its style.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /opt/claude-projects/mockingham/test/runtime/render.test.ts`
Expected: FAIL - `bio` is still `generated`.

- [ ] **Step 3: Write the implementation**

In `src/runtime/render.ts`, add to `RenderInput`:

```ts
  /**
   * A scoped fixture, applied BENEATH the user's layers. This is what makes
   * `override > fixture > example > generated` fall out of the existing
   * override machinery instead of a bespoke merge - design section 3.
   */
  fixtureLayer?: OverrideNode
```

and replace the override application block with:

```ts
  // The fixture goes first so the user's layers land on top of it.
  const layers = input.fixtureLayer === undefined
    ? input.bodyOverrides
    : [input.fixtureLayer, ...input.bodyOverrides]

  if (layers.length === 0) {
    // Still one pass: resolvers may have left promises in the tree.
    if (body !== undefined) body = await applyOverrides(body, undefined, input.ctx)
  } else {
    for (const override of layers) {
      body = await applyOverrides(body, override, input.ctx)
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 4 new tests, all existing tests still passing.

- [ ] **Step 5: Verify by mutation**

Change the layer order to `[...input.bodyOverrides, input.fixtureLayer]` and
confirm `a user override beats the fixture layer` fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/runtime/render.ts test/runtime/render.test.ts
```

```sh
git commit -m 'feat: apply a scoped fixture as the layer beneath user overrides' -m 'Precedence falls out of the existing override machinery, so partial fixtures need no second schema traversal.'
```

---

## Task 7: The provider interface and request building

**Files:**
- Create: `src/fixtures/source.ts`
- Test: `test/fixtures/source.test.ts`

**Interfaces:**
- Consumes: `classify` from `src/schema/walk.ts`; `createCompiler` from `src/schema/compile.ts`; `Api`, `Operation`, `Schema` from `src/spec/types.ts`; `operationSlug` from `src/fixtures/key.ts`.
- Produces: `interface FixtureRequest`, `interface FixtureResult`, `interface ContentSource`,
  `isRecursive(schema: Schema): boolean`,
  `buildRequest(input: BuildRequestInput): FixtureRequest | undefined`.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/source.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRecursive, buildRequest } from '../../src/fixtures/source.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import type { Schema } from '../../src/spec/types.ts'

test('a flat schema is not recursive', () => {
  assert.equal(isRecursive({ type: 'object', properties: { a: { type: 'string' } } }), false)
})

test('a self-referencing schema is recursive', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  assert.equal(isRecursive(node), true)
})

test('a schema recursive through an array is recursive', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { children: { type: 'array', items: node } }
  assert.equal(isRecursive(node), true)
})

test('a request carries both schema representations', () => {
  const schema: Schema = { type: 'object', properties: { bio: { type: 'string' } } }
  const request = buildRequest({
    operation: { method: 'get', path: '/users/{id}', operationId: 'getUser',
      parameters: [], responses: [], callbacks: [] },
    status: 200,
    key: 'a3f19c2e',
    params: { id: '42' },
    schema,
    compiler: createCompiler(),
    schemaNames: new Map()
  })
  assert.ok(request)
  // The plain JSON Schema is what makes a non-Anthropic source writable -
  // design section 2.3.
  assert.equal((request.jsonSchema as { type?: string }).type, 'object')
  assert.equal(request.zodSchema.safeParse({ bio: 'hi' }).success, true)
  assert.equal(request.operationId, 'getUser')
  assert.equal(request.status, 200)
  assert.equal(request.key, 'a3f19c2e')
})

test('a recursive schema builds no request', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  const request = buildRequest({
    operation: { method: 'get', path: '/n', operationId: 'n',
      parameters: [], responses: [], callbacks: [] },
    status: 200,
    key: 'k',
    params: {},
    schema: node,
    compiler: createCompiler(),
    schemaNames: new Map()
  })
  assert.equal(request, undefined)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/source.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/source.ts`:

```ts
import { z } from 'zod'
import type { ZodType } from 'zod'
import { classify } from '../schema/walk.ts'
import type { Compiler } from '../schema/compile.ts'
import type { Operation, Schema } from '../spec/types.ts'
import { operationSlug } from './key.ts'
import type { FixtureMeta } from './store.ts'

export interface FixtureRequest {
  operationId: string
  method: string
  path: string
  status: number
  key: string
  params: Record<string, string>
  /**
   * The response body as plain JSON Schema. This is the field that makes the
   * interface genuinely provider-neutral: a source for another provider needs
   * this and nothing else from us - design section 2.3.
   */
  jsonSchema: Record<string, unknown>
  /** The same schema compiled, for client-side validation by any source. */
  zodSchema: ZodType
  summary?: string
  description?: string
  example?: unknown
  persona?: string
}

export interface FixtureResult {
  value: unknown
  meta?: FixtureMeta
}

/**
 * A provider. Results are positionally aligned with `reqs`; `null` is a miss,
 * never an error. Implementations need not be defensive - the driver wraps
 * them and treats a throw as all-nulls.
 */
export interface ContentSource {
  generate(reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]>
}

/**
 * Structured outputs do not support recursive schemas, so a recursive response
 * never reaches any source and stays generator-only. Walks through
 * `classify()`, like everything else that reads a schema.
 */
export function isRecursive(schema: Schema): boolean {
  const walk = (node: Schema, seen: Set<Schema>): boolean => {
    if (seen.has(node)) return true
    const nested = new Set(seen)
    nested.add(node)
    const kind = classify(node)
    if (kind.kind === 'array') return walk(kind.items, nested)
    if (kind.kind === 'object') {
      return Object.keys(kind.properties)
        .sort()
        .some((name) => walk(kind.properties[name] as Schema, nested))
    }
    return false
  }
  return walk(schema, new Set())
}

export interface BuildRequestInput {
  operation: Operation
  status: number
  key: string
  params: Record<string, string>
  schema: Schema
  compiler: Compiler
  schemaNames: Map<Schema, string>
  example?: unknown
  persona?: string
}

/** Returns undefined when the schema cannot be sent to a source at all. */
export function buildRequest(input: BuildRequestInput): FixtureRequest | undefined {
  if (isRecursive(input.schema)) return undefined
  const zodSchema = input.compiler.compile(input.schema)
  let jsonSchema: Record<string, unknown>
  try {
    jsonSchema = z.toJSONSchema(zodSchema) as Record<string, unknown>
  } catch {
    // A schema zod cannot express as JSON Schema is a miss, not an error.
    return undefined
  }
  return {
    operationId: operationSlug(input.operation),
    method: input.operation.method,
    path: input.operation.path,
    status: input.status,
    key: input.key,
    params: input.params,
    jsonSchema,
    zodSchema,
    summary: input.operation.summary,
    description: input.operation.description,
    example: input.example,
    persona: input.persona
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 5 new tests.

- [ ] **Step 5: Verify by mutation**

Delete the `seen.has(node)` early return in `isRecursive` and confirm the two
recursion tests hang or fail - if they hang, that is itself the signal. Remove
the `jsonSchema` field and confirm the both-representations test fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/source.ts test/fixtures/source.test.ts
```

```sh
git commit -m 'feat: define the provider interface and build fixture requests' -m 'FixtureRequest carries both the compiled zod schema and a plain JSON Schema, so a source for another provider needs no mockingham or zod internals.'
```

---

## Task 8: The OpenAI-compatible source

**Files:**
- Create: `src/fixtures/sources/openai.ts`
- Test: `test/fixtures/sources/openai.test.ts`

**Interfaces:**
- Consumes: `ContentSource`, `FixtureRequest`, `FixtureResult` from `src/fixtures/source.ts`.
- Produces: `createOpenAiSource(options: OpenAiSourceOptions): ContentSource` where
  `interface OpenAiSourceOptions { baseUrl: string; model: string; apiKey?: string; structuredOutput?: 'json_schema' | 'json_object' | 'none'; fetch?: typeof fetch; timeoutMs?: number }`.

This source is tested **at the wire**, against the injected `fetch`. It is the
only source that gets that treatment, and it is why it is the default.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/sources/openai.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createOpenAiSource } from '../../../src/fixtures/sources/openai.ts'
import type { FixtureRequest } from '../../../src/fixtures/source.ts'

function request(overrides: Partial<FixtureRequest> = {}): FixtureRequest {
  return {
    operationId: 'getUser',
    method: 'get',
    path: '/users/{id}',
    status: 200,
    key: 'a3f19c2e',
    params: { id: '42' },
    jsonSchema: { type: 'object', properties: { bio: { type: 'string' } } },
    zodSchema: z.object({ bio: z.string() }),
    persona: 'B2B logistics SaaS',
    ...overrides
  }
}

function reply(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

test('json_schema mode sends a strict response_format and returns the value', async () => {
  const seen: { url?: string; body?: Record<string, unknown> } = {}
  const source = createOpenAiSource({
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.3',
    fetch: async (url, init) => {
      seen.url = String(url)
      seen.body = JSON.parse(String(init?.body))
      return reply({ bio: 'ships containers' })
    }
  })

  const [result] = await source.generate([request()])
  assert.deepEqual(result?.value, { bio: 'ships containers' })
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions')
  const format = seen.body?.response_format as { type: string; json_schema: { strict: boolean } }
  assert.equal(format.type, 'json_schema')
  assert.equal(format.json_schema.strict, true)
  assert.equal(seen.body?.model, 'llama3.3')
})

test('json_object mode sends the simpler format and carries the schema in the prompt', async () => {
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    structuredOutput: 'json_object',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.deepEqual(body.response_format, { type: 'json_object' })
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.match(messages[1]?.content as string, /"type": ?"object"/)
})

test('none mode sends no response_format at all', async () => {
  let body: Record<string, unknown> = {}
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    structuredOutput: 'none',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.equal('response_format' in body, false)
})

test('an authorization header is sent only when an api key is configured', async () => {
  const headers: Array<string | null> = []
  const capture = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    headers.push(new Headers(init?.headers).get('authorization'))
    return reply({ bio: 'ok' })
  }
  await createOpenAiSource({ baseUrl: 'http://x/v1', model: 'm', fetch: capture })
    .generate([request()])
  await createOpenAiSource({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'sk-test', fetch: capture })
    .generate([request()])
  assert.deepEqual(headers, [null, 'Bearer sk-test'])
})

test('a response failing schema validation retries once, then misses', async () => {
  let calls = 0
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => {
      calls += 1
      return reply({ bio: 42 })
    }
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
  assert.equal(calls, 2)
})

test('a valid response on the retry is returned', async () => {
  let calls = 0
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply({ bio: 42 }) : reply({ bio: 'second time' })
    }
  })
  const [result] = await source.generate([request()])
  assert.deepEqual(result?.value, { bio: 'second time' })
})

test('malformed json is a miss, not a throw', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{ not json' } }] }))
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('an http 500 is a miss, not a throw', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => new Response('upstream is unhappy', { status: 500 })
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('a rejected fetch is a miss, not a throw', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async () => {
      throw new Error('connection refused')
    }
  })
  const [result] = await source.generate([request()])
  assert.equal(result, null)
})

test('results are positionally aligned with the requests', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'm',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = (body.messages as Array<{ content: string }>)[1]?.content ?? ''
      return prompt.includes('"id":"1"') || prompt.includes('id=1')
        ? reply({ bio: 'first' })
        : reply({ bio: 'second' })
    }
  })
  const results = await source.generate([
    request({ key: 'k1', params: { id: '1' } }),
    request({ key: 'k2', params: { id: '2' } })
  ])
  assert.equal(results.length, 2)
  assert.deepEqual(results[0]?.value, { bio: 'first' })
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('the meta records the provider and model', async () => {
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1',
    model: 'llama3.3',
    fetch: async () => reply({ bio: 'ok' })
  })
  const [result] = await source.generate([request()])
  assert.equal(result?.meta?.source, 'openai-compatible')
  assert.equal(result?.meta?.model, 'llama3.3')
})

test('a trailing slash on the base url does not double the separator', async () => {
  let url = ''
  const source = createOpenAiSource({
    baseUrl: 'http://x/v1/',
    model: 'm',
    fetch: async (target) => {
      url = String(target)
      return reply({ bio: 'ok' })
    }
  })
  await source.generate([request()])
  assert.equal(url, 'http://x/v1/chat/completions')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/sources/openai.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/sources/openai.ts`:

```ts
import type { ContentSource, FixtureRequest, FixtureResult } from '../source.ts'

export interface OpenAiSourceOptions {
  /** For example `http://localhost:11434/v1` for Ollama. */
  baseUrl: string
  model: string
  apiKey?: string
  /**
   * What the server supports, declared rather than probed. A probe costs a
   * round trip on every cold start and its result is not deterministic -
   * design section 4.
   */
  structuredOutput?: 'json_schema' | 'json_object' | 'none'
  /** Injectable so the suite never reaches the network. */
  fetch?: typeof fetch
  timeoutMs?: number
}

const SYSTEM = [
  'You generate realistic sample data for an HTTP API mock.',
  'Return only the JSON value for the response body.',
  'Every field must be coherent with the others: names, emails, and companies',
  'must belong to the same fictional entity.'
].join(' ')

function promptFor(request: FixtureRequest, includeSchema: boolean): string {
  const lines = [
    `Operation: ${request.method.toUpperCase()} ${request.path}`,
    `Response status: ${request.status}`
  ]
  if (request.summary) lines.push(`Summary: ${request.summary}`)
  if (request.description) lines.push(`Description: ${request.description}`)
  if (Object.keys(request.params).length > 0) {
    // Sorted: the prompt must be byte-identical across processes so a cache
    // read is possible and a bake run is reproducible.
    const params = Object.keys(request.params)
      .sort()
      .map((name) => `${name}=${request.params[name]}`)
      .join(', ')
    lines.push(`Resolved path parameters (honor these exactly): ${params}`)
  }
  if (request.example !== undefined) {
    lines.push(`An example from the document: ${JSON.stringify(request.example)}`)
  }
  if (includeSchema) {
    lines.push(`The value must satisfy this JSON Schema: ${JSON.stringify(request.jsonSchema)}`)
  }
  return lines.join('\n')
}

export function createOpenAiSource(options: OpenAiSourceOptions): ContentSource {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const mode = options.structuredOutput ?? 'json_schema'
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = options.timeoutMs ?? 30_000

  const bodyFor = (request: FixtureRequest): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [
        { role: 'system', content: request.persona ? `${SYSTEM} Domain: ${request.persona}` : SYSTEM },
        { role: 'user', content: promptFor(request, mode !== 'json_schema') }
      ]
    }
    if (mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response_body', schema: request.jsonSchema, strict: true }
      }
    } else if (mode === 'json_object') {
      body.response_format = { type: 'json_object' }
    }
    return body
  }

  const attempt = async (request: FixtureRequest): Promise<FixtureResult | null> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`

    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyFor(request)),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') return null

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    // Validated in EVERY mode, including json_schema. A server that claims
    // strict support it does not have degrades to a miss here rather than
    // putting an off-contract body into the store.
    const checked = request.zodSchema.safeParse(parsed)
    if (!checked.success) return null

    return {
      value: checked.data,
      meta: { source: 'openai-compatible', model: options.model, promptVersion: 1 }
    }
  }

  const once = async (request: FixtureRequest): Promise<FixtureResult | null> => {
    // Invariant 4: every failure mode here is a miss. Nothing this source does
    // may stop the mock from serving.
    try {
      const first = await attempt(request)
      if (first) return first
      return await attempt(request)
    } catch {
      return null
    }
  }

  return {
    // Sequential rather than concurrent. The driver owns concurrency and its
    // budget; a source that fanned out independently would make maxConcurrency
    // a lie.
    async generate(reqs) {
      const out: (FixtureResult | null)[] = []
      for (const request of reqs) out.push(await once(request))
      return out
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 12 new tests.

- [ ] **Step 5: Verify by mutation**

Remove the `safeParse` check and confirm `a response failing schema validation
retries once, then misses` fails. Change `once` to a single `attempt` and
confirm the retry count assertion fails. Remove the `try/catch` in `once` and
confirm `a rejected fetch is a miss` fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/sources/openai.ts test/fixtures/sources/openai.test.ts
```

```sh
git commit -m 'feat: add the OpenAI-compatible content source' -m 'The default provider. Zero dependencies, fetch and JSON, so Ollama, llama.cpp, vLLM, and LM Studio all work offline.' -m 'Tested at the wire against the injected fetch rather than stubbed at ContentSource, so request shaping and response parsing are covered without network.'
```

---

## Task 9: The bake driver

**Files:**
- Create: `src/fixtures/bake.ts`
- Test: `test/fixtures/bake.test.ts`

**Interfaces:**
- Consumes: `ContentSource`, `FixtureRequest`, `FixtureResult`, `buildRequest` from `src/fixtures/source.ts`; `FixtureStore` from `src/fixtures/store.ts`; `fixtureKey`, `operationSlug` from `src/fixtures/key.ts`; `isScoped`, `narrow` from `src/fixtures/scope.ts`; `Compiler` from `src/schema/compile.ts`.
- Produces: `bake(options: BakeOptions): Promise<BakeSummary>` where
  `interface BakeSummary { generated: number; skipped: number; refused: number; failed: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/bake.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bake } from '../../src/fixtures/bake.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { ContentSource, FixtureResult } from '../../src/fixtures/source.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'object', properties: { bio: { type: 'string' } } }
                }
              }
            }
          },
          '404': {
            description: 'gone',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

function sourceReturning(value: unknown): ContentSource {
  return { generate: async (reqs) => reqs.map(() => ({ value }) as FixtureResult) }
}

test('bake fills the store for every declared status', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  assert.equal(summary.generated, 2)
  assert.equal(store.records().length, 2)
})

test('error statuses are baked too - they have declared schemas', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  assert.ok(store.records().some((r) => r.status === 404))
})

test('a null result counts as failed and stores nothing', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map(() => null) },
    compiler: createCompiler(),
    now: () => 1_000
  })
  assert.equal(summary.failed, 2)
  assert.equal(store.records().length, 0)
})

test('a throwing source reaches onError and stores nothing', async () => {
  const store = createMemoryFixtureStore()
  const errors: unknown[] = []
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: { generate: async () => { throw new Error('provider down') } },
    compiler: createCompiler(),
    now: () => 1_000,
    onError: (error) => errors.push(error)
  })
  assert.equal(store.records().length, 0)
  assert.equal(summary.failed, 2)
  assert.equal(errors.length > 0, true)
})

test('maxCalls stops the walk and counts the rest as skipped', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: sourceReturning([{ bio: 'a' }]),
    compiler: createCompiler(),
    now: () => 1_000,
    budget: { maxCalls: 1, maxConcurrency: 1 }
  })
  assert.equal(summary.generated, 1)
  assert.equal(summary.skipped, 1)
})

test('the stored meta records the injected clock, not wall time', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_700_000_000_000
  })
  const record = store.records()[0]
  assert.equal(record?.entry.meta?.generatedAt, new Date(1_700_000_000_000).toISOString())
})

test('a scoped config stores only the scoped paths', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: { generate: async (reqs) => reqs.map((r) => ({
      value: r.status === 200 ? [{ bio: 'a', extra: 'dropped' }] : { message: 'gone' }
    })) },
    compiler: createCompiler(),
    now: () => 1_000,
    scope: { byName: ['bio'] }
  })
  const ok = store.records().find((r) => r.status === 200)
  assert.deepEqual(ok?.entry.value, [{ bio: 'a' }])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/bake.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/bake.ts`:

```ts
import type { Api, Schema } from '../spec/types.ts'
import type { Compiler } from '../schema/compile.ts'
import { fixtureKey, operationSlug } from './key.ts'
import { isScoped, narrow } from './scope.ts'
import type { ScopeConfig } from './scope.ts'
import { buildRequest } from './source.ts'
import type { ContentSource, FixtureRequest } from './source.ts'
import type { FixtureStore } from './store.ts'

const JSON_TYPE = 'application/json'

export interface BakeBudget {
  maxCalls?: number
  maxConcurrency?: number
  timeoutMs?: number
}

export interface BakeOptions {
  api: Api
  store: FixtureStore
  source: ContentSource
  compiler: Compiler
  persona?: string
  scope?: ScopeConfig
  budget?: BakeBudget
  now: () => number
  onWarn?: (message: string) => void
  onError?: (error: unknown) => void
}

export interface BakeSummary {
  generated: number
  /** Not attempted: recursive, no JSON body, or over the call budget. */
  skipped: number
  refused: number
  /** Attempted and came back null, invalid, or throwing. */
  failed: number
}

export async function bake(options: BakeOptions): Promise<BakeSummary> {
  const summary: BakeSummary = { generated: 0, skipped: 0, refused: 0, failed: 0 }
  const budget = options.budget ?? {}
  const concurrency = Math.max(1, budget.maxConcurrency ?? 4)

  const planned: Array<{ request: FixtureRequest; schema: Schema }> = []

  for (const operation of options.api.operations) {
    const responses = [...operation.responses].sort((a, b) => a.status - b.status)
    for (const response of responses) {
      const media = response.content[JSON_TYPE]
      if (!media) {
        summary.skipped += 1
        continue
      }
      const request = buildRequest({
        operation,
        status: response.status,
        key: fixtureKey({ method: operation.method, path: operation.path, params: {} }),
        params: {},
        schema: media.schema,
        compiler: options.compiler,
        schemaNames: options.api.schemaNames,
        example: media.example,
        persona: options.persona
      })
      if (!request) {
        // Recursive, or not expressible as JSON Schema. Generator-only.
        options.onWarn?.(
          `mockingham: ${operation.method.toUpperCase()} ${operation.path} ` +
            `status ${response.status} cannot be sent to a content source; ` +
            'it will always be generated'
        )
        summary.skipped += 1
        continue
      }
      planned.push({ request, schema: media.schema })
    }
  }

  const limit = budget.maxCalls ?? planned.length
  const attempted = planned.slice(0, limit)
  summary.skipped += planned.length - attempted.length

  const generatedAt = new Date(options.now()).toISOString()

  for (let start = 0; start < attempted.length; start += concurrency) {
    const chunk = attempted.slice(start, start + concurrency)
    let results: Array<{ value: unknown; meta?: Record<string, unknown> } | null>
    try {
      results = (await options.source.generate(chunk.map((item) => item.request))) as typeof results
    } catch (error) {
      // Invariant 4 again: a provider that throws costs us the chunk, not the run.
      options.onError?.(error)
      summary.failed += chunk.length
      continue
    }

    for (let index = 0; index < chunk.length; index++) {
      const item = chunk[index] as { request: FixtureRequest; schema: Schema }
      const result = results[index]
      if (!result) {
        summary.failed += 1
        continue
      }

      let value = result.value
      if (isScoped(options.scope)) {
        value = narrow(value, item.schema, options.scope as ScopeConfig, options.api.schemaNames)
        if (value === undefined) {
          summary.failed += 1
          continue
        }
      }

      options.store.set(item.request.operationId, item.request.status, item.request.key, {
        value,
        meta: { ...(result.meta ?? {}), generatedAt }
      })
      summary.generated += 1
    }
  }

  return summary
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 7 new tests.

- [ ] **Step 5: Verify by mutation**

Remove the `try/catch` around `source.generate` and confirm `a throwing source
reaches onError` fails. Change `planned.slice(0, limit)` to `planned` and confirm
the `maxCalls` test fails. Replace `options.now()` with `Date.now()` and confirm
the clock test fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/bake.ts test/fixtures/bake.test.ts
```

```sh
git commit -m 'feat: add the bake driver' -m 'Walks operations by declared status, error statuses included, in bounded concurrent chunks. Every failure mode counts and continues rather than stopping the run.'
```

---

## Task 10: Fixture resolution and the handler seam

**Files:**
- Create: `src/fixtures/resolve.ts`
- Modify: `src/server/handler.ts`
- Test: `test/fixtures/resolve.test.ts`, `test/server/fixtures.test.ts`

**Interfaces:**
- Consumes: everything from tasks 1–9.
- Produces: `createFixtureResolver(input: ResolverInput): FixtureResolver` where
  `interface FixtureResolver { resolve(operation: Operation, status: number, params: Record<string, string>): Promise<ResolvedFixture | undefined> }`
  and `interface ResolvedFixture { whole?: unknown; layer?: unknown }`.
  `HandlerOptions` gains `fixtures?: { store?: FixtureStore }` and `llm?: ResolvedLlm`.

- [ ] **Step 1: Write the failing test**

Create `test/server/fixtures.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { fixtureKey } from '../../src/fixtures/key.ts'
import type { ContentSource } from '../../src/fixtures/source.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, bio: { type: 'string' } },
                  required: ['id', 'bio']
                }
              }
            }
          }
        }
      }
    }
  }
}

function keyFor(id: string): string {
  return fixtureKey({ method: 'get', path: '/users/{id}', params: { id } })
}

test('a whole-body fixture is served in place of generation', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), { fixtures: { store } })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await response.json(), { id: '42', bio: 'from the store' })
})

test('a fixture for a different request is not served', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), { fixtures: { store } })
  const response = await handler.fetch(new Request('https://x/users/43'))
  const body = (await response.json()) as { bio: string }
  assert.notEqual(body.bio, 'from the store')
})

test('changing the seed still reads the same fixture', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), { fixtures: { store }, seed: 'ci-run-7' })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await response.json(), { id: '42', bio: 'from the store' })
})

test('a user override beats a fixture', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    operations: { 'GET /users/{id}': { body: { bio: 'from the override' } } }
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  const body = (await response.json()) as { bio: string }
  assert.equal(body.bio, 'from the override')
})

test('no fixture and no llm leaves generation untouched', async () => {
  const handler = createHandler(loadApi(doc), {})
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.equal(response.status, 200)
})

test('lazy mode calls the source once and stores the result', async () => {
  const store = createMemoryFixtureStore()
  let calls = 0
  const source: ContentSource = {
    generate: async (reqs) => {
      calls += 1
      return reqs.map(() => ({ value: { id: '42', bio: 'lazily fetched' } }))
    }
  }
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  const first = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await first.json(), { id: '42', bio: 'lazily fetched' })
  const second = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await second.json(), { id: '42', bio: 'lazily fetched' })
  assert.equal(calls, 1)
})

test('lazy mode single-flights concurrent identical requests', async () => {
  const store = createMemoryFixtureStore()
  let calls = 0
  const source: ContentSource = {
    generate: async (reqs) => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return reqs.map(() => ({ value: { id: '42', bio: 'once' } }))
    }
  }
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  await Promise.all([
    handler.fetch(new Request('https://x/users/42')),
    handler.fetch(new Request('https://x/users/42'))
  ])
  assert.equal(calls, 1)
})

test('a lazy source that throws still serves a generated body', async () => {
  const errors: unknown[] = []
  const handler = createHandler(loadApi(doc), {
    fixtures: { store: createMemoryFixtureStore() },
    llm: {
      mode: 'lazy',
      source: { generate: async () => { throw new Error('down') } },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    },
    onError: (error) => errors.push(error)
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.equal(response.status, 200)
  assert.ok((await response.json()) !== null)
  assert.equal(errors.length, 1)
})

test('off mode never calls the source', async () => {
  let calls = 0
  const handler = createHandler(loadApi(doc), {
    fixtures: { store: createMemoryFixtureStore() },
    llm: {
      mode: 'off',
      source: { generate: async (reqs) => { calls += 1; return reqs.map(() => null) } },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  await handler.fetch(new Request('https://x/users/42'))
  assert.equal(calls, 0)
})

test('live mode calls the source on every request', async () => {
  let calls = 0
  const handler = createHandler(loadApi(doc), {
    fixtures: { store: createMemoryFixtureStore() },
    llm: {
      mode: 'live',
      source: {
        generate: async (reqs) => {
          calls += 1
          return reqs.map(() => ({ value: { id: '42', bio: `call ${calls}` } }))
        }
      },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  await handler.fetch(new Request('https://x/users/42'))
  await handler.fetch(new Request('https://x/users/42'))
  assert.equal(calls, 2)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /opt/claude-projects/mockingham/test/server/fixtures.test.ts`
Expected: FAIL - `fixtures` is not a valid `HandlerOptions` key and no fixture is served.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/resolve.ts`:

```ts
import type { Api, Operation, Schema } from '../spec/types.ts'
import type { Compiler } from '../schema/compile.ts'
import { fixtureKey, operationSlug } from './key.ts'
import { isScoped } from './scope.ts'
import type { ScopeConfig } from './scope.ts'
import { buildRequest } from './source.ts'
import type { ContentSource } from './source.ts'
import type { FixtureStore } from './store.ts'

const JSON_TYPE = 'application/json'

export interface ResolvedLlm {
  mode: 'off' | 'bake' | 'lazy' | 'live'
  source?: ContentSource
  persona?: string
  scope?: ScopeConfig
  budget: { maxCalls?: number; maxConcurrency: number; timeoutMs: number }
}

export interface ResolvedFixture {
  /** Replaces the body entirely, at the generate seam. */
  whole?: unknown
  /** Applied as the layer beneath the user's overrides. */
  layer?: unknown
}

export interface ResolverInput {
  api: Api
  store: FixtureStore
  compiler: Compiler
  llm?: ResolvedLlm
  now: () => number
  onError?: (error: unknown) => void
}

export interface FixtureResolver {
  resolve(
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): Promise<ResolvedFixture | undefined>
  /** Synchronous lookup for use inside a response callback - never fetches. */
  peek(
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): ResolvedFixture | undefined
}

export function createFixtureResolver(input: ResolverInput): FixtureResolver {
  const llm = input.llm
  const scoped = isScoped(llm?.scope)
  // Single-flight. One process, one map: two concurrent identical requests
  // share a fetch rather than making two.
  const inFlight = new Map<string, Promise<unknown>>()
  let calls = 0

  const shape = (value: unknown): ResolvedFixture =>
    scoped ? { layer: value } : { whole: value }

  const lookup = (
    operation: Operation,
    status: number,
    params: Record<string, string>
  ): { id: string; key: string; schema?: Schema } => {
    const id = operationSlug(operation)
    const key = fixtureKey({ method: operation.method, path: operation.path, params })
    const schema = operation.responses.find((r) => r.status === status)
      ?.content[JSON_TYPE]?.schema
    return { id, key, schema }
  }

  const peek: FixtureResolver['peek'] = (operation, status, params) => {
    const { id, key } = lookup(operation, status, params)
    const entry = input.store.get(id, status, key)
    return entry === undefined ? undefined : shape(entry.value)
  }

  return {
    peek,

    async resolve(operation, status, params) {
      const { id, key, schema } = lookup(operation, status, params)

      if (llm?.mode !== 'live') {
        const entry = input.store.get(id, status, key)
        if (entry !== undefined) return shape(entry.value)
      }

      if (!llm || !llm.source) return undefined
      if (llm.mode !== 'lazy' && llm.mode !== 'live') return undefined
      if (schema === undefined) return undefined
      if (llm.budget.maxCalls !== undefined && calls >= llm.budget.maxCalls) {
        return undefined
      }

      const flightKey = `${id}|${status}|${key}`
      const existing = inFlight.get(flightKey)
      if (existing) {
        const value = await existing
        return value === undefined ? undefined : shape(value)
      }

      const request = buildRequest({
        operation,
        status,
        key,
        params,
        schema,
        compiler: input.compiler,
        schemaNames: input.api.schemaNames,
        persona: llm.persona
      })
      if (!request) return undefined

      calls += 1
      const flight = (async (): Promise<unknown> => {
        try {
          const [result] = await llm.source!.generate([request])
          if (!result) return undefined
          // live deliberately does not persist: it exists to vary every
          // response, and writing would turn the second request into a hit.
          if (llm.mode === 'lazy') {
            input.store.set(id, status, key, {
              value: result.value,
              meta: { ...(result.meta ?? {}), generatedAt: new Date(input.now()).toISOString() }
            })
          }
          return result.value
        } catch (error) {
          // Invariant 4. The caller falls through to seeded generation.
          input.onError?.(error)
          return undefined
        } finally {
          inFlight.delete(flightKey)
        }
      })()

      inFlight.set(flightKey, flight)
      const value = await flight
      return value === undefined ? undefined : shape(value)
    }
  }
}
```

In `src/server/handler.ts`:

1. Add the imports (`createFixtureResolver`, `type ResolvedLlm`, `createMemoryFixtureStore`, `type FixtureStore`, `createCompiler`).
2. Add to `HandlerOptions`:

```ts
  fixtures?: { store?: FixtureStore }
  /**
   * Already resolved - `createMock` validates the user-facing `LlmConfig` and
   * constructs the source. The handler only ever sees a `ContentSource`, which
   * keeps provider modules out of the pure core.
   */
  llm?: ResolvedLlm
```

3. In `createHandler`, after `const store = ...`:

```ts
  const fixtureStore = options.fixtures?.store ?? createMemoryFixtureStore()
  const fixtureResolver = createFixtureResolver({
    api,
    store: fixtureStore,
    compiler: createCompiler(),
    llm: options.llm,
    now,
    onError: (error) => reportError(options.onError, error)
  })
```

**Note for the implementer:** match however `reportError` is already called
elsewhere in this file; read its signature in `src/runtime/logging.ts` first.

4. In `produce()`, pass the synchronous peek into the responders so a response
callback can read baked fixtures:

```ts
      fixture: (status) => fixtureResolver.peek(operation, status, params)?.whole,
```

5. After status selection and before `renderResponse`, resolve for real:

```ts
    // After selection, because the fixture key is per status. Awaited here so
    // the generate seam below stays synchronous - design section 2.12.
    const fixture = await fixtureResolver.resolve(operation, chosen.status, params)
```

6. Pass the layer into `renderResponse`:

```ts
      fixtureLayer: fixture?.layer as OverrideNode | undefined,
```

7. Make the whole-body form reachable from the synchronous seam. The simplest
correct approach: hold the resolved value in a mutable local that the `fixture`
hook closes over.

```ts
    // Declared above `responders`; assigned after resolution, read by the hook
    // at generation time - the same deferral the `ctx` getter already uses.
    let resolvedWhole: unknown
```

and change the hook to:

```ts
      fixture: (status) =>
        resolvedWhole !== undefined && status === selectedStatus
          ? resolvedWhole
          : fixtureResolver.peek(operation, status, params)?.whole,
```

assigning `resolvedWhole = fixture?.whole` and `selectedStatus = chosen.status`
immediately after the `await`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 10 new tests, all existing tests still passing.

- [ ] **Step 5: Verify by mutation**

Delete the `inFlight` map and confirm `lazy mode single-flights concurrent
identical requests` fails. Change `llm?.mode !== 'live'` to `true` and confirm
`live mode calls the source on every request` fails. Add the seed to
`fixtureKey`'s input and confirm `changing the seed still reads the same
fixture` fails. Remove the `try/catch` and confirm `a lazy source that throws
still serves a generated body` fails. Restore each.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/resolve.ts src/server/handler.ts test/server/fixtures.test.ts
```

```sh
git commit -m 'feat: resolve fixtures in the request pipeline' -m 'Resolution runs after status selection so it can await a lazy fetch, leaving the generate seam synchronous. A response callback reads baked fixtures through a synchronous peek but never triggers a fetch.' -m 'Lazy is single-flighted; live deliberately does not persist.'
```

---

## Task 11: Configuration and provider resolution

**Files:**
- Create: `src/fixtures/config.ts`
- Modify: `src/index.ts`
- Test: `test/fixtures/config.test.ts`

**Interfaces:**
- Consumes: `createOpenAiSource`, `createAnthropicSource`, `ResolvedLlm`.
- Produces: `interface LlmConfig`, `resolveLlm(config: LlmConfig | undefined, deps: { fetch?: typeof fetch }): ResolvedLlm | undefined`.
  `MockOptions` gains `llm?: LlmConfig` and `fixtures?: { store?: FixtureStore }`.
  `Mock` gains `bake(): Promise<BakeSummary>`.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLlm } from '../../src/fixtures/config.ts'

test('no config resolves to undefined', () => {
  assert.equal(resolveLlm(undefined, {}), undefined)
})

test('off mode needs no provider configuration', () => {
  const resolved = resolveLlm({ mode: 'off' }, {})
  assert.equal(resolved?.mode, 'off')
  assert.equal(resolved?.source, undefined)
})

test('an llm mode without a base url fails loudly', () => {
  assert.throws(
    () => resolveLlm({ mode: 'bake' }, {}),
    /baseUrl/
  )
})

test('the default provider is openai-compatible', () => {
  const resolved = resolveLlm(
    { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm' } },
    {}
  )
  assert.ok(resolved?.source)
})

test('an explicit source wins over the provider', () => {
  const source = { generate: async () => [] }
  const resolved = resolveLlm({ mode: 'bake', source }, {})
  assert.equal(resolved?.source, source)
})

test('an unknown key fails validation', () => {
  assert.throws(
    () => resolveLlm({ mode: 'bake', bassUrl: 'typo' } as never, {}),
    /bassUrl|unrecognized/i
  )
})

test('an anthropic option in the openai block fails validation', () => {
  assert.throws(
    () =>
      resolveLlm(
        { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm', batchThreshold: 10 } } as never,
        {}
      ),
    /batchThreshold|unrecognized/i
  )
})

test('budget defaults are filled in', () => {
  const resolved = resolveLlm(
    { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm' } },
    {}
  )
  assert.equal(resolved?.budget.maxConcurrency, 4)
  assert.equal(resolved?.budget.timeoutMs, 30_000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/config.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/config.ts`:

```ts
import { z } from 'zod'
import { createOpenAiSource } from './sources/openai.ts'
import type { ContentSource } from './source.ts'
import type { ResolvedLlm } from './resolve.ts'

const scopeSchema = z
  .object({ byName: z.array(z.string()).optional(), bySchema: z.array(z.string()).optional() })
  .strict()

const configSchema = z
  .object({
    mode: z.enum(['off', 'bake', 'lazy', 'live']).optional(),
    provider: z.enum(['openai-compatible', 'anthropic']).optional(),
    source: z.custom<ContentSource>((v) => typeof (v as ContentSource)?.generate === 'function').optional(),
    persona: z.string().optional(),
    scope: scopeSchema.optional(),
    budget: z
      .object({
        maxCalls: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional()
      })
      .strict()
      .optional(),
    openai: z
      .object({
        baseUrl: z.string(),
        model: z.string(),
        apiKey: z.string().optional(),
        structuredOutput: z.enum(['json_schema', 'json_object', 'none']).optional()
      })
      .strict()
      .optional(),
    anthropic: z
      .object({
        model: z.string().optional(),
        apiKey: z.string().optional(),
        batchThreshold: z.number().int().positive().optional()
      })
      .strict()
      .optional()
  })
  // Strict throughout: a key in the wrong provider block must fail rather than
  // silently do nothing. Master spec section 16.
  .strict()

export type LlmConfig = z.input<typeof configSchema>

export function resolveLlm(
  config: LlmConfig | undefined,
  deps: { fetch?: typeof fetch }
): ResolvedLlm | undefined {
  if (config === undefined) return undefined
  const parsed = configSchema.parse(config)
  const mode = parsed.mode ?? 'off'
  const budget = {
    maxCalls: parsed.budget?.maxCalls,
    maxConcurrency: parsed.budget?.maxConcurrency ?? 4,
    timeoutMs: parsed.budget?.timeoutMs ?? 30_000
  }

  const base = { mode, persona: parsed.persona, scope: parsed.scope, budget }

  if (parsed.source) return { ...base, source: parsed.source }
  if (mode === 'off') return base

  const provider = parsed.provider ?? 'openai-compatible'

  if (provider === 'openai-compatible') {
    if (!parsed.openai?.baseUrl) {
      throw new Error(
        'mockingham: llm.openai.baseUrl is required when an llm mode is set. ' +
          'For a local model try http://localhost:11434/v1, or pass llm.source directly.'
      )
    }
    return {
      ...base,
      source: createOpenAiSource({
        baseUrl: parsed.openai.baseUrl,
        model: parsed.openai.model,
        apiKey: parsed.openai.apiKey,
        structuredOutput: parsed.openai.structuredOutput,
        fetch: deps.fetch,
        timeoutMs: budget.timeoutMs
      })
    }
  }

  // Anthropic is constructed in task 13; until then this branch throws with the
  // install instruction the master spec specifies.
  throw new Error(
    'mockingham: provider "anthropic" requires @anthropic-ai/sdk. ' +
      'Install it, or use the default openai-compatible provider.'
  )
}
```

In `src/index.ts`: add `llm?: LlmConfig` and `fixtures?: { store?: FixtureStore }`
to `MockOptions` (which currently aliases `HandlerOptions` - change it to an
interface extending `Omit<HandlerOptions, 'llm'>`), call `resolveLlm` before
`createHandler`, pass the result through, and add `bake()` to the `Mock` surface
delegating to the `bake` driver with the same store, source, and compiler.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 8 new tests.

- [ ] **Step 5: Verify by mutation**

Remove one `.strict()` and confirm the corresponding unknown-key test fails.
Remove the `baseUrl` guard and confirm `an llm mode without a base url fails
loudly` fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/config.ts src/index.ts test/fixtures/config.test.ts
```

```sh
git commit -m 'feat: validate llm configuration and resolve the provider' -m 'Per-provider blocks are strict, so an option in the wrong block fails at construction rather than being ignored. baseUrl has no default in the core; the CLI supplies one.'
```

---

## Task 12: The bake CLI subcommand

**Files:**
- Modify: `src/server/cli.ts`
- Test: `test/server/cli.test.ts` (extend)

**Interfaces:**
- Consumes: `bake`, `resolveLlm`, `createDiskFixtureStore`.
- Produces: `mockingham bake <document> [--base-url U] [--model M] [--fixtures DIR] [--persona P]`.

- [ ] **Step 1: Write the failing test**

Append to `test/server/cli.test.ts` - match the existing style for invoking the
CLI in that file:

```ts
test('bake resolves the base url from the environment with an ollama default', () => {
  assert.equal(
    resolveBakeTarget({}, {}),
    'http://localhost:11434/v1'
  )
  assert.equal(
    resolveBakeTarget({}, { OPENAI_BASE_URL: 'http://elsewhere/v1' }),
    'http://elsewhere/v1'
  )
  assert.equal(
    resolveBakeTarget({}, { MOCKINGHAM_LLM_BASE_URL: 'http://wins/v1', OPENAI_BASE_URL: 'http://loses/v1' }),
    'http://wins/v1'
  )
  assert.equal(
    resolveBakeTarget({ baseUrl: 'http://flag/v1' }, { MOCKINGHAM_LLM_BASE_URL: 'http://env/v1' }),
    'http://flag/v1'
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /opt/claude-projects/mockingham/test/server/cli.test.ts`
Expected: FAIL - `resolveBakeTarget` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/server/cli.ts`, export the resolution helper and add the subcommand:

```ts
/**
 * Environment reads live here and nowhere else - the pure core takes an
 * explicit baseUrl. The Ollama default is what makes `mockingham bake doc.json`
 * work with no configuration at all.
 */
export function resolveBakeTarget(
  flags: { baseUrl?: string },
  env: Record<string, string | undefined>
): string {
  return (
    flags.baseUrl ??
    env.MOCKINGHAM_LLM_BASE_URL ??
    env.OPENAI_BASE_URL ??
    'http://localhost:11434/v1'
  )
}
```

Then wire a `bake` branch that loads the document, builds a disk fixture store at
`--fixtures` (default `.mockingham/fixtures`), calls `resolveLlm` with
`mode: 'bake'` and the resolved base URL and model
(`--model` ?? `MOCKINGHAM_LLM_MODEL` ?? `OPENAI_MODEL`, and error clearly if
absent), runs `bake(...)`, flushes the store, and prints the summary.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 1 new test.

- [ ] **Step 5: Verify by mutation**

Reorder `MOCKINGHAM_LLM_BASE_URL` and `OPENAI_BASE_URL` and confirm the
precedence assertion fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/server/cli.ts test/server/cli.test.ts
```

```sh
git commit -m 'feat: add the bake subcommand' -m 'Environment reads and the Ollama default live in the CLI, never in the pure core.'
```

---

## Task 13: The Anthropic source, single-call path

**Files:**
- Create: `src/fixtures/sources/anthropic.ts`
- Modify: `src/fixtures/config.ts`
- Test: `test/fixtures/sources/anthropic.test.ts`

**Interfaces:**
- Produces: `createAnthropicSource(options: AnthropicSourceOptions): ContentSource` where
  `interface AnthropicSourceOptions { model?: string; apiKey?: string; batchThreshold?: number; timeoutMs?: number; client?: AnthropicLike }`.
  `AnthropicLike` is the narrow structural type the source actually uses, so a
  test can supply one without the SDK installed.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/sources/anthropic.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createAnthropicSource } from '../../../src/fixtures/sources/anthropic.ts'
import type { FixtureRequest } from '../../../src/fixtures/source.ts'

function request(key: string): FixtureRequest {
  return {
    operationId: 'getUser', method: 'get', path: '/users/{id}', status: 200,
    key, params: {}, jsonSchema: { type: 'object' },
    zodSchema: z.object({ bio: z.string() })
  }
}

test('a parsed response becomes a result', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.deepEqual(result?.value, { bio: 'ok' })
  assert.equal(result?.meta?.source, 'anthropic')
})

test('a refusal is a miss, and a null stop_details does not throw', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'refusal', stop_details: null, parsed_output: null }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('a null parsed_output is a miss', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: null }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('a value failing schema validation is a miss', async () => {
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: { bio: 42 } }),
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  const [result] = await source.generate([request('k')])
  assert.equal(result, null)
})

test('the single-call path sends fallbacks and the effort setting', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    client: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          sent = params
          return { stop_reason: 'end_turn', parsed_output: { bio: 'ok' } }
        },
        batches: { create: async () => ({ id: 'b' }), retrieve: async () => ({}), results: async function* () {} }
      }
    }
  })
  await source.generate([request('k')])
  assert.equal(sent.fallbacks, 'default')
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01'])
  const output = sent.output_config as { effort: string; format: unknown }
  assert.equal(output.effort, 'low')
  assert.ok(output.format)
  assert.equal(sent.model, 'claude-opus-5')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/sources/anthropic.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/sources/anthropic.ts`. The module must not import the SDK at
top level; it imports lazily inside the call, and accepts an injected `client`
so tests need no dependency.

Key points the implementation must honor:

- `model` defaults to `'claude-opus-5'`.
- `output_config: { format: zodOutputFormat(request.zodSchema), effort: 'low' }`
  (`format` and `effort` are siblings; design 2.8).
- `thinking` is left at its default (adaptive) and `max_tokens` is set to
  `16000`, sized for thinking plus body (design 2.7).
- The system block carries `cache_control: { type: 'ephemeral' }` and combines
  the stable instructions with the persona, so the prefix has a chance of
  clearing the 512-token minimum.
- Single-call path only: `fallbacks: 'default'` with
  `betas: ['server-side-fallback-2026-07-01']`.
- Branch on `stop_reason === 'refusal'` **before** reading content, and never on
  the presence of `stop_details` (design 2.10).
- A null `parsed_output` is a miss.
- Validate with `request.zodSchema.safeParse` regardless; a failure is a miss.
- Everything is wrapped so a throw becomes all-nulls.
- `meta` is `{ source: 'anthropic', model, promptVersion: 1 }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 5 new tests.

- [ ] **Step 5: Verify by mutation**

Read `parsed_output` before checking `stop_reason` and confirm the refusal test
fails. Remove `effort` from `output_config` and confirm the shape test fails.
Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/sources/anthropic.ts src/fixtures/config.ts test/fixtures/sources/anthropic.test.ts
```

```sh
git commit -m 'feat: add the Anthropic content source' -m 'Lazily imported optional peer dependency. Branches on stop_reason before reading content, because stop_details can be null on a genuine refusal.'
```

---

## Task 14: The Anthropic batch path

**Files:**
- Modify: `src/fixtures/sources/anthropic.ts`
- Test: `test/fixtures/sources/anthropic.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/fixtures/sources/anthropic.test.ts`:

```ts
test('above the threshold the batch path runs and results realign by custom_id', async () => {
  // Deliberately returned in reverse order - the API makes no ordering promise,
  // and getting this wrong attaches the wrong body to the wrong request with no
  // error at all. Design section 2.6.
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('the batch path must not call parse') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            yield { custom_id: 'k2', result: { type: 'succeeded', message: { parsed_output: { bio: 'second' } } } }
            yield { custom_id: 'k1', result: { type: 'succeeded', message: { parsed_output: { bio: 'first' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.deepEqual(results[0]?.value, { bio: 'first' })
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('a batch entry with no result is a miss, not a shift', async () => {
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            yield { custom_id: 'k2', result: { type: 'succeeded', message: { parsed_output: { bio: 'second' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('an errored batch entry is a miss', async () => {
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async () => ({ id: 'batch_1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {
            yield { custom_id: 'k1', result: { type: 'errored', error: {} } }
            yield { custom_id: 'k2', result: { type: 'succeeded', message: { parsed_output: { bio: 'second' } } } }
          }
        }
      }
    }
  })
  const results = await source.generate([request('k1'), request('k2')])
  assert.equal(results[0], null)
  assert.deepEqual(results[1]?.value, { bio: 'second' })
})

test('the batch path does not send fallbacks', async () => {
  let sent: Record<string, unknown> = {}
  const source = createAnthropicSource({
    batchThreshold: 2,
    client: {
      messages: {
        parse: async () => { throw new Error('unused') },
        batches: {
          create: async (params: Record<string, unknown>) => {
            sent = params
            return { id: 'batch_1' }
          },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async function* () {}
        }
      }
    }
  })
  await source.generate([request('k1'), request('k2')])
  const requests = sent.requests as Array<{ params: Record<string, unknown> }>
  // fallbacks is rejected on the Batches API - design section 2.5.
  assert.equal('fallbacks' in (requests[0]?.params ?? {}), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test /opt/claude-projects/mockingham/test/fixtures/sources/anthropic.test.ts`
Expected: FAIL - the batch path does not exist; `parse` is called and throws.

- [ ] **Step 3: Write the implementation**

Extend the source: when `reqs.length >= batchThreshold` (default `20`), build one
`requests` array with `custom_id` set to each `FixtureRequest.key`, create the
batch, poll `retrieve` until `processing_status === 'ended'` (using the injected
timeout as an overall deadline), stream `results()` into a
`Map<string, FixtureResult | null>` keyed by `custom_id`, then map the original
`reqs` array through that map so the returned array is positionally aligned. A
missing or errored entry is `null`. Each per-request `params` object omits
`fallbacks` and `betas`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Verify by mutation**

Replace the `custom_id` map lookup with positional indexing into the yielded
results and confirm `results realign by custom_id` fails. Add `fallbacks:
'default'` to the per-request params and confirm the last test fails. Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/sources/anthropic.ts test/fixtures/sources/anthropic.test.ts
```

```sh
git commit -m 'feat: add the Anthropic batch path' -m 'Results are keyed by custom_id and realigned positionally. The API makes no ordering promise, and positional indexing would attach the wrong body to the wrong request with no error at all.' -m 'The batch path omits fallbacks, which the Batches API rejects.'
```

---

## Task 15: The recorded source

**Files:**
- Create: `src/fixtures/sources/recorded.ts`
- Test: `test/fixtures/sources/recorded.test.ts`

**Interfaces:**
- Produces: `createRecordedSource(entries: RecordedEntry[]): ContentSource` where
  `interface RecordedEntry { operationId: string; status: number; value: unknown; key?: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/sources/recorded.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - cannot find module `src/fixtures/sources/recorded.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/fixtures/sources/recorded.ts`:

```ts
import type { ContentSource, FixtureRequest, FixtureResult } from '../source.ts'

export interface RecordedEntry {
  operationId: string
  status: number
  value: unknown
  /** When set, matches only that request. Otherwise matches any request. */
  key?: string
}

/**
 * Answers from responses recorded upstream. No network, no dependency - this
 * source only ever reads what it was handed.
 */
export function createRecordedSource(entries: RecordedEntry[]): ContentSource {
  const answer = (request: FixtureRequest): FixtureResult | null => {
    const matches = entries.filter(
      (entry) => entry.operationId === request.operationId && entry.status === request.status
    )
    // A key-specific entry wins over a general one, so a recording can pin one
    // request without losing the fallback for the rest.
    const chosen =
      matches.find((entry) => entry.key === request.key) ??
      matches.find((entry) => entry.key === undefined)
    if (!chosen) return null

    // Validated like every other source. A recording taken before the document
    // changed is a miss, not an off-contract body.
    const checked = request.zodSchema.safeParse(chosen.value)
    if (!checked.success) return null
    return { value: checked.data, meta: { source: 'recorded' } }
  }

  return { generate: async (reqs) => reqs.map(answer) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Verify by mutation**

Swap the two `matches.find` calls and confirm `a key-specific entry beats a
general one` fails. Remove the `safeParse` and confirm the last test fails.
Restore.

- [ ] **Step 6: Commit**

```sh
git add src/fixtures/sources/recorded.ts test/fixtures/sources/recorded.test.ts
```

```sh
git commit -m 'feat: add the recorded content source' -m 'Validates like every other source, so a recording taken before the document changed is a miss rather than an off-contract body.'
```

---

## Task 16: Staleness, determinism, and interface neutrality

**Files:**
- Modify: `src/fixtures/persist.ts` (staleness warning), `src/index.ts` (wire `onWarn`)
- Test: `test/fixtures/staleness.test.ts`, `test/fixtures/neutrality.test.ts`, `test/fixtures/determinism.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/fixtures/neutrality.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { bake } from '../../src/fixtures/bake.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import { loadApi } from '../../src/spec/load.ts'

// A source written the way a third-party author would write one: it reads
// FixtureRequest and returns FixtureResult, importing nothing from mockingham
// and nothing from zod. Design section 2.3 - if this stops compiling or stops
// working, the interface has become neutral in name only.
const foreignSource = {
  generate: async (reqs: Array<{ jsonSchema: Record<string, unknown>; status: number }>) =>
    reqs.map((request) => {
      const properties = (request.jsonSchema as { properties?: Record<string, unknown> })
        .properties ?? {}
      const value: Record<string, unknown> = {}
      for (const name of Object.keys(properties).sort()) value[name] = 'x'
      return { value }
    })
}

test('a source can be written against FixtureRequest alone', async () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/u': {
        get: {
          operationId: 'u',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { bio: { type: 'string' } } }
                }
              }
            }
          }
        }
      }
    }
  }
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: foreignSource as never,
    compiler: createCompiler(),
    now: () => 0
  })
  assert.equal(summary.generated, 1)
  assert.deepEqual(store.records()[0]?.entry.value, { bio: 'x' })
})
```

Create `test/fixtures/staleness.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { loadFixtures, warnOnStaleFixtures } from '../../src/fixtures/persist.ts'

test('a schemaHash mismatch warns once and the fixture is still served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mockingham-stale-'))
  await writeFile(
    join(dir, 'getUser.json'),
    JSON.stringify({ '200': { k: { value: { id: 1 }, meta: { schemaHash: 'old' } } } })
  )
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store)
  const warnings: string[] = []
  warnOnStaleFixtures(store, () => 'new', (m) => warnings.push(m))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser/)
  // Still there. Design section 2.13: warn, never reject.
  assert.deepEqual(store.get('getUser', 200, 'k')?.value, { id: 1 })
})

test('a hand-written fixture with no meta is never reported stale', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'k', { value: { id: 1 } })
  const warnings: string[] = []
  warnOnStaleFixtures(store, () => 'new', (m) => warnings.push(m))
  assert.equal(warnings.length, 0)
})

test('a matching schemaHash does not warn', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'k', { value: { id: 1 }, meta: { schemaHash: 'same' } })
  const warnings: string[] = []
  warnOnStaleFixtures(store, () => 'same', (m) => warnings.push(m))
  assert.equal(warnings.length, 0)
})
```

Create `test/fixtures/determinism.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { fixtureKey } from '../../src/fixtures/key.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/u': {
      get: {
        operationId: 'u',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { bio: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

// off and post-bake serving are fully deterministic. `lazy` is deterministic
// once warm. `live` is deliberately NOT deterministic - design section 2.11 -
// and is excluded here by design rather than by oversight.
test('a baked store serves byte-identical bodies across handler instances', async () => {
  const build = (): ReturnType<typeof createHandler> => {
    const store = createMemoryFixtureStore()
    store.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
      value: { bio: 'baked' }
    })
    return createHandler(loadApi(doc), { fixtures: { store } })
  }
  const one = await (await build().fetch(new Request('https://x/u'))).text()
  const two = await (await build().fetch(new Request('https://x/u'))).text()
  assert.equal(one, two)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: FAIL - `warnOnStaleFixtures` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/fixtures/persist.ts`:

```ts
/**
 * A schemaHash mismatch means the document moved under a generated fixture.
 * It warns and the fixture is STILL SERVED - design section 2.13. Rejecting it
 * would silently discard reviewed, committed, hand-edited data, which is the
 * opposite of what the store is for. `bake` is what regenerates it.
 *
 * A fixture with no meta is hand-written and is never reported.
 */
export function warnOnStaleFixtures(
  store: FixtureStore,
  hashFor: (operationId: string, status: number) => string | undefined,
  onWarn: (message: string) => void
): void {
  for (const record of store.records()) {
    const stored = record.entry.meta?.schemaHash
    if (stored === undefined) continue
    const current = hashFor(record.operationId, record.status)
    if (current === undefined || current === stored) continue
    onWarn(
      `mockingham: fixture ${record.operationId} status ${record.status} ` +
        'was generated against a different schema and may no longer match the ' +
        'document. Re-run bake to regenerate it.'
    )
  }
}
```

Wire it in `src/index.ts` after the store loads, hashing each operation's
response schema with `fnv1a(JSON.stringify(z.toJSONSchema(compiled)))`, and have
the bake driver write that same hash into `meta.schemaHash`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix /opt/claude-projects/mockingham`
Expected: PASS, 7 new tests.

- [ ] **Step 5: Verify by mutation**

Change `warnOnStaleFixtures` to delete the stale entry and confirm `the fixture
is still served` fails. Remove the `stored === undefined` guard and confirm the
hand-written test fails. Restore.

- [ ] **Step 6: Full verification and commit**

```sh
npx tsc --noEmit --project /opt/claude-projects/mockingham
```

```sh
npm test --prefix /opt/claude-projects/mockingham
```

```sh
grep -rn 'node:' /opt/claude-projects/mockingham/src
```

Expected from the grep: matches only in `src/server/node.ts`,
`src/server/cli.ts`, and `src/fixtures/persist.ts`. Anything else is an
invariant 3 violation and must be fixed before committing.

```sh
git add src/fixtures/persist.ts src/index.ts test/fixtures
```

```sh
git commit -m 'feat: warn on stale fixtures and pin determinism and neutrality' -m 'A schemaHash mismatch warns and the fixture is still served; rejecting it would discard reviewed hand-edited data. Fixtures with no meta are hand-written and never reported.' -m 'The determinism test covers off and post-bake serving and names live as excluded by design.'
```

---

## Self-Review Notes

**Spec coverage.** Every design section maps to a task: 2.1→1, 2.2→8+11, 2.3→7,
2.4→11+14, 2.5→14, 2.6→14, 2.7→13, 2.8→13, 2.9→8+13, 2.10→13, 2.11→10+16,
2.12→5+10, 2.13→16, 2.14→11. Section 3 architecture→1–7, section 4 config→11+12,
section 5 modes→9+10, section 6 sources→8+13+14+15, section 7 testing→every task
plus 16.

**Known gap, stated rather than hidden.** The design's §7 calls for a bake
summary field `unchanged`, which counts fixtures that were already current. This
plan's `BakeSummary` omits it, because deciding "unchanged" requires the schema
hash comparison that only lands in task 16. If the executor wants it, add it in
task 16 alongside `warnOnStaleFixtures` rather than retrofitting task 9.

**Integration coverage is thinner than unit coverage.** Task 10 covers the
handler seam end to end, but there is no test exercising a full
`createMock({ llm })` → `bake()` → serve cycle in one process. That is worth
adding during task 11 if it comes together cheaply; it is not worth blocking on.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-13-mockingham-fixtures-llm.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

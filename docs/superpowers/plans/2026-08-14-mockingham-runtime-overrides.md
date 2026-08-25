# mockingham Runtime Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Mock.override()` real - a runtime override, settable in-process
or over MCP, that layers on top of config overrides without introducing a second
precedence mechanism.

**Architecture:** Precedence already exists and is layer-ordered:
`render.ts` composes `[fixtureLayer, ...bodyOverrides]` and applies them in
sequence, which is what makes `override > fixture > example > generated` work
today. A runtime override takes one more slot in that array. State lives in the
Store, keyed per resolved operation, exactly as `failNext` and `outage` already
do - so a typo throws at call time, a wildcard arms every match, and `reset()`
clears overrides for free because it calls `store.clear()`.

**Tech Stack:** TypeScript run directly by Node 24's native type stripping,
`node:test`, `zod` (the only runtime dependency), `@modelcontextprotocol/sdk`
(optional peer, devDependency here).

**Spec:** `docs/superpowers/specs/2026-08-14-mockingham-runtime-overrides-design.md`
Read it before Task 1. The master contract is
`docs/superpowers/specs/2026-08-11-mockingham-design.md`; the delta wins where
they disagree.

## Global Constraints

- **Node >= 24.2.0**, ESM, **erasable syntax only**: no `enum`, no `namespace`,
  no parameter properties. Use `const X = {...} as const`.
- **The core stays pure.** `server/handler.ts` and everything it imports must
  not touch Node APIs. `runtime/overrides.ts` imports no `node:` module.
- **Determinism.** No `Math.random()`, no `Date.now()`, no iteration over an
  unordered `Set`/object in a generation path. Randomness comes from
  `generate/rng.ts`; time comes from the injected clock.
- **One schema interpretation.** Do not add a second traversal. A runtime
  override reuses `applyOverrides` through the existing layer array.
- **US English spelling** everywhere - `honor`, `behavior`, `serialize`,
  `normalize`, `canceled`.
- **One plain command per Bash call, with literal arguments.** No `&&`, `||`,
  `;`, pipes, `$(...)`, `VAR=value` prefixes, heredocs, `>` redirects, or `cd`.
  Use the Write tool for files. This is CLAUDE.md's shell contract.
- `git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy.
- Tests live in `test/` mirroring `src/`, TypeScript, run by `node:test`.
  Write the test first, watch it fail, then implement.
- `npm test` must stay green (952 tests before this plan); `npx tsc --noEmit`
  must stay clean.
- **The docs are executed by the suite.** Any guide you edit is run by
  `test/docs/docs.test.ts`, and its ```console fences are compared byte-for-byte.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/runtime/overrides.ts` | The key convention, the serializability check, and the read that shapes a stored override into the same view `resolveConfigs` returns |
| `test/runtime/overrides.test.ts` | Unit tests for that module |
| `test/mcp/override-tools.test.ts` | The two new MCP tools, gate open and closed |

**Modified:**

| File | Change |
|---|---|
| `src/server/handler.ts` | One store read after `resolveConfigs`; three composition points; the `x-mock-override` debug header |
| `src/index.ts` | `override()` and `clearOverrides()` on `Mock` |
| `src/mcp/tools/write.ts` | `set_override`, `clear_overrides`, added to `WRITE_TOOLS` |
| `src/mcp/context.ts` | Two members on `McpContext` and `McpContextSource` |
| `src/server/cli.ts` | `MCP_USAGE`'s write-tool list: five names to seven |
| `test/server/overrides.test.ts` | Runtime cases beside the existing config cases |
| `test/mcp/write.test.ts` | The two literal five-name arrays become seven |
| `docs/mcp.md` | Tool count, the two new tools, the deferred-tools section |
| `README.md` | The tour's mention of the control plane and deferred tools |
| `docs/superpowers/specs/2026-08-11-mockingham-design.md` | Remove the `NOT IMPLEMENTED` marker on `override()` |
| `docs/superpowers/deferred-items.md` | Close the entries this cycle resolves |

**Ordering rationale:** the module lands first, then the pipeline read (testable
end to end by writing directly to an injected Store), then the public methods
(which close the loop through `mock.override()` → `mock.fetch()`), then MCP,
then documentation. Every task after the first has an observable deliverable
through a real request.

---

## Task 1: The overrides module

**Files:**
- Create: `src/runtime/overrides.ts`
- Test: `test/runtime/overrides.test.ts`

**Interfaces:**
- Consumes: `targetKey(operation)` from `src/runtime/failure.ts`;
  `StatusConfig` from `src/runtime/config.ts`; `Store` from
  `src/runtime/store.ts`; `OverrideNode` from `src/runtime/types.ts`;
  `Operation` from `src/spec/types.ts`.
- Produces:
  - `type RuntimeOverride = { status?: number } & { [status: number]: StatusConfig }`
  - `overrideKey(key: string): string`
  - `assertSerializable(value: unknown, path?: string): void`
  - `interface ResolvedOverride { status?: number; bodies(forStatus: number): OverrideNode[]; headers(forStatus: number): Record<string, OverrideNode> }`
  - `const EMPTY_OVERRIDE: ResolvedOverride`
  - `overrideAsResolved(value: RuntimeOverride): ResolvedOverride`
  - `readOverride(store: Store, operation: Operation): Promise<ResolvedOverride>`

- [ ] **Step 1: Write the failing test**

Create `test/runtime/overrides.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  overrideKey,
  assertSerializable,
  overrideAsResolved,
  readOverride,
  EMPTY_OVERRIDE
} from '../../src/runtime/overrides.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { targetKey } from '../../src/runtime/failure.ts'
import type { Operation } from '../../src/spec/types.ts'

const operation = {
  method: 'get',
  path: '/payments/{id}',
  operationId: 'getPayment',
  tags: [],
  parameters: [],
  responses: [],
  callbacks: []
} as unknown as Operation

test('the key is namespaced and built from the operation target key', () => {
  // The writing side and the reading side must never spell this
  // independently - the reason failure.ts exports its key builders.
  assert.equal(overrideKey(targetKey(operation)), 'override|getPayment')
})

test('a function anywhere in the value is rejected, naming its path', () => {
  assert.throws(
    () => assertSerializable({ 200: { body: { total: () => 1 } } }),
    /value\.200\.body\.total is a function/
  )
})

test('a non-plain object is rejected - it would change type through a store', () => {
  assert.throws(
    () => assertSerializable({ 200: { body: { at: new Date(0) } } }),
    /value\.200\.body\.at/
  )
})

test('plain JSON data of every shape is accepted', () => {
  assertSerializable({
    status: 201,
    200: { body: { a: 1, b: 'two', c: true, d: null, e: [1, { f: 2 }] } }
  })
})

test('a cyclic value throws rather than hanging', () => {
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  assert.throws(() => assertSerializable(cyclic), /cycle/)
})

test('overrideAsResolved exposes body and headers scoped by status', () => {
  const resolved = overrideAsResolved({
    status: 201,
    200: { body: { ok: true }, headers: { 'x-a': '1' } }
  })
  assert.equal(resolved.status, 201)
  assert.deepEqual(resolved.bodies(200), [{ ok: true }])
  assert.deepEqual(resolved.headers(200), { 'x-a': '1' })
  assert.deepEqual(resolved.bodies(404), [], 'a different status contributes nothing')
  assert.deepEqual(resolved.headers(404), {})
})

test('readOverride returns the shared empty view when nothing is stored', async () => {
  const store = createMemoryStore()
  const resolved = await readOverride(store, operation)
  assert.equal(
    resolved,
    EMPTY_OVERRIDE,
    'identity matters: the handler uses it to decide whether an override applied'
  )
})

test('readOverride reads back what was written under the namespaced key', async () => {
  const store = createMemoryStore()
  await store.set(overrideKey(targetKey(operation)), { 200: { body: { ok: 1 } } })
  const resolved = await readOverride(store, operation)
  assert.notEqual(resolved, EMPTY_OVERRIDE)
  assert.deepEqual(resolved.bodies(200), [{ ok: 1 }])
})
```

`createMemoryStore` is the real exported factory in `src/runtime/store.ts`
(verified), and it takes an optional injected clock.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtime/overrides.test.ts`
Expected: FAIL - cannot resolve `../../src/runtime/overrides.ts`.

- [ ] **Step 3: Implement the module**

Create `src/runtime/overrides.ts`:

```ts
import type { Operation } from '../spec/types.ts'
import type { StatusConfig } from './config.ts'
import type { Store } from './store.ts'
import type { OverrideNode } from './types.ts'
import { targetKey } from './failure.ts'

/**
 * `OperationConfig` minus `respond` and `emits`. One is a function that cannot
 * cross a JSON boundary; the other fires webhooks and belongs with the emission
 * lifecycle rather than with "what does this endpoint return right now."
 * Design section 2.
 */
export type RuntimeOverride = { status?: number } & { [status: number]: StatusConfig }

/**
 * Exported because `index.ts` WRITES the key this module READS. Two independent
 * spellings of one convention drift silently, with both test suites green - the
 * same reasoning `failure.ts` records for its own key builders.
 */
export function overrideKey(key: string): string {
  return `override|${key}`
}

/**
 * A runtime override must be JSON data. A function or a Date would survive the
 * in-process Store and change shape through an injected external one: the same
 * code, two deployments, silently different behavior. Refusing it at the door
 * is also what keeps `Mock.override()` and the `set_override` tool the same
 * surface in fact rather than in name. Design amendment 2.2.
 */
export function assertSerializable(
  value: unknown,
  path = 'value',
  seen = new Set<object>()
): void {
  if (value === null || value === undefined) return

  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new Error(
      `mockingham: override ${path} is a ${type}, which cannot survive a Store ` +
        'that serializes. Runtime overrides must be JSON data - use the ' +
        '`operations` config for anything that needs a function.'
    )
  }

  const object = value as object
  if (seen.has(object)) {
    throw new Error(
      `mockingham: override ${path} contains a cycle. Runtime overrides must be ` +
        'JSON data.'
    )
  }
  seen.add(object)

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializable(item, `${path}[${index}]`, seen))
    seen.delete(object)
    return
  }

  const proto = Object.getPrototypeOf(object) as unknown
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `mockingham: override ${path} is a ${object.constructor?.name ?? 'non-plain object'}, ` +
        'which cannot survive a Store that serializes. Runtime overrides must ' +
        'be JSON data.'
    )
  }

  for (const [key, nested] of Object.entries(object as Record<string, unknown>)) {
    assertSerializable(nested, `${path}.${key}`, seen)
  }
  seen.delete(object)
}

/**
 * The same shape `resolveConfigs` returns, so the handler composes a runtime
 * override with a config one without either side learning a new type.
 */
export interface ResolvedOverride {
  status?: number
  bodies(forStatus: number): OverrideNode[]
  headers(forStatus: number): Record<string, OverrideNode>
}

/**
 * Shared, and compared by IDENTITY in the handler to decide whether an override
 * contributed to the response - which is what the `x-mock-override` debug
 * header reports. A fresh empty object per request would work for composition
 * and break that check.
 */
export const EMPTY_OVERRIDE: ResolvedOverride = {
  status: undefined,
  bodies: () => [],
  headers: () => ({})
}

export function overrideAsResolved(value: RuntimeOverride): ResolvedOverride {
  return {
    status: value.status,
    bodies(forStatus) {
      const scoped = value[forStatus]
      return scoped?.body === undefined ? [] : [scoped.body]
    },
    headers(forStatus) {
      return value[forStatus]?.headers ?? {}
    }
  }
}

export async function readOverride(
  store: Store,
  operation: Operation
): Promise<ResolvedOverride> {
  const raw = await store.get(overrideKey(targetKey(operation)))
  if (raw === undefined) return EMPTY_OVERRIDE
  return overrideAsResolved(raw as RuntimeOverride)
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/runtime/overrides.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the tests can fail**

Three mutations, each producing a distinct failure. Apply one, run, confirm,
revert, confirm `git diff` is clean, then the next:

1. Change `overrideKey` to return the bare key with no `override|` prefix →
   the key test fails.
2. Make `assertSerializable` return immediately → the function, non-plain, and
   cycle tests fail.
3. Make `readOverride` return `overrideAsResolved({})` instead of
   `EMPTY_OVERRIDE` on a miss → the identity test fails.

Record the three messages in your report.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add src/runtime/overrides.ts test/runtime/overrides.test.ts
```

```sh
git commit -m 'feat: the runtime override module, key convention and read'
```

---

## Task 2: The pipeline seam

**Files:**
- Modify: `src/server/handler.ts`
- Test: `test/server/overrides.test.ts` (append)

**Interfaces:**
- Consumes: `readOverride`, `EMPTY_OVERRIDE` from `src/runtime/overrides.ts`.
- Produces: no new exports. After this task, an override written directly to an
  injected Store changes what a request returns.

- [ ] **Step 1: Write the failing tests**

Append to `test/server/overrides.test.ts`. These write to the Store directly,
because `mock.override()` does not exist until Task 3 - which keeps this task
independently testable:

```ts
import { createMemoryStore } from '../../src/runtime/store.ts'
import { overrideKey } from '../../src/runtime/overrides.ts'

test('a runtime override layers on top of a config override', async () => {
  // All five layers present at once. A test with fewer proves nothing about
  // ordering - it passes with the whole composition removed.
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: {
      showPetById: { 200: { body: { name: 'from-config', tag: 'kept' } } }
    }
  })

  await store.set(overrideKey('showPetById'), { 200: { body: { name: 'from-runtime' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>

  assert.equal(body.name, 'from-runtime', 'the runtime layer wins')
  assert.equal(body.tag, 'kept', 'and refines rather than erases the config layer')
})

test('a runtime override forces the selected status', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime' })

  await store.set(overrideKey('showPetById'), { status: 404 })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 404)
})

test('a runtime override contributes headers, and wins a collision', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: { showPetById: { 200: { headers: { 'x-a': 'config', 'x-b': 'config' } } } }
  })

  await store.set(overrideKey('showPetById'), { 200: { headers: { 'x-a': 'runtime' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.headers.get('x-a'), 'runtime')
  assert.equal(response.headers.get('x-b'), 'config', 'untouched header survives')
})

test('an override for a different status contributes nothing', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime' })

  await store.set(overrideKey('showPetById'), { 404: { body: { name: 'wrong-status' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 200)
  assert.notEqual(body.name, 'wrong-status')
})

test('debugHeaders reports that an override applied', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime', debugHeaders: true })

  const before = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(before.headers.get('x-mock-override'), null, 'absent when none is set')

  await store.set(overrideKey('showPetById'), { 200: { body: { name: 'x' } } })
  const after = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(after.headers.get('x-mock-override'), 'applied')
})

test('a configured respond beats a runtime override', async () => {
  // Design section 4.2: respond returns before status selection and render,
  // so a runtime override cannot reach it. Documented, not accidental.
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: { showPetById: { respond: () => new Response('from-respond', { status: 200 }) } }
  })

  await store.set(overrideKey('showPetById'), { status: 404, 200: { body: { name: 'x' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'from-respond')
})
```

**The existing file's fixtures, verified - reuse them, declare nothing new.**
`test/server/overrides.test.ts` already imports `createHandler` from
`src/server/handler.ts`, `loadApi` from `src/spec/load.ts`, and `petstore` from
`test/fixtures/petstore.ts`, with `const api = loadApi(petstore)` at the top.

The operation these tests drive is `showPetById` - `GET /pets/{petId}`, whose
`petId` is an integer, so `/pets/7` is a valid request. Its `200` returns the
`Pet` schema, which declares `id`, `name`, `email`, and `tag`; the layering test
uses `name` and `tag` because both are real properties of that schema. A `404`
is also declared on that operation, which is what makes the forced-status test
meaningful rather than a request for a status the document does not have.

The override key is `overrideKey(targetKey(operation))`, which is the
`operationId` when one exists and `` `${method} ${path}` `` otherwise - so
`overrideKey('showPetById')` here.

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/server/overrides.test.ts`
Expected: FAIL - the runtime layer is not read yet, so bodies come from config
or generation and `x-mock-override` is absent.

- [ ] **Step 3: Read the override once, early**

In `src/server/handler.ts`, immediately after:

```ts
    const config = resolveConfigs(operation, compiled)
```

add:

```ts
    // Read once, here, rather than at render: `config.status` feeds status
    // selection below and selection runs well before the body is rendered, so
    // one read serves both. Design section 4.
    const runtime = await readOverride(store, operation)
```

Import at the top of the file:

```ts
import { readOverride, EMPTY_OVERRIDE } from '../runtime/overrides.ts'
```

- [ ] **Step 4: Compose at the three points**

Change `staticStatus` in the `createResponders` call from:

```ts
      staticStatus: config.status,
```

to:

```ts
      staticStatus: runtime.status ?? config.status,
```

Change the `renderResponse` call's two override lines from:

```ts
      bodyOverrides: config.bodies(chosen.status),
      fixtureLayer: fixture?.layer as OverrideNode | undefined,
      headerOverrides: config.headers(chosen.status),
```

to:

```ts
      // The runtime layer goes last so it refines the config layers rather
      // than erasing them, and the fixture stays beneath both.
      bodyOverrides: [...config.bodies(chosen.status), ...runtime.bodies(chosen.status)],
      fixtureLayer: fixture?.layer as OverrideNode | undefined,
      headerOverrides: {
        ...config.headers(chosen.status),
        ...runtime.headers(chosen.status)
      },
```

- [ ] **Step 5: Add the debug header**

In the `debug` block of the same `renderResponse` call, the existing shape is
`{ seed, source, operationId }` consumed by `render.ts`. Add a fourth field
`override` set to `runtime !== EMPTY_OVERRIDE ? 'applied' : undefined`, then in
`src/runtime/render.ts` extend `RenderDebug` with `override?: string` and, beside
the existing header stamps, add:

```ts
    if (input.debug.override) {
      headers.set('x-mock-override', input.debug.override)
    }
```

Keep it inside the existing `if (input.debug)` block so it stays off unless
`debugHeaders` is on.

- [ ] **Step 6: Run and watch them pass**

Run: `node --test test/server/overrides.test.ts`
Expected: PASS, including every pre-existing config-override test unchanged.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: all pass. **If a pre-existing test now fails, stop and report it
rather than editing it** - a behavior change outside this task's scope is a
finding, not a fixup.

- [ ] **Step 8: Prove the precedence test can fail**

Remove the runtime spread from `bodyOverrides`, run, confirm the layering test
fails, restore. Then reverse the spread order so runtime comes first, run, and
confirm the layering test fails again - this is the mutation that matters,
because a test that passes with the layers in either order is not testing
precedence at all. Record both messages.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 10: Commit**

```sh
git add src/server/handler.ts src/runtime/render.ts test/server/overrides.test.ts
```

```sh
git commit -m 'feat: runtime overrides layer over config overrides in the pipeline'
```

---

## Task 3: `Mock.override()` and `Mock.clearOverrides()`

**Files:**
- Modify: `src/index.ts`
- Test: `test/server/overrides.test.ts` (append)

**Interfaces:**
- Consumes: `overrideKey`, `assertSerializable`, `RuntimeOverride` from
  `src/runtime/overrides.ts`; the existing `keysFor(target)` helper in
  `index.ts`, which maps a target to every `targetKey` it resolves to.
- Produces: on `Mock` -
  - `override(target: string, value: RuntimeOverride): Promise<void>`
  - `clearOverrides(target?: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `test/server/overrides.test.ts`:

```ts
import { createMock } from '../../src/index.ts'

test('override then fetch changes the response through the public surface', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'overridden' } } })

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.name, 'overridden')
})

test('clearOverrides(target) restores the generated body', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'overridden' } } })
  await mock.clearOverrides('showPetById')

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'overridden')
})

test('clearOverrides() with no target clears every operation', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('*', { 200: { body: { name: 'overridden' } } })
  await mock.clearOverrides()

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'overridden')
})

test('a wildcard target overrides every operation it matches', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('*', { 200: { body: { name: 'everywhere' } } })

  for (const path of ['/pets/7', '/pets']) {
    const response = await mock.fetch(new Request(`http://mock${path}`))
    if (response.status !== 200) continue
    const body = await response.json()
    const first = Array.isArray(body) ? body[0] : body
    assert.equal(
      (first as Record<string, unknown>).name,
      'everywhere',
      `${path} should carry the override`
    )
  }
})

test('a target matching no operation throws instead of arming nothing', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await assert.rejects(
    () => mock.override('GET /nope', { 200: { body: {} } }),
    /matches no operation/
  )
})

test('a non-serializable override is refused at the door', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await assert.rejects(
    () => mock.override('showPetById', { 200: { body: { total: () => 1 } } as never }),
    /is a function/
  )
})

test('the second override for one target replaces the first', async () => {
  // Design section 2.3: runtime overrides do not layer against each other.
  // A caller who cannot see what is already set gets a replacement they can
  // predict rather than a merge they cannot inspect.
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'first', keep: 'a' } } })
  await mock.override('showPetById', { 200: { body: { name: 'second' } } })

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.name, 'second')
  assert.notEqual(body.keep, 'a', 'the first override is gone, not merged')
})

test('an off-contract override body is served, not rejected', async () => {
  // Design section 5.2: an override body is NOT validated against the
  // response schema. That is already true of config overrides, and a runtime
  // override that behaved differently would be a second validation path - the
  // divergence invariant 1 exists to prevent. `name` is declared a string and
  // required; this replaces it with a number and the mock serves it.
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 42 } } })

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 200)
  assert.equal((await response.json() as Record<string, unknown>).name, 42)
})

test('reset clears runtime overrides', async () => {
  // Master section 1 has always claimed this; it is asserted rather than
  // inferred from store.clear().
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'overridden' } } })
  await mock.reset()

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'overridden')
})
```

Use the document the file already declares. If the wildcard test's second path
is not a real operation in it, drop that path rather than inventing one.

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/server/overrides.test.ts`
Expected: FAIL - `mock.override is not a function`.

- [ ] **Step 3: Add the two methods to the `Mock` interface**

In `src/index.ts`, add to `interface Mock`, beside `failNext` and `outage`:

```ts
  /**
   * Layers a runtime override over any configured one for every operation the
   * target resolves to. JSON data only - see `assertSerializable`.
   */
  override(target: string, value: RuntimeOverride): Promise<void>
  /** No target clears every operation in the document. */
  clearOverrides(target?: string): Promise<void>
```

Import at the top:

```ts
import { overrideKey, assertSerializable } from './runtime/overrides.ts'
import type { RuntimeOverride } from './runtime/overrides.ts'
```

Re-export the type beside the other public types:

```ts
export type { RuntimeOverride } from './runtime/overrides.ts'
```

- [ ] **Step 4: Implement both methods**

In the `mockRef` object literal, after `outage`:

```ts
    async override(target, value) {
      // Checked before any write, so a partially-applied wildcard is
      // impossible: either every matching operation gets the override or none
      // does.
      assertSerializable(value)
      for (const key of keysFor(target)) {
        await handler.store.set(overrideKey(key), value)
      }
    },

    async clearOverrides(target) {
      // No enumeration on `Store`, so a clear-all deletes the key for every
      // operation the document declares. The operation list is finite and is
      // already the authority for what a target can resolve to - this avoids
      // both an index entry to keep consistent and `store.clear()`, which
      // would also discard idempotency keys and chaos state. Design 3.1.
      const keys = target === undefined
        ? api.operations.map(targetKey)
        : keysFor(target)
      for (const key of keys) {
        await handler.store.delete(overrideKey(key))
      }
    },
```

`targetKey` is already imported in `index.ts` - line 8 imports
`{ targetKey, failNextKey, outageKey }` from `./runtime/failure.ts` for the
control-plane keys. No new import is needed for it.

- [ ] **Step 5: Run and watch them pass**

Run: `node --test test/server/overrides.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Prove the ordering claim in `override()`**

Move `assertSerializable(value)` to after the write loop, run, and confirm the
non-serializable test now leaves a partially-applied override behind - write a
throwaway assertion locally if the existing tests do not show it, then restore
the original order and delete the throwaway. Record what you observed. The
point is that "checked before any write" is a real property, not a comment.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 9: Commit**

```sh
git add src/index.ts test/server/overrides.test.ts
```

```sh
git commit -m 'feat: Mock.override and Mock.clearOverrides'
```

---

## Task 4: The MCP tools

**Files:**
- Modify: `src/mcp/tools/write.ts`, `src/mcp/context.ts`
- Test: `test/mcp/override-tools.test.ts` (create), `test/mcp/write.test.ts` (modify)

**Interfaces:**
- Consumes: `mock.override()` / `mock.clearOverrides()` from Task 3.
- Produces: `set_override` and `clear_overrides` in `WRITE_TOOLS`; `override`
  and `clearOverrides` on `McpContext` and `McpContextSource`.

- [ ] **Step 1: Write the failing tests**

Create `test/mcp/override-tools.test.ts`. **Read `test/mcp/write.test.ts` first**
and reuse its helpers (`mcpTools`, `toolNamed`, `contextFor`) and its document
rather than building new ones:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import { toolNamed, contextFor } from './helpers.ts'

test('both override tools are gated behind write', () => {
  const names = mcpTools().map((tool) => tool.name)
  assert.ok(!names.includes('set_override'))
  assert.ok(!names.includes('clear_overrides'))
})

test('both appear when the gate is open', () => {
  const names = mcpTools({ write: true }).map((tool) => tool.name)
  assert.ok(names.includes('set_override'))
  assert.ok(names.includes('clear_overrides'))
})

test('set_override changes what the next request returns', async () => {
  const ctx = contextFor()
  await toolNamed('set_override', { write: true }).handler(ctx, {
    target: 'showPetById',
    value: { 200: { body: { name: 'via-mcp' } } }
  })

  const response = await ctx.fetch(new Request('http://mock.local/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.name, 'via-mcp')
})

test('clear_overrides removes it again', async () => {
  const ctx = contextFor()
  await toolNamed('set_override', { write: true }).handler(ctx, {
    target: 'showPetById',
    value: { 200: { body: { name: 'via-mcp' } } }
  })
  await toolNamed('clear_overrides', { write: true }).handler(ctx, {})

  const response = await ctx.fetch(new Request('http://mock.local/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'via-mcp')
})

test('an unmatched target surfaces as a tool error, not a silent no-op', async () => {
  await assert.rejects(
    async () => toolNamed('set_override', { write: true }).handler(contextFor(), {
      target: 'GET /nope',
      value: { 200: { body: {} } }
    }),
    /matches no operation/
  )
})
```

`contextFor()` must supply the two new members; if the helper builds its context
through `createMcpContext`, adding them to `McpContextSource` is enough.

Then in `test/mcp/write.test.ts`, extend **both** literal name arrays from the
five to all seven, so the gate assertions actually cover the new tools.

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/mcp/override-tools.test.ts`
Expected: FAIL - no tool named `set_override`.

- [ ] **Step 3: Add the context members**

In `src/mcp/context.ts`, add to BOTH `McpContext` and `McpContextSource`:

```ts
  override(target: string, value: RuntimeOverride): Promise<void>
  clearOverrides(target?: string): Promise<void>
```

Import the type:

```ts
import type { RuntimeOverride } from '../runtime/overrides.ts'
```

and wire them through in `createMcpContext`, beside the existing delegations:

```ts
    override: (target, value) => source.override(target, value),
    clearOverrides: (target) => source.clearOverrides(target),
```

Update the doc comment above `McpContextSource` - it says "the eight members"
and there will be ten.

- [ ] **Step 4: Add the two tools**

In `src/mcp/tools/write.ts`:

```ts
const setOverride: McpTool = {
  name: 'set_override',
  description:
    'Pin what an operation returns, without editing config. The override ' +
    'layers over any configured one, so a partial body refines rather than ' +
    'replaces it. Target is a control-plane string: "POST /orders", an ' +
    'operationId, or "*". JSON data only.',
  inputSchema: {
    target: z.string(),
    value: z
      .record(z.string(), z.unknown())
      .describe('{ status?, [status]: { body?, headers? } }')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.override(String(args.target), args.value as never)
    return { target: args.target, value: args.value }
  }
}

const clearOverrides: McpTool = {
  name: 'clear_overrides',
  description:
    'Remove runtime overrides. With no target, clears them for every ' +
    'operation. Never touches the overrides in your config file.',
  inputSchema: {
    target: z.string().optional().describe('Omit to clear every operation')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.clearOverrides(args.target === undefined ? undefined : String(args.target))
    return { cleared: args.target ?? '*' }
  }
}
```

and extend the export:

```ts
export const WRITE_TOOLS: McpTool[] = [
  failNext,
  outage,
  emitWebhook,
  setSeed,
  reset,
  setOverride,
  clearOverrides
]
```

**Nothing else is needed for the disabled-tool refusal.** `src/mcp/server.ts`
derives the disabled names from `WRITE_TOOLS` rather than a literal list,
specifically so "a sixth write tool added later must not silently lose its
refusal message." Verify that still holds by running the gate-closed test.

- [ ] **Step 5: Run and watch them pass**

Run: `node --test test/mcp/override-tools.test.ts`
Expected: PASS.

Run: `node --test test/mcp/write.test.ts`
Expected: PASS with the widened name arrays.

- [ ] **Step 6: Confirm the refusal message reaches the new names**

Add a test asserting that with the gate CLOSED, calling `set_override` through
the server produces the refusal naming `--write` - modelled on the existing
gate-closed test in `test/mcp/write.test.ts`. This is the behavior
`server.ts`'s comment promises; assert it rather than trusting the comment.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test`
Expected: all pass.

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```sh
git add src/mcp/tools/write.ts src/mcp/context.ts test/mcp/override-tools.test.ts test/mcp/write.test.ts
```

```sh
git commit -m 'feat: set_override and clear_overrides MCP tools'
```

---

## Task 5: Documentation, help text, and the inventory check

**Files:**
- Modify: `src/server/cli.ts` (`MCP_USAGE`), `docs/mcp.md`, `README.md`,
  `docs/superpowers/specs/2026-08-11-mockingham-design.md`,
  `docs/superpowers/deferred-items.md`
- Test: `test/mcp/override-tools.test.ts` (append the inventory check)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: documentation that the suite keeps honest.

- [ ] **Step 1: Add the inventory check that was assumed to exist**

The docs harness does NOT currently catch a stale tool list - `docs/mcp.md`'s
runnable block filters `tools/list` for `fail_next` and prints only that, so
adding tools changes none of its expected output. Its "The twelve tools"
heading is unverified prose. Close that gap first, so the rest of this task
cannot be done wrong silently.

Append to `test/mcp/override-tools.test.ts`:

```ts
import { readFile } from 'node:fs/promises'

test('every shipped tool is named in docs/mcp.md, and none is stale', async () => {
  // The guide's inventory is prose, so nothing but this test relates it to the
  // code. A tool added without documenting it, or documented after removal,
  // fails here.
  const guide = await readFile(new URL('../../docs/mcp.md', import.meta.url), 'utf8')
  const shipped = mcpTools({ write: true }).map((tool) => tool.name).sort()

  const missing = shipped.filter((name) => !guide.includes(name))
  assert.deepEqual(missing, [], 'these tools ship but are undocumented')

  const notShipped = ['regenerate_fixture']
  for (const name of notShipped) {
    assert.ok(
      !shipped.includes(name),
      `${name} is listed as deferred but now ships - update the guide and this list`
    )
  }
})
```

Run it, watch it fail on the two new tool names, and only then write the docs.

- [ ] **Step 2: Update `MCP_USAGE` in `src/server/cli.ts`**

Its `--write` line names the five write tools:

```
  --write           Expose the write tools (fail_next, outage, emit_webhook,
                     set_seed, reset). Off by default: they change the mock's
                     runtime state.
```

Name all seven. Keep the wrapping consistent with the surrounding usage text,
and check whether `test/server/cli-mcp.test.ts` asserts on this string - if it
does, update that assertion in the same commit.

- [ ] **Step 3: Update `docs/mcp.md`**

Three changes, and remember the whole document is executed:

1. The "The twelve tools" heading and its list - fourteen now, with
   `set_override` and `clear_overrides` described in the same one-line style.
2. The write-gate section: five write tools becomes seven, everywhere it says
   five.
3. The closing section names `set_override`, `clear_overrides`, and
   `regenerate_fixture` as not existing. Only `regenerate_fixture` is still
   deferred. Rewrite it so the two that now exist are not described as absent,
   and keep the pointer for the one that remains.

If you change any ```ts fence, its ```console fence must be reconciled by
running the suite - never by pasting output you have not reasoned about.

- [ ] **Step 4: Update `README.md`**

Its tour describes the control plane and links to the MCP guide. Add
`override()` / `clearOverrides()` to the control-plane surface it lists, and
correct anything that describes runtime overrides as unavailable. Search for
`override` in the file and check every hit.

- [ ] **Step 5: Remove the phantom marker from the master spec**

`docs/superpowers/specs/2026-08-11-mockingham-design.md` §1 carries:

```ts
  // NOT IMPLEMENTED - deferred to the runtime-override cycle. See the phase 10
  // MCP delta section 1 and the phase 12 docs delta section 5.2.
  override(target: string, value: Override): void
```

The method now exists. Remove the marker and correct the signature to the
shipped one - `override(target: string, value: RuntimeOverride): Promise<void>`,
noting the async return the way amendment 2.1 explains. Leave §1's other
entries alone.

- [ ] **Step 6: Close the deferred entries**

In `docs/superpowers/deferred-items.md`, the entries covering
`Mock.override()` and the deferred override tools are now resolved. Follow the
file's existing convention for a closed item (read how earlier resolved entries
are marked - do not invent a new format) and note the commit range. Leave the
`regenerate_fixture` portion open.

- [ ] **Step 7: Run everything**

Run: `npm test`
Expected: all pass, including the docs suite - every document still matches its
```console fences.

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 8: Prove the inventory check works**

Remove `set_override` from the guide's tool list, run the test, confirm it fails
naming that tool, then restore. Record the message.

- [ ] **Step 9: Commit**

```sh
git add src/server/cli.ts docs/mcp.md README.md docs/superpowers/specs/2026-08-11-mockingham-design.md docs/superpowers/deferred-items.md test/mcp/override-tools.test.ts
```

```sh
git commit -m 'docs: document the override tools and pin the tool inventory'
```

---

## Verification

The plan is done when all of these hold:

1. `npm test` passes - 952 before this plan, plus roughly 25 new tests.
2. `npx tsc --noEmit` produces no output.
3. Precedence is asserted end to end through the public surface with a config
   layer, a runtime layer, and a generated body all present at once - and the
   assertion has been shown to fail when the two layers are swapped.
4. `reset()` clearing runtime overrides is asserted, not inferred.
5. A non-serializable override is refused before any key is written.
6. With the write gate closed, both new tool names still list with a
   `Disabled.` description and their refusal names `--write`.
7. `docs/mcp.md` names every shipped tool, and the inventory test fails when it
   does not.
8. No document's ```console fence was changed without running it.

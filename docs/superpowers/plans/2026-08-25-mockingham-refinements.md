# mockingham refinements (plan 11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven refinements - webhook destination registry, response
linking, `Prefer: variant=`, body-pointer idempotency keys, redelivery with
delivery identity, seeded UUIDv7, and capability exposure - plus the eight MCP
tool additions and extensions they imply.

**Architecture:** The registry and response linking are one mechanism: a
post-response expression capture pass in a new `src/runtime/capture.ts`, into
which the existing callback-destination block is folded. Variant selection is a
choice inside the existing `union` case of `generate.ts`, fed by a `Prefer`
directive and a Store-backed per-operation preference. Delivery identity is an
ordinal-derived `fnv1a` id on the existing `Delivery` type. Everything else
extends a surface that already exists.

**Tech Stack:** TypeScript, ESM, Node >= 24, `node:test`, `zod` (only hard
runtime dependency), `@modelcontextprotocol/sdk` (optional peer, lazy import).

**Spec:** `docs/superpowers/specs/2026-08-25-mockingham-refinements-design.md`

## Global Constraints

Copied verbatim from `CLAUDE.md` and the design. Every task's requirements
implicitly include this section.

- **One schema interpretation.** `schema/walk.ts` is shared by value generation
  and zod compilation. Never add a second traversal.
- **Determinism.** No `Math.random()`, no `Date.now()`, no iteration over an
  unordered `Set`/object in a generation path. Randomness comes from
  `generate/rng.ts`; time comes from an injectable clock. Invariant 2 is
  amended by design §4.5 to *sequence* determinism: the same request sequence
  produces byte-identical output across processes.
- **The core is pure.** `server/handler.ts` and everything it imports must not
  touch Node APIs.
- **A fixture or LLM miss is never an error.** It falls through to seeded
  generation.
- **Errors stay on-contract.** Emit the operation's declared error schema when
  one exists.
- **Emission never affects the response.** A throw in an emit override, in
  signing, or in delivery reaches `onError` - never the caller. An emit that
  resolves no destination is `unresolved`, not an error.
- **Erasable syntax only** - no `enum`, no `namespace`, no parameter
  properties. Use `const X = {...} as const`.
- **US English spelling** everywhere - `honor`, `behavior`, `serialize`,
  `normalize`, `canceled`.
- Tests live in `test/` mirroring `src/`, TypeScript, run by `node:test`.
  Write the test first, watch it fail, then implement.
- **Shell:** one plain command per Bash call, literal arguments. No `&&`, no
  pipes, no `$(...)`, no redirects, no heredocs, no `cd`. Prefer single quotes.
  Multi-paragraph commits use repeated `-m` flags.
- `npm test` runs the suite. `npx tsc --noEmit` typechecks. `node --test test/spec/`
  scopes to a directory.

## Instructions to every implementer

Read these before starting your task. They encode failures this project has
actually shipped.

1. **Validate the prescribed mutation before trusting it.** Each task names a
   specific condition to break. Break exactly that condition, run the test, and
   quote the failure message in your report. If the test still passes, the test
   is wrong - **fix the test, not the mutation**, and say so. Across plans 7–9
   this instruction caught thirteen tests that could not fail.
2. **If this brief contradicts itself, stop and report it** rather than
   resolving it silently. Two implementers have done this and were right both
   times.
3. **A test whose only assertion is "does not throw" is not acceptable.** Name
   what the output must be.
4. **Do not modify an existing passing test to make your work pass** unless the
   task explicitly says a test may legitimately move. If an existing test fails,
   that is a finding - report it.
5. Report what your fix actually did, not that it was applied.

## Task waves

Tasks within a wave are independent and may run concurrently. A wave starts
only when the previous one is reviewed.

- **Wave 1:** Tasks 1, 4, 6, 7, 9 - no dependencies on each other.
- **Wave 2:** Tasks 2, 3, 5, 8 - each depends on one wave-1 task.
- **Wave 3:** Tasks 10, 11 - the MCP surface, depends on waves 1–2.
- **Wave 4:** Tasks 12, 13 - docs and the tracked ledger.

---

### Task 1: The capture pass, and folding tier-2 into it

**This is the riskiest task in the plan.** Design §12 explains why: plan 5
shipped a Critical defect of exactly this shape at exactly this location.

**Files:**
- Create: `src/runtime/capture.ts`
- Modify: `src/server/handler.ts:794-819` (the tier-2 block)
- Test: `test/runtime/capture.test.ts`, `test/server/capture-seam.test.ts`

**Interfaces:**
- Consumes: `resolveExpression`, `ExprInput` from `src/webhooks/expr.ts`;
  `callbackKey` from `src/webhooks/emit.ts`.
- Produces:
  ```ts
  export type CaptureRule =
    | { kind: 'callback'; name: string; expression: string }
    | { kind: 'register'; webhook: string; url: string; scope?: string }
    | { kind: 'unregister'; webhook: string; scope?: string }
    | { kind: 'link'; index: number; keyExpr: string; remember: string }

  export interface CaptureInput {
    rules: CaptureRule[]
    expr: ExprInput
    store: Store
    /** The parsed response body, for a whole-body `remember`. */
    responseBody: unknown
    /** The parsed request body, for a whole-body `remember`. */
    requestBody: unknown
  }

  export async function runCapture(input: CaptureInput): Promise<void>
  ```
  Task 2 adds `register`/`unregister` handling, Task 3 adds `link`. This task
  implements `callback` only, with the other kinds present in the type and
  falling through to a no-op so the union is stable for later tasks.

**Constraints, non-negotiable (design §12):**
- `runCapture` is called **inside** the existing `try`/`catch`, not beside it.
- The `status < 400` precondition and its comment are preserved.
- Every existing callback-capture test must pass **unmodified**.

- [ ] **Step 1: Write the failing unit test**

```ts
// test/runtime/capture.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCapture } from '../../src/runtime/capture.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { callbackKey } from '../../src/webhooks/emit.ts'

function exprInput(body: unknown, resultBody: unknown) {
  return {
    request: new Request('http://mock/orders', { method: 'POST' }),
    url: new URL('http://mock/orders'),
    method: 'POST',
    params: {},
    body,
    result: { status: 201, headers: {}, body: resultBody }
  }
}

test('a callback rule stores the resolved destination', async () => {
  const store = createMemoryStore(() => 0)
  await runCapture({
    rules: [{ kind: 'callback', name: 'onOrder', expression: '{$request.body#/hook}' }],
    expr: exprInput({ hook: 'https://consumer.example/h' }, {}),
    store,
    responseBody: {},
    requestBody: { hook: 'https://consumer.example/h' }
  })
  assert.equal(await store.get(callbackKey('onOrder')), 'https://consumer.example/h')
})

test('an unresolvable callback expression stores nothing', async () => {
  const store = createMemoryStore(() => 0)
  await runCapture({
    rules: [{ kind: 'callback', name: 'onOrder', expression: '{$request.body#/absent}' }],
    expr: exprInput({}, {}),
    store,
    responseBody: {},
    requestBody: {}
  })
  // Not merely "no throw": the key must be absent, so a later emit falls
  // through to the next destination tier rather than to an empty string.
  assert.equal(await store.get(callbackKey('onOrder')), undefined)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/runtime/capture.test.ts`
Expected: FAIL - cannot find module `src/runtime/capture.ts`.

- [ ] **Step 3: Implement `runCapture` with the `callback` kind only**

Move the resolve-and-store logic from `handler.ts:815-818` verbatim. The other
three kinds `return` without acting; do not throw on them - Tasks 2 and 3 fill
them in and a throw would make this task's partial union a landmine.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/runtime/capture.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Fold the handler's tier-2 block into `runCapture`**

Replace the body of the `if (trace.operation !== undefined && response.status < 400)`
block at `handler.ts:799`. Keep the block, its condition, and its comment. Build
`exprInput` as today, then call `runCapture` with rules compiled at construction
from the document's `callbacks` entries. Compile those rules once, beside where
`callbacks` is built today - not per request.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, 1000 tests, none modified. **If any existing callback test
fails or needed editing, the refactor changed behavior - stop and report.**

- [ ] **Step 7: Write the end-to-end seam test**

Per design §12 and the plan-7 lesson: per-task review cannot see a seam defect.

```ts
// test/server/capture-seam.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { hook: { type: 'string' } } }
            }
          }
        },
        responses: { 201: { description: 'made' } },
        callbacks: {
          orderDone: {
            '{$request.body#/hook}': { post: { responses: { 200: { description: 'ok' } } } }
          }
        }
      }
    }
  }
}

test('a document callbacks destination still resolves through the capture pass', async () => {
  const mock = createMock(doc, { captureOnly: true })
  await mock.fetch(new Request('http://mock/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'https://consumer.example/done' })
  }))
  const delivery = await mock.emit('orderDone')
  // The exact URL, not merely "resolved": a tier that silently fell through to
  // a configured or empty destination would still produce a Delivery.
  assert.equal(delivery.url, 'https://consumer.example/done')
  assert.equal(delivery.outcome, 'captured')
})
```

- [ ] **Step 8: Run it**

Run: `node --test test/server/capture-seam.test.ts`
Expected: PASS.

- [ ] **Step 9: Validate the mutation**

**Mutate exactly this:** in `runCapture`'s callback branch, change
`if (resolved.ok)` to `if (true)` so a failed resolution stores an empty string.
Run `node --test test/runtime/capture.test.ts`.
Expected: the second test fails with the stored value being `''` rather than
`undefined`. Quote the message. Restore.

- [ ] **Step 10: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/runtime/capture.ts src/server/handler.ts test/runtime/capture.test.ts test/server/capture-seam.test.ts
git commit -m 'refactor: route callback destination capture through a capture pass' -m 'The registry and response linking are the same post-response expression capture the callback destination tier already does. This generalizes that block rather than growing two more beside it. Behavior is unchanged - every existing callback test passes unmodified, and an end-to-end test proves a document callbacks destination still resolves through the new path.'
```

---

### Task 2: Webhook destination registry

**Files:**
- Create: `src/webhooks/registry.ts`
- Modify: `src/runtime/capture.ts` (the `register`/`unregister` kinds),
  `src/webhooks/emit.ts` (destination tier), `src/index.ts` (Mock surface),
  `src/server/handler.ts` (compile rules from `webhooks[].registerVia`)
- Test: `test/webhooks/registry.test.ts`

**Interfaces:**
- Consumes: `CaptureRule` from Task 1; `resolveTarget` from
  `src/resolve/target.ts`.
- Produces:
  ```ts
  export interface Registration { webhook: string; url: string; scope: string }
  export function registrationKey(webhook: string, scope: string): string
  export interface Registry {
    register(webhook: string, url: string, scope?: string): Promise<void>
    unregister(webhook: string, scope?: string): Promise<void>
    lookup(webhook: string, scope: string): Promise<string | undefined>
    all(webhook?: string): Promise<Registration[]>
  }
  export function createRegistry(store: Store): Registry
  ```
  `Mock` gains `registrations`, `register`, `unregister` with the design §3.5
  signatures. `EmitOptions` gains `scope?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/webhooks/registry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../../src/webhooks/registry.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'

test('a registration is readable back at its scope', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('orderChanged', 'https://a.example/h', 'tenant-1')
  assert.equal(await registry.lookup('orderChanged', 'tenant-1'), 'https://a.example/h')
})

test('scopes do not collide', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('orderChanged', 'https://a.example/h', 'tenant-1')
  await registry.register('orderChanged', 'https://b.example/h', 'tenant-2')
  // Two tenants in the fixture, because a registry with one scope cannot
  // prove it is keyed by scope at all.
  assert.equal(await registry.lookup('orderChanged', 'tenant-1'), 'https://a.example/h')
  assert.equal(await registry.lookup('orderChanged', 'tenant-2'), 'https://b.example/h')
})

test('unregister removes only its own scope', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('orderChanged', 'https://a.example/h', 'tenant-1')
  await registry.register('orderChanged', 'https://b.example/h', 'tenant-2')
  await registry.unregister('orderChanged', 'tenant-1')
  assert.equal(await registry.lookup('orderChanged', 'tenant-1'), undefined)
  assert.equal(await registry.lookup('orderChanged', 'tenant-2'), 'https://b.example/h')
})

test('all() is sorted by webhook then scope', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  // Inserted out of order on purpose: invariant 2 forbids an unordered
  // iteration deciding anything observable, and all() is observable.
  await registry.register('zeta', 'https://z.example/h', 'b')
  await registry.register('alpha', 'https://a2.example/h', 'b')
  await registry.register('alpha', 'https://a1.example/h', 'a')
  assert.deepEqual(await registry.all(), [
    { webhook: 'alpha', url: 'https://a1.example/h', scope: 'a' },
    { webhook: 'alpha', url: 'https://a2.example/h', scope: 'b' },
    { webhook: 'zeta', url: 'https://z.example/h', scope: 'b' }
  ])
})
```

- [ ] **Step 2: Run and watch fail**

Run: `node --test test/webhooks/registry.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement `registry.ts`**

Store key `registration|<webhook>|<scope>`, per design §3.4. Keep an
in-process `Set` of known keys for enumeration, exactly as
`createDeliveryLog` does and for the same documented reason (`Store` has no
enumeration primitive). `all()` reads through to the Store per key so a
shared-Store value written elsewhere is still reflected, and **sorts** before
returning.

- [ ] **Step 4: Run and watch pass**

Run: `node --test test/webhooks/registry.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the destination tier**

In `src/webhooks/emit.ts`, insert the registry between explicit `to` and the
captured callback, per design §3.7:

```ts
const registered = await input.registry.lookup(input.name, input.scope ?? '')
const captured = (await input.store.get(callbackKey(input.name))) as string | undefined
const url = input.to ?? registered ?? captured ?? input.config.url
```

`EmitInput` gains `registry: Registry` and `scope?: string`.

- [ ] **Step 6: Write the tier-order test**

```ts
test('a registration beats a captured callback but loses to an explicit to', async () => {
  // Three tiers armed at once; each assertion removes the tier above it.
  // A test arming only one tier cannot prove an ORDER.
  const store = createMemoryStore(() => 0)
  const registry = createRegistry(store)
  await registry.register('w', 'https://registered.example/h')
  await store.set(callbackKey('w'), 'https://captured.example/h')
  assert.equal(await urlFor({ store, registry }), 'https://registered.example/h')
  assert.equal(await urlFor({ store, registry, to: 'https://explicit.example/h' }),
    'https://explicit.example/h')
})
```

Write `urlFor` as a local helper that calls `emitWebhook` with `captureOnly: true`
and returns `delivery.url`.

- [ ] **Step 7: Wire `registerVia` / `unregisterVia` / `scopeBy`**

In `capture.ts`, the `register` kind resolves `url` and `scope` through
`resolveExpression` and calls `registry.register`; `unregister` resolves scope
and calls `registry.unregister`. In `handler.ts`, compile rules at construction
from `options.webhooks[name].registerVia`, resolving the target through
`resolveTarget` so a typo throws at construction. Accept a bare
`$request.body#/url` by wrapping it in braces when it contains no `{`, per
design §3.3.

- [ ] **Step 8: Write the end-to-end registry test**

A document with `PUT /subscriptions/{name}` and `DELETE /subscriptions/{name}`,
a top-level `webhooks` entry, and `registerVia`/`unregisterVia` config. Assert:
`PUT` then `emit` delivers to the registered URL; `DELETE` then `emit` produces
`outcome: 'unresolved'` with `url` absent - **not** an error (invariant 6,
design §3.6).

- [ ] **Step 9: Validate the mutation**

**Mutate exactly this:** in `all()`, delete the `.sort(...)` call. Run
`node --test test/webhooks/registry.test.ts`. Expected: the `all() is sorted`
test fails on insertion order. Quote it. Restore.

**Then mutate this:** in `emit.ts`, move `registered` after `captured` in the
`??` chain. Expected: the tier-order test fails with the captured URL. Quote
it. Restore.

- [ ] **Step 10: Typecheck, full suite, commit**

Run: `npx tsc --noEmit`, then `npm test`.

```sh
git add src/webhooks/registry.ts src/webhooks/emit.ts src/runtime/capture.ts src/server/handler.ts src/index.ts test/webhooks/registry.test.ts
git commit -m 'feat: cross-operation webhook destination registry' -m 'Destinations registered by a dedicated operation, scoped by an optional expression, read back by an emission that shares no request context with the registration. Slots between the explicit to and the captured callback tier. An emission with nothing registered is unresolved, which invariant 6 already required.'
```

---

### Task 3: Response linking

**Files:**
- Create: `src/runtime/link.ts`
- Modify: `src/runtime/capture.ts` (the `link` kind), `src/server/handler.ts:569`
  (stage 7.5 recall), `src/index.ts` (`link` option)
- Test: `test/runtime/link.test.ts`, `test/server/link-e2e.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LinkRule {
    from: { target: string; key: string }
    to: { target: string; key: string }
    remember?: string
    ttlMs?: number
    max?: number
  }
  export interface LinkTable {
    record(index: number, key: string, value: unknown): Promise<void>
    recall(index: number, key: string): Promise<unknown | undefined>
  }
  export function createLinkTable(store: Store, rules: ResolvedLinkRule[]): LinkTable
  export const LINK_TTL_MS = 3_600_000
  export const LINK_MAX = 1000
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/runtime/link.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLinkTable, LINK_MAX } from '../../src/runtime/link.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'

const rules = [{ ttlMs: 1000, max: LINK_MAX }, { ttlMs: 1000, max: LINK_MAX }]

test('a recorded value recalls under its own rule index', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await table.record(0, 'ord_1', { id: 'ord_1', total: 9 })
  assert.deepEqual(await table.recall(0, 'ord_1'), { id: 'ord_1', total: 9 })
})

test('rule indices do not collide on the same key value', async () => {
  // Two rules recording the SAME key string; keyed by index, so they must
  // not overwrite each other. A one-rule fixture cannot prove this.
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  await table.record(0, 'x', 'from-rule-0')
  await table.record(1, 'x', 'from-rule-1')
  assert.equal(await table.recall(0, 'x'), 'from-rule-0')
  assert.equal(await table.recall(1, 'x'), 'from-rule-1')
})

test('an unrecorded key recalls undefined', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), rules)
  assert.equal(await table.recall(0, 'never-written'), undefined)
})

test('the oldest entry is evicted past max', async () => {
  const table = createLinkTable(createMemoryStore(() => 0), [{ ttlMs: 1000, max: 2 }])
  await table.record(0, 'a', 1)
  await table.record(0, 'b', 2)
  await table.record(0, 'c', 3)
  assert.equal(await table.recall(0, 'a'), undefined)  // evicted
  assert.equal(await table.recall(0, 'b'), 2)
  assert.equal(await table.recall(0, 'c'), 3)
})
```

- [ ] **Step 2: Run and watch fail.** `node --test test/runtime/link.test.ts`

- [ ] **Step 3: Implement `link.ts`.** Key `link|<index>|<key>`, TTL per rule,
  FIFO eviction tracked by a per-rule in-process array of keys.

- [ ] **Step 4: Run and watch pass.**

- [ ] **Step 5: Wire recall at stage 7.5**

At `handler.ts:569`, before the fixture resolves, if the operation is a `to`
target of any rule and the selected status is a success (`>= 200 && < 300`),
resolve the rule's `to.key` expression against the request and recall. A hit
becomes a layer **beneath** the config and runtime override layers and **above**
the fixture - the composition at `handler.ts:594` becomes
`[...linkLayer, ...config.bodies(...), ...runtimeBodies]` with the fixture still
passed as `fixtureLayer`.

Per design §4.4, only a success status recalls.

- [ ] **Step 6: Wire recording in `capture.ts`**

The `link` kind resolves `from.key` against the **response**, then records
`remember`. Per design §4.2, special-case a `remember` of exactly
`{$response.body}` / `{$request.body}` and take `responseBody` / `requestBody`
directly - `resolveExpression` funnels through `scalar()` and returns a failure
for an object. Pointer forms addressing a scalar go through `resolveExpression`.

- [ ] **Step 7: Write the end-to-end test**

```ts
// test/server/link-e2e.test.ts
test('an id minted by a POST resolves on the matching GET', async () => {
  const mock = createMock(doc, {
    link: [{ from: { target: 'createOrder', key: '{$response.body#/id}' },
             to:   { target: 'getOrder',    key: '{$request.path.id}' } }]
  })
  const created = await (await mock.fetch(new Request('http://mock/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  }))).json() as { id: string }

  const read = await (await mock.fetch(
    new Request(`http://mock/orders/${created.id}`))).json()
  assert.deepEqual(read, created)

  // The load-bearing half: an id the mock never minted must NOT recall.
  // Without this, the test passes even if recall returns the last recorded
  // value for every key.
  const other = await (await mock.fetch(
    new Request('http://mock/orders/never-minted'))).json() as { id: string }
  assert.notEqual(other.id, created.id)
})
```

- [ ] **Step 8: Write the determinism test**

Two `createMock` instances with the same seed, driven through the **same
request sequence**, must produce byte-identical bodies at every step - design
§4.5's amended invariant 2.

- [ ] **Step 9: Validate the mutation**

**Mutate exactly this:** in the stage 7.5 recall, drop the key from the lookup
so it recalls the most recent entry regardless of key. Expected: the
`never-minted` assertion in Step 7 fails. Quote it. Restore.

- [ ] **Step 10: Typecheck, full suite, commit**

```sh
git add src/runtime/link.ts src/runtime/capture.ts src/server/handler.ts src/index.ts test/runtime/link.test.ts test/server/link-e2e.test.ts
git commit -m 'feat: response linking for create-then-read loops' -m 'A recall table, not a CRUD engine: a write records its generated response against a key it minted, and a read whose key matches replays those bytes. A miss falls through to ordinary generation. Bounded at 1000 entries and one hour, because a recall table is unbounded by construction.'
```

---

### Task 4: Variant selection in the schema walk

**Files:**
- Modify: `src/schema/walk.ts` (a `variantName` helper),
  `src/generate/generate.ts:10-17,70-71`
- Test: `test/schema/walk.test.ts`, `test/generate/generate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function variantName(branch: Schema, discriminator?: string): string | undefined
  ```
  and `GenerateOptions.variant?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
test('variantName reads a formal discriminator property', () => {
  const branch = { type: 'object', properties: { outcome: { const: 'created' } } }
  assert.equal(variantName(branch, 'outcome'), 'created')
})

test('variantName falls back to any const-valued property', () => {
  // No discriminator argument: the common shape, which carries no
  // `discriminator` object at all.
  const branch = { type: 'object', properties: { outcome: { const: 'conflict' } } }
  assert.equal(variantName(branch, undefined), 'conflict')
})

test('variantName ignores a non-const property', () => {
  const branch = { type: 'object', properties: { id: { type: 'string' } } }
  assert.equal(variantName(branch, 'id'), undefined)
})
```

```ts
// test/generate/generate.test.ts additions
const union = {
  oneOf: [
    { type: 'object', properties: { outcome: { const: 'created' }, id: { type: 'string' } } },
    { type: 'object', properties: { outcome: { const: 'conflict' } } }
  ]
}

test('a requested variant selects its branch', () => {
  const value = generateValue(union, createRng('s'), { variant: 'conflict' }) as Record<string, unknown>
  assert.equal(value.outcome, 'conflict')
  // Assert the branch, not just the discriminator: a branch chosen by luck
  // would also carry the right outcome half the time.
  assert.equal('id' in value, false)
})

test('an unmatched variant falls through to the seeded pick', () => {
  const seeded = generateValue(union, createRng('s'), {})
  const unmatched = generateValue(union, createRng('s'), { variant: 'nonexistent' })
  assert.deepEqual(unmatched, seeded)
})

test('variant selection is deterministic', () => {
  assert.deepEqual(
    generateValue(union, createRng('s'), { variant: 'created' }),
    generateValue(union, createRng('s'), { variant: 'created' })
  )
})
```

- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** `variantName` in `walk.ts` beside `classify`
  (invariant 1 - schema interpretation lives in one module). The `union` case
  in `generate.ts` consults `options.variant` and falls back to `rng.pick`.
- [ ] **Step 4: Run and watch pass.**
- [ ] **Step 5: Validate the mutation.** **Mutate exactly this:** make the
  union case ignore `options.variant` entirely (delete the lookup, keep
  `rng.pick`). Expected: `a requested variant selects its branch` fails on
  `outcome`. Quote it. Note that the *fall-through* test still passes under
  this mutation by design - that is correct, it is testing the other branch.
- [ ] **Step 6: Typecheck and commit.**

```sh
git commit -m 'feat: select a oneOf branch by its discriminator value' -m 'classify already extracted discriminator.propertyName and generation ignored it. A branch also matches on any const-valued property, which covers the common shape that carries no discriminator object. An unmatched name falls through to the seeded pick, matching Prefer: status.'
```

---

### Task 5: `Prefer: variant=`, `set_variant` state, and the Mock surface

**Depends on Task 4.**

**Files:**
- Create: `src/runtime/variant.ts`
- Modify: `src/server/handler.ts` (read the directive near line 430; the
  generateOptions at line 443 **only**), `src/index.ts`
- Test: `test/runtime/variant.test.ts`, `test/server/variant.test.ts`

**Interfaces:**
- Produces: `variantKey(targetKey: string): string`,
  `readVariant(store, operation): Promise<string | undefined>`;
  `Mock.setVariant(target, name)`, `Mock.clearVariants(target?)`.

- [ ] **Step 1: Write the failing tests**

```ts
test('Prefer: variant= selects the branch', async () => {
  const mock = createMock(unionDoc)
  const body = await (await mock.fetch(new Request('http://mock/upsert', {
    method: 'POST', headers: { prefer: 'variant=conflict' }
  }))).json() as Record<string, unknown>
  assert.equal(body.outcome, 'conflict')
})

test('a stored variant applies with no Prefer header', async () => {
  const mock = createMock(unionDoc)
  await mock.setVariant('upsert', 'conflict')
  const body = await (await mock.fetch(
    new Request('http://mock/upsert', { method: 'POST' }))).json() as Record<string, unknown>
  assert.equal(body.outcome, 'conflict')
})

test('Prefer beats the stored variant', async () => {
  // Two DIFFERENT names, so whichever wins is unambiguous. Storing and
  // requesting the same name would pass under either precedence.
  const mock = createMock(unionDoc)
  await mock.setVariant('upsert', 'created')
  const body = await (await mock.fetch(new Request('http://mock/upsert', {
    method: 'POST', headers: { prefer: 'variant=conflict' }
  }))).json() as Record<string, unknown>
  assert.equal(body.outcome, 'conflict')
})

test('clearVariants removes the stored preference', async () => {
  const mock = createMock(unionDoc)
  await mock.setVariant('upsert', 'conflict')
  await mock.clearVariants('upsert')
  const first = await (await mock.fetch(
    new Request('http://mock/upsert', { method: 'POST' }))).json()
  const fresh = createMock(unionDoc)
  const baseline = await (await fresh.fetch(
    new Request('http://mock/upsert', { method: 'POST' }))).json()
  assert.deepEqual(first, baseline)
})
```

- [ ] **Step 2–4:** fail, implement, pass. Store key `variant|<targetKey>`,
  following `overrideKey`'s pattern exactly. `setVariant` resolves the target
  through `resolveTarget` so a typo throws at call time.
- [ ] **Step 5: Confirm the deliberate non-wiring.** Assert that a webhook
  payload containing a union is **not** steered by a `Prefer: variant=` header
  on the triggering request (design §5.4). This is a real assertion, not a
  comment.
- [ ] **Step 6: Validate the mutation.** **Mutate exactly this:** swap the
  precedence so the stored value wins over `Prefer`. Expected: `Prefer beats
  the stored variant` fails with `created`. Quote it.
- [ ] **Step 7: Typecheck, full suite, commit.**

---

### Task 6: Idempotency key from a body pointer

**Files:**
- Modify: `src/runtime/idempotency.ts:9-31,85-92,156-171`, `src/server/handler.ts`
- Test: `test/runtime/idempotency.test.ts`

**Interfaces:**
- Produces: `IdempotencyConfig.operations?: Record<string, { key: string }>`,
  resolved to `ResolvedIdempotency.operations: Map<string, string>` keyed by
  `targetKey`.

- [ ] **Step 1: Write the failing tests**

```ts
test('an operation with a configured body pointer is idempotent', () => {
  const config = resolveIdempotency({ operations: { deliverEvent: { key: '{$request.body#/meta/requestId}' } } })
  // The document declares NO Idempotency-Key header and config names no
  // method, so the only route to true is the new one.
  assert.equal(isIdempotent(opWithNoKeyHeader, config), true)
})

test('a body pointer that resolves to nothing leaves the request non-idempotent', async () => {
  // Assert the specific outcome - the request executes twice - not merely
  // that no error occurred.
  let runs = 0
  const mock = createMock(doc, {
    idempotency: { operations: { deliverEvent: { key: '{$request.body#/meta/requestId}' } } },
    operations: { deliverEvent: { respond: () => { runs++; return { ok: true } } } }
  })
  const send = () => mock.fetch(new Request('http://mock/events', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta: {} })          // no requestId
  }))
  await send()
  await send()
  assert.equal(runs, 2)
})

test('the same body pointer value replays', async () => {
  let runs = 0
  // A counter, because seeded generation makes two real executions
  // byte-identical - comparing bodies alone passes with idempotency removed.
  const mock = createMock(doc, { /* as above */ })
  const send = () => mock.fetch(new Request('http://mock/events', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta: { requestId: 'r-1' } })
  }))
  await send()
  const second = await send()
  assert.equal(runs, 1)
  assert.equal(second.headers.get('idempotent-replay'), 'true')
})
```

- [ ] **Step 2–4:** fail, implement, pass. `isIdempotent` gains a third
  sufficient route. The stage resolves the pointer through
  `resolveExpression` when a configured key exists, falling back to the header
  otherwise. A pointer resolving to nothing returns `undefined` from the stage,
  exactly as a missing header does today (`idempotency.ts:160-162`).
- [ ] **Step 5: Validate the mutation.** **Mutate exactly this:** make the
  "resolves to nothing" case fall back to the empty string as a key instead of
  returning early. Expected: `runs` is 1, not 2, and the test fails. Quote it.
- [ ] **Step 6: Typecheck, full suite, commit.**

---

### Task 7: Delivery identity

**Files:**
- Modify: `src/webhooks/deliver.ts:11-23`, `src/webhooks/emit.ts`,
  `src/server/handler.ts:283`
- Test: `test/webhooks/deliver.test.ts`

**Test helpers this task defines locally** (no such helper exists in
`test/helpers/`; write them at the top of the test file):

```ts
// Always fails, so retry runs its full attempt budget.
const failingFetch: typeof fetch = async () => new Response('no', { status: 500 })

// Records every outbound call, so a redelivery is observable as a second one.
function recordingFetch() {
  const calls: Request[] = []
  const fn: typeof fetch = async (input, init) => {
    calls.push(new Request(input as never, init))
    return new Response('ok', { status: 200 })
  }
  return Object.assign(fn, { calls })
}
```

Task 8 uses `recordingFetch`; this task uses `failingFetch`. Also pass
`sleep: async () => {}` alongside `failingFetch` so the retry backoff does not
make the test wait in real time.

- [ ] **Step 1: Write the failing tests**

```ts
test('a delivery carries a deterministic id', async () => {
  const a = createMock(doc, { seed: 'fixed', captureOnly: true })
  const b = createMock(doc, { seed: 'fixed', captureOnly: true })
  assert.equal((await a.emit('w')).id, (await b.emit('w')).id)
})

test('successive emissions of one webhook get different ids', async () => {
  const mock = createMock(doc, { seed: 'fixed', captureOnly: true })
  const first = await mock.emit('w')
  const second = await mock.emit('w')
  assert.notEqual(first.id, second.id)
})

test('a retry sequence is one delivery with one id', async () => {
  // attempts > 1 and a single id: the property the redelivery feature exists
  // to make observable.
  const mock = createMock(doc, { seed: 'fixed', fetch: failingFetch, webhooks: { w: { url: 'https://x.example/h', retry: { attempts: 3 } } } })
  const delivery = await mock.emit('w')
  assert.equal(delivery.attempts, 3)
  assert.equal(mock.deliveries().filter((d) => d.id === delivery.id).length, 1)
})
```

- [ ] **Step 2–4:** fail, implement, pass. `id` is
  `fnv1a(`${seed}|delivery|${webhook}|${ordinal}`).toString(16)`, computed in
  `emitWebhook` from the ordinal already feeding the emission rng.
- [ ] **Step 5: Validate the mutation.** **Mutate exactly this:** drop the
  ordinal from the id formula. Expected: `successive emissions get different
  ids` fails. Quote it.
- [ ] **Step 6: Typecheck, full suite, commit.**

---

### Task 8: Redelivery

**Depends on Task 7.**

**Files:**
- Modify: `src/webhooks/emit.ts` (a `redeliver` function), `src/index.ts`
- Test: `test/webhooks/redeliver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('a redelivery reproduces bytes, signature and id', async () => {
  const mock = createMock(doc, { seed: 'fixed', webhooks: { w: { url: 'https://x.example/h', secret: 's' } }, fetch: recordingFetch })
  const first = await mock.emit('w')
  const again = await mock.redeliver(first.id)
  assert.equal(again.id, first.id)
  assert.equal(again.body, first.body)
  assert.equal(again.headers['x-mockingham-signature'], first.headers['x-mockingham-signature'])
  assert.equal(recordingFetch.calls.length, 2)   // it really went out again
})

test('an unknown delivery id throws with an instructive message', async () => {
  const mock = createMock(doc, { captureOnly: true })
  await assert.rejects(() => mock.redeliver('nope'), /no delivery with id "nope"/)
})
```

The second test asserts the **exact** instructive text, not a loose `/id/i` -
plan 8 shipped a regex satisfied by an unrelated error.

- [ ] **Step 2–4:** fail, implement, pass. `redeliver(id)` looks the record up
  in the delivery log, re-sends the recorded body and headers verbatim (design
  §7.3: the signature is replayed, not recomputed), appends a new record with
  the same `id`.
- [ ] **Step 5: Validate the mutation.** **Mutate exactly this:** recompute the
  signature instead of replaying it. Expected: the signature assertion fails.
  Quote it.
- [ ] **Step 6: Typecheck, full suite, commit.**

---

### Task 9: Seeded UUIDv7

**Files:**
- Modify: `src/generate/values.ts:47-54`, `src/generate/generate.ts`,
  `src/index.ts` (`seedTime`)
- Test: `test/generate/values.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('format uuid7 produces a well-formed v7', () => {
  const value = generateString({ type: 'string', format: 'uuid7' }, createRng('s'), clock())
  assert.match(value, V7)
})

test('successive v7 values sort by generation order', () => {
  const c = clock()
  const rng = createRng('s')
  const ids = [0, 1, 2, 3].map(() => generateString({ type: 'string', format: 'uuid7' }, rng, c))
  // The whole point of v7. Sorting must be lexicographic on the raw string.
  assert.deepEqual([...ids].sort(), ids)
})

test('the same seed and seedTime reproduce the same ids', () => {
  const one = generateString({ type: 'string', format: 'uuid7' }, createRng('s'), clock())
  const two = generateString({ type: 'string', format: 'uuid7' }, createRng('s'), clock())
  assert.equal(one, two)
})

test('x-mock-format wins over a plain uuid format', () => {
  const value = generateString(
    { type: 'string', format: 'uuid', 'x-mock-format': 'uuid7' }, createRng('s'), clock())
  assert.match(value, V7)
})

test('plain uuid is still v4', () => {
  // The existing behavior must not move.
  const value = generateString({ type: 'string', format: 'uuid' }, createRng('s'), clock())
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
```

- [ ] **Step 2–4:** fail, implement, pass. The virtual clock is a per-mock
  counter starting at a named `DEFAULT_SEED_TIME` constant - **never**
  `Date.now()` - advancing 1 ms per generated v7. `reset()` returns it to
  `seedTime`.
- [ ] **Step 5: Validate the mutation.** **Mutate exactly this:** make the
  clock step 0 instead of 1. Expected: `successive v7 values sort by generation
  order` fails, because equal timestamps leave ordering to the random bits.
  **Validate this one carefully - if the random bits happen to ascend for your
  seed, the test passes and is worthless.** If that happens, use more values
  (say 20) so the probability collapses, and say so in your report.
- [ ] **Step 6: Typecheck, full suite, commit.**

---

### Task 10: MCP read tools, and deferred item 29

**Depends on Tasks 2, 3, 6.**

**Files:**
- Modify: `src/mcp/tools/read.ts`
- Test: `test/mcp/read.test.ts`

- [ ] **Step 1:** Write failing tests for `list_registrations` (returns URLs,
  sorted), `describe_operations` carrying `linksFrom`/`linksTo`/
  `registersWebhook`/`unregistersWebhook`/`idempotencyKey`, and `list_webhooks`
  carrying `registry` **without** URLs (design §9).
- [ ] **Step 2:** Write failing tests for the three item-29 residuals:
  (a) `findOperation` with a mismatched `method` alongside a valid
  `operationId` must raise rather than silently ignore the mismatch;
  (b) `list_webhooks` `emittedBy` must include a callback's declaring operation
  even when a configured emitter exists elsewhere - **the fixture needs both**,
  or the test cannot fail; (c) a recursive webhook payload schema must come
  back as the `$comment` placeholder, not `undefined`.
- [ ] **Step 3–4:** implement, pass.
- [ ] **Step 5: Validate each mutation separately.** Item 29's three fixes are
  independent; reverting them one at a time is the only way to know all three
  tests bite (the plan-7 lesson: two paths where one masks the other).
- [ ] **Step 6: Typecheck, full suite, commit.**

---

### Task 11: MCP write tools

**Depends on Tasks 2, 5, 8.**

**Files:**
- Modify: `src/mcp/tools/write.ts`, `src/mcp/context.ts`
- Test: `test/mcp/write.test.ts`, and the pinned inventory test

Five new tools: `set_variant`, `clear_variants`, `redeliver_webhook`,
`register_webhook_destination`, `unregister_webhook_destination`.

- [ ] **Step 1:** Write the failing tests, one per tool, asserting the tool's
  effect through the mock rather than its return value alone.
- [ ] **Step 2:** Update the pinned tool inventory: read tools 7 → 8, write
  tools 7 → 12, `mcpTools({ write: true })` 14 → 20 (design §10). **This test
  is pinned deliberately (commit `13c012b`) - a different number means a
  defect, not a stale test.**
- [ ] **Step 3:** Follow `clear_overrides`'s precedent for `clear_variants`:
  the no-target case echoes `null`, never `'*'`, because a bare `'*'` is not a
  valid target and would teach a caller a string that throws.
- [ ] **Step 4–5:** implement, pass, typecheck, full suite, commit.

---

### Task 12: Documentation

**Depends on all prior tasks.**

**Files:**
- Modify: `README.md`, `docs/webhooks.md`, `docs/mcp.md`
- Test: `test/docs/docs.test.ts` (the existing harness runs every fence)

**The harness constrains how you write:** one program per document with state
carried across `ts` fences; `console.log` takes a **single** argument on **one**
line; imports use the bare `'mockingham'` specifier; `listen()` needs
`close()`; the sandbox cwd holds `docs/example.json` copied as `openapi.json`.
Every `console` fence is diffed byte-for-byte against real output.

- [ ] **Step 1:** `docs/webhooks.md` - the registry, scoping, the `unresolved`
  outcome when nothing is registered, redelivery and delivery ids.
- [ ] **Step 2:** `README.md` - `Prefer: variant=`, response linking (with the
  explicit "this is not stateful CRUD" boundary), `seedTime` and `uuid7`.
- [ ] **Step 3:** `README.md` Known limitations - all six from design §13.
- [ ] **Step 4:** `docs/mcp.md` - the five new write tools and
  `list_registrations`, with the corrected counts.
- [ ] **Step 5:** Run `npm test` and fix every byte-level fence mismatch.
- [ ] **Step 6:** Commit.

---

### Task 13: The tracked ledger

**Files:**
- Modify: `docs/superpowers/deferred-items.md`

- [ ] **Step 1:** Mark item 29 (a, b, c) **DONE, plan 11**, citing Task 10's
  commit.
- [ ] **Step 2:** Restate item 28 (`pattern` ignored by generation) as
  explicitly **still open**, with design §1.1's reasoning for why plan 11 did
  not close it despite shipping `uuid7`. A reader who sees UUID work land and
  item 28 untouched will otherwise assume it was missed.
- [ ] **Step 3:** Record design §13's six limitations as new numbered items.
- [ ] **Step 4:** Commit.

---

## Post-plan: whole-branch review

Not a task - the coordinator runs this after Task 13, per this project's
established cycle: a whole-branch review on the most capable model, ONE fix
wave, ONE scoped re-review. The reviewer is asked to **reproduce mutations
rather than accept the implementer's claim of them** - plan 9's highest-value
review instruction - and to evaluate the coordinator's rulings rather than
accept them.

Specific things to point the reviewer at:

1. **Task 1's refactor**, against design §12's four constraints.
2. **The seam between Tasks 2 and 3** - both write through `capture.ts`, and
   this project's two worst defects were each at a seam where both sides were
   individually correct.
3. **Whether the amended invariant 2 (design §4.5) actually holds** for the
   combination of linking, delivery ids, and the v7 clock in one sequence.

# mockingham regenerate_fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last deferral. Ship `regenerate_fixture` as a scoped
re-bake, and `list_fixtures` as the read tool that makes it verifiable.

**Architecture:** `bake()` already plans, chunks, narrows, hashes and stores.
A scoped re-bake is that pipeline with a filter applied in the planning loop it
already runs — not a second entry point. The MCP tools are thin adapters over
`Mock.bake({ only })` and the fixture store's `records()`, which is the same
"exposure over existing core" shape the twelve phase-10 tools have.

**Tech Stack:** TypeScript run directly by Node 24's native type stripping,
`node:test`, `zod`, `@modelcontextprotocol/sdk` (optional peer, devDependency).

**Spec:** `docs/superpowers/specs/2026-08-15-mockingham-regenerate-design.md`
Read it before Task 1. The master contract is
`docs/superpowers/specs/2026-08-11-mockingham-design.md`; the delta wins where
they disagree — including on what the tool IS, which the two documents describe
differently.

## Global Constraints

- **Node >= 24.2.0**, ESM, **erasable syntax only**: no `enum`, no `namespace`,
  no parameter properties. Use `const X = {...} as const`.
- **The core stays pure.** `src/fixtures/bake.ts` imports no `node:` module.
- **Determinism.** `records()` is already sorted; do not re-sort output by
  anything derived from object key order.
- **One schema interpretation.** The filter goes inside the existing walk. Do
  not add a second traversal, and do not write a `regenerate()` beside `bake()`.
- **US English spelling** everywhere.
- **One plain command per Bash call, with literal arguments.** No `&&`, `||`,
  `;`, pipes, `$(...)`, `VAR=value` prefixes, heredocs, `>` redirects, or `cd`.
- `git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy.
- Tests live in `test/` mirroring `src/`. Write the test first, watch it fail.
- `npm test` starts at 1050 passing; `npx tsc --noEmit` must stay clean.
- **`docs/mcp.md` is executed and byte-compared, and Task 4 changes its tool
  count and inventory — expect it to go red there by design.**

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `test/fixtures/regenerate.test.ts` | The bake filter: targeting, errors, skips, replacement |
| `test/mcp/fixture-tools.test.ts` | Both new tools, gate open and closed |

**Modified:**

| File | Change |
|---|---|
| `src/fixtures/bake.ts` | `BakeScope`, `only`, the planning-loop filter, the no-match throw |
| `src/index.ts` | `bake(options?)`, `fixtures()` on `Mock` |
| `src/mcp/context.ts` | `bake` and `fixtures` on `McpContext` and `McpContextSource` |
| `src/mcp/tools/write.ts` | `regenerateFixture`, added to `WRITE_TOOLS` |
| `src/mcp/tools/read.ts` | `listFixtures`, added to `READ_TOOLS` |
| `src/server/cli.ts` | `MCP_USAGE`'s write-tool list: seven names to eight |
| `test/mcp/write.test.ts` | The literal seven-name arrays become eight |
| `test/mcp/override-tools.test.ts` | Heading, and the now-empty `notShipped` list |
| `docs/mcp.md` | Fourteen → sixteen, both tools, and the false `regenerate_fixture` description |
| `docs/fixtures.md` | The regenerate loop in prose |
| `docs/superpowers/specs/2026-08-11-mockingham-design.md` | §1 `bake` signature, §15 write-tool scope sentence |
| `docs/superpowers/deferred-items.md` | Close the phase 10 deferral |

**Ordering rationale:** the core filter lands first and is testable on its own
through `bake()` with no MCP involved. Then the write tool, then the read tool
that verifies it, then documentation — which is last because it must describe
what actually shipped, and because it is the task most likely to move fences.

---

## Task 1: The bake filter

**Files:**
- Modify: `src/fixtures/bake.ts`, `src/index.ts`
- Test: `test/fixtures/regenerate.test.ts`

**Interfaces:**
- `BakeScope { operationId?, method?, path?, status? }`
- `BakeOptions.only?: BakeScope`
- `Mock.bake(options?: { only?: BakeScope }): Promise<BakeSummary>`

- [ ] **Step 1: Write the failing tests**

```ts
test('a filter bakes one operation and leaves the rest alone', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(twoOperationDoc), store, source: sourceReturning({ a: 1 }),
    compiler: createCompiler(), now: () => 0,
    only: { operationId: 'listUsers' }
  })
  // Both halves matter: the count AND that the other operation is absent.
  assert.equal(summary.generated, 1)
  assert.deepEqual(store.records().map((r) => r.operationId), ['listUsers'])
})

test('a filter narrows to one status', async () => { /* only: {operationId, status: 404} */ })

test('method and path select the same operation as operationId', async () => {
  // Two routes to one operation; assert they store the SAME key, not merely
  // that each stores something.
})

test('a mismatched operationId and method/path pair throws', async () => {
  // Deliberately not repeating findOperation's residual (item 29a), which
  // ignores method/path whenever operationId is supplied.
  await assert.rejects(
    () => bake({ ...base, only: { operationId: 'listUsers', method: 'get', path: '/other' } }),
    /disagree/
  )
})

test('an unknown operation throws rather than reporting a successful no-op', async () => {
  await assert.rejects(() => bake({ ...base, only: { operationId: 'nope' } }), /nope/)
})

test('a status the operation does not declare throws', async () => {
  await assert.rejects(() => bake({ ...base, only: { operationId: 'listUsers', status: 418 } }), /418/)
})

test('a matched operation with nothing bakeable is skipped, not an error', async () => {
  // Non-JSON content. The distinction the design draws: "you named something
  // that does not exist" throws; "what you named cannot be baked" reports.
  const summary = await bake({ ...base, only: { operationId: 'textOnly' } })
  assert.equal(summary.skipped, 1)
  assert.equal(summary.generated, 0)
})

test('regenerating replaces the stored entry rather than appending', async () => {
  // The source MUST return a different value the second time. With an
  // identical value this passes with the whole write removed — determinism
  // makes replace-vs-noop invisible, shape 4 in the test-cannot-fail ledger.
  const store = createMemoryFixtureStore()
  await bake({ ...base, store, source: sourceReturning({ round: 'first' }) })
  await bake({ ...base, store, source: sourceReturning({ round: 'second' }),
              only: { operationId: 'listUsers' } })
  const records = store.records().filter((r) => r.operationId === 'listUsers')
  assert.equal(records.length, 1, 'replaced, not appended')
  assert.deepEqual(records[0]?.entry.value, { round: 'second' })
})

test('a filter still respects maxCalls, reporting the remainder as skipped', async () => {})
```

- [ ] **Step 2: Implement**

In `bake.ts`, resolve the filter to a predicate BEFORE the walk, so a no-match
can throw once rather than being discovered per-response:

```ts
function matches(operation: Operation, only: BakeScope): boolean {
  if (only.operationId !== undefined && operationSlug(operation) !== only.operationId) return false
  if (only.method !== undefined && operation.method !== only.method.toLowerCase()) return false
  if (only.path !== undefined && operation.path !== only.path) return false
  return true
}
```

Note `operationSlug`, not `operation.operationId` — the slug is what the store
is keyed by, and an operation without a declared id still has one.

Then: if `only` is set and no operation matches, throw naming what was asked
for. If `only.status` is set and no matched operation declares it, throw. Inside
the response loop, `continue` when `only.status !== undefined && response.status
!== only.status`.

In `index.ts`, `bake(bakeOptions)` passes `only` straight through. The existing
no-source throw stays exactly as it is and is checked first — a regenerate with
no source configured must say so, not report a filter miss.

- [ ] **Step 3: Verify by mutation**

Three, one at a time:
1. Make `matches` always return `true`. The one-operation test must fail on the
   `records()` assertion, not only on the count.
2. Remove the no-match throw. The unknown-operation test must fail — and check
   it fails on the rejection rather than passing because something else threw.
3. Make the second `bake` a no-op. The replacement test must fail on the value,
   which is what the differing source values are for.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`.

---

## Task 2: `regenerate_fixture`

**Files:**
- Modify: `src/mcp/context.ts`, `src/mcp/tools/write.ts`, `src/index.ts`
- Test: `test/mcp/fixture-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('regenerate_fixture re-runs the source for one operation', async () => {})

test('regenerate_fixture reports the summary rather than a bare ok', async () => {
  // An agent that gets {ok: true} for a run that skipped everything has been
  // misinformed. Assert generated/skipped/failed reach the caller.
})

test('regenerate_fixture without an llm source refuses with an actionable message', async () => {
  await assert.rejects(..., /llm source/)
})

test('regenerate_fixture is absent when write tools are disabled', async () => {
  // Same gate shape the other seven write tools already have.
})
```

- [ ] **Step 2: Implement**

`McpContext` and `McpContextSource` gain `bake(options?)`. Add it to the
`createMcpContext` literal — the doc comment there says it is the one
construction path precisely so a second literal cannot drift.

The tool takes `operationId`, `method`, `path`, `status` and passes them as
`only`. It does **not** take a budget: §5 of the design — a tool that can raise
its own spending limit can spend without asking.

- [ ] **Step 3: Verify by mutation** — drop `regenerateFixture` from
`WRITE_TOOLS` and confirm the gate test fails for absence rather than passing
because the tool was never found either way.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`.

---

## Task 3: `list_fixtures`

**Files:**
- Modify: `src/mcp/context.ts`, `src/mcp/tools/read.ts`, `src/index.ts`
- Test: `test/mcp/fixture-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('list_fixtures reports what is stored, without values by default', async () => {})

test('includeValues returns the stored value', async () => {})

test('stale flips to true when the document moves under a fixture, and back after regenerating', async () => {
  // Both halves in one test on purpose: `stale: true` alone passes against a
  // hardcoded true, and `stale: false` alone passes against a hardcoded false.
})

test('list_fixtures is available with write tools disabled', async () => {
  // It is a read tool. If it needs the gate, it is in the wrong registry.
})
```

- [ ] **Step 2: Implement**

`Mock.fixtures()` returns `fixtureStore.records()`. `McpContext.fixtures`
likewise. `stale` compares `entry.meta?.schemaHash` against
`schemaHashLookup(api, compiler)(operationId, status)` — the same helper the
startup check uses, so the two can never disagree about what stale means.

An entry with no stored `schemaHash` is **not** stale — it predates hashing or
came from a schema neither path can convert. Say so in a comment; reporting it
stale would send an agent regenerating something that is fine.

- [ ] **Step 3: Verify by mutation** — hardcode `stale: true`, then `false`.
Each must fail one half of the paired test.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`.

---

## Task 4: Documentation, help text, and the inventory

**Files:**
- Modify: `docs/mcp.md`, `docs/fixtures.md`, `src/server/cli.ts`,
  `test/mcp/write.test.ts`, `test/mcp/override-tools.test.ts`,
  `docs/superpowers/specs/2026-08-11-mockingham-design.md`,
  `docs/superpowers/deferred-items.md`

- [ ] **Step 1: `docs/mcp.md`**

- `## The fourteen tools` → `## The sixteen tools`, and the inventory test's
  heading literal with it.
- "Seven write tools" → eight, in both places.
- Add both tools to the inventory bullets.
- **Delete the `## What isn't here yet` section, or replace its content.** It
  currently describes `regenerate_fixture` as "a tool to save a live-generated
  response as a committed fixture", which is not what shipped and was never
  what master §15 specified. Correcting the sentence is not enough — the
  section's whole purpose was to name the deferral, and there is none left.

- [ ] **Step 2: The inventory test**

`notShipped` becomes empty. **An empty array makes that loop vacuous**, which is
the exact defect class this project tracks. Replace it with an assertion that
the deferral section is gone — `assert.equal(guide.indexOf("## What isn't here
yet"), -1)` — so the check still has teeth. Do not leave `const notShipped = []`
in place with a loop over it.

- [ ] **Step 3: `src/server/cli.ts`** — `MCP_USAGE`'s write-tool list gains
`regenerate_fixture`. `test/mcp/cli-mcp.test.ts` may assert on this text.

- [ ] **Step 4: `docs/fixtures.md`** — the regenerate loop in prose: bake once,
find a stale fixture with `list_fixtures`, regenerate that one. Any runnable
block is executed and byte-compared.

- [ ] **Step 5: The master spec** — §1's `bake()` signature gains the optional
argument and `fixtures()` joins the instance surface; §15's "Write tools mutate
only runtime state" is amended per design §6.

- [ ] **Step 6: The ledger** — close the phase 10 deferral, and record that
`docs/mcp.md` had described the tool incorrectly for a full cycle. Note in the
entry that **nothing is deferred after this**, so the next reader knows the list
is the non-blocking one.

- [ ] **Step 7:** Full `npm test`, `npx tsc --noEmit`, `node --test test/docs/`.

---

## Verification

- `npm test` green at 1050 + the new tests.
- `npx tsc --noEmit` clean.
- `mcpTools({ write: true })` returns sixteen; `mcpTools()` returns eight.
- A regeneration replaces one stored entry and updates its `generatedAt` and
  `schemaHash`, leaving every other entry untouched.
- `list_fixtures` reports `stale: true` for a fixture whose schema moved, and
  `false` after regenerating it.
- `docs/mcp.md` names no deferred tool, because there is none.

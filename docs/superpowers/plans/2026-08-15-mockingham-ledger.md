# mockingham Ledger-Clearing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empty `docs/superpowers/deferred-items.md`. Every entry reaches a
terminal state - fixed, or closed as deliberate with the ruling recorded.

**Spec:** `docs/superpowers/specs/2026-08-15-mockingham-ledger-design.md`, which
carries a ruling per item. Read it before Task 1. The master contract is
`docs/superpowers/specs/2026-08-11-mockingham-design.md`; the delta wins.

## Global Constraints

- **Node >= 24.2.0**, ESM, **erasable syntax only**.
- **The core stays pure.** `handler.ts` and its imports touch no `node:` API.
- **Determinism.** Nothing here may add a nondeterministic source.
- **US English spelling** everywhere.
- **One plain command per Bash call, with literal arguments.**
- `git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy.
- Write the test first, watch it fail, then implement.
- `npm test` starts at 1076 passing; `npx tsc --noEmit` must stay clean.
- **Task 5 will make guides fail that currently pass.** Those are real findings
  the harness could not see before - fix the guide, never loosen the check back.

---

## Task 1: Idempotency and the Store - items 15, 17, 19

**Files:** `src/runtime/store.ts`, `src/runtime/idempotency.ts`,
`src/server/handler.ts`, `test/runtime/store.test.ts`,
`test/server/idempotency.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('setIfAbsent creates once and reports which call won', async () => {
  const store = createMemoryStore(() => 0)
  assert.equal(await store.setIfAbsent('k', 'first'), true)
  assert.equal(await store.setIfAbsent('k', 'second'), false)
  assert.equal(await store.get('k'), 'first', 'the loser must not overwrite')
})

test('setIfAbsent treats an expired entry as absent', async () => {
  // Lazy expiry: an entry past its deadline is gone, so the claim succeeds.
})

test('two concurrent identical requests execute the operation once', async () => {
  // The item's own probe: plan 5 measured `runs: 2`, both 201.
  // A counter in `respond`, NOT a body comparison - determinism makes two
  // responses identical whether one or both executed (ledger shape 4).
  let runs = 0
  // ...fire two mock.fetch calls with the same Idempotency-Key WITHOUT
  // awaiting the first, then await both.
  assert.equal(runs, 1)
})

test('a failed body capture stores nothing, so a retry can succeed', async () => {
  // Ruled by the user. Previously stored { body: null }, pinning a bodiless
  // replay for the whole TTL.
})
```

- [ ] **Step 2: Implement**

`Store` gains `setIfAbsent(key, value, ttlMs?): Promise<boolean>` - required,
not optional (design §2.1). `createMemoryStore` implements it against the same
lazy-expiry `live()` helper `get` uses, so an expired entry counts as absent.

The claim in `idempotency.ts` inverts: **attempt the claim first**; on failure,
read the entry and run the existing mismatch / in-flight / replay logic. Do not
keep the leading `get` as a fast path - two ways to reach the same decision is
how the seam drifts.

Item 17: in `handler.ts`, when `captureBody` fails, release the in-flight
marker and store nothing.

- [ ] **Step 3: Item 19** - make the inert test do what its name says, or
rename it to what it proves. It may not keep a name describing uncovered
behavior.

- [ ] **Step 4: Verify by mutation** - revert `setIfAbsent` to `set`; the
concurrency test must fail with `runs: 2`. **Validate this bites before
trusting it**: if the two requests are not genuinely overlapping, the test
proves nothing.

- [ ] **Step 5:** `npx tsc --noEmit`, full `npm test`.

---

## Task 2: The response guarantee and timers - items 16, 24, 25, 26

**Files:** `src/server/handler.ts`, `test/server/robustness.test.ts`,
`test/server/webhooks.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('a clock that throws still produces a response', async () => {
  const mock = createMock(doc, { now: () => { throw new Error('clock') } })
  const response = await mock.fetch(new Request('http://mock/x'))
  assert.equal(typeof response.status, 'number')
})

test('a throwable whose toString throws still produces a response', async () => {})

test('reset() clears pending emission timers', async () => {
  // settled() right after reset() blocked for the full afterMs - 3005ms
  // measured for 3000. Assert promptness, or assert on the tracked timer set.
})

test('close() clears the underlying timer, not just the wait', async () => {
  // Item 24: the obvious version of this passes WITHOUT the fix. The mutation
  // is deleting ONLY clearTimeout(entry.handle), leaving entry.resolve().
})
```

- [ ] **Step 2: Implement** - guard the `startedAt` clock read (fall back to
`0`) and `String(error)`; make `reset()` clear and resolve `pendingTimers` as
`close()` does; race `closedSignal` only when `options.sleep` was injected
(design §3.4).

- [ ] **Step 3: Verify by mutation** - four, one at a time. §3.3's is the one
whose whole point is that the naive test passes without it.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`.

---

## Task 3: MCP residuals - items 29a, 29b, 29c, 32

**Files:** `src/mcp/tools/read.ts`, `src/mcp/server.ts`, `docs/mcp.md`,
`test/mcp/describe.test.ts`, `test/mcp/search-webhooks.test.ts`

- [ ] **Step 1: Write the failing tests** - a mismatched `operationId` +
`method`/`path` pair throws (for each of the three tools that resolve one); a
webhook with both a declaring operation and a configured emitter reports both;
a recursive webhook payload comes back as the `$comment` placeholder.

- [ ] **Step 2: Implement** - `findOperation` checks every supplied field;
`emittedBy` is the deduplicated union; `payloadSchema` routes through
`jsonSchemaOf`; the `McpOptions.transport` JSDoc says what actually happens.

- [ ] **Step 3: `docs/mcp.md`** - the prose documenting 29a's
silently-ignore behavior describes something that is no longer true and must
go. The 29b/29c prose likewise. The guide is executed; expect fences to move.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`, `node --test test/docs/`.

---

## Task 4: Packaging - item 27

**Files:** `package.json`, `README.md`

- [ ] **Step 1:** Add the strict `exports` map and a `files` field (design §5).

- [ ] **Step 2: Prove it holds.** A test that the package's own entry resolves
and that a deep import does not. If that cannot be tested in-process without a
published install, say so in the commit rather than writing a test that only
looks like it checks something.

- [ ] **Step 3:** `npm test` - the whole suite deep-imports `src/…` by relative
path, which `exports` does not govern, so nothing should move. If something
does, that is a finding: it means a test was resolving through the package name.

- [ ] **Step 4: README** - state the supported import surface, since it is now
enforced rather than conventional.

---

## Task 5: The docs harness - items 34–41

**Files:** `test/docs/fence-checks.ts`, `test/docs/harness.ts`,
`test/docs/docs.test.ts`, and whichever guides the new checks catch

- [ ] **Step 1: One shared quote scanner** (item 35) replacing the three
disagreeing loops, with the doubled-backslash case as its test.

- [ ] **Step 2: Widen the stdout check** (34), **pair `console` fences to their
`ts` block** (36), **reject program-shaped `txt`** (37), **check any `args`
array** (38), **raise and report `maxBuffer`** (39), **walk recursively** (40).

- [ ] **Step 3: Each new check needs a document that SHOULD fail it**, proving
it fires. A check added without one is the same defect these items describe.

- [ ] **Step 4: Fix what the new checks catch** in the guides. Item 41's
citation sweep lands here too, since it is a guide edit.

- [ ] **Step 5:** Full `npm test`.

---

## Task 6: Polish, and closing the ledger - items 8, 10–14, 18, 20, 21, 23

**Files:** per design §7, plus `docs/superpowers/deferred-items.md` and
`docs/superpowers/specs/2026-08-11-mockingham-design.md`

- [ ] **Step 1: The four fixes** - 8 (`setSeed` updates `chaosSeed`), 13
(unknown security scheme `type` warns and is dropped), 20 (a throwing log sink
proves the guard), 23 (test cleanup ordering).

- [ ] **Step 2: The audit** - item 11: enumerate every reader of `union.mode`
and record what was found. This is a finding to write down, not a change.

- [ ] **Step 3: Master §7.2** gains item 10's sentence about latency on an
injected failure.

- [ ] **Step 4: Close every entry.** Each gets a terminal status line. The
entries closed as deliberate (12, 14, 18, 21, and 10's behavior half) say so
and say why - they are decisions, not omissions.

- [ ] **Step 5: Rewrite the file's header.** It still calls itself findings
"deliberately deferred rather than fixed" and dates its status to 2026-08-12,
with plan 6 described as unmerged. It is now a record of closed findings.

- [ ] **Step 6:** Full `npm test`, `npx tsc --noEmit`, `node --test test/docs/`.

---

## Verification

- `npm test` green; `npx tsc --noEmit` clean.
- Two concurrent identical idempotent requests execute once.
- `fetch()` resolves under a throwing clock and a throwing `toString`.
- `settled()` after `reset()` returns promptly.
- A mismatched `operationId`/`method`/`path` pair throws in every tool.
- A deep import into `src/` is not resolvable through the package name.
- Every new harness check has a document proving it fires.
- `deferred-items.md` contains no open entry.

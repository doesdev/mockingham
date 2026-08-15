# mockingham — ledger-clearing cycle design delta

**Status:** approved 2026-08-15
**Amends:** `2026-08-11-mockingham-design.md` §11 (state/Store), §7 (failure),
plus packaging, which the master spec never covered
**Implements:** every remaining entry in `docs/superpowers/deferred-items.md`

This is a delta. The master spec is the contract; where this document
contradicts it, this document wins and the reason is stated.

Every numbered phase and every deferred feature is already closed. What is left
is the ledger's own backlog — the findings that were deliberately deferred
rather than fixed, across plans 5 through 12. This cycle empties it.

**What "clearing the ledger" means here, stated because it is not obvious:**
every entry reaches a **terminal** state. Most are fixed. Several are closed as
**deliberate, with the ruling recorded** — a handful of Polish entries exist
precisely because someone decided the change was not worth it (`split()` is
duplicated in two modules; extracting it couples them for little gain), and
"clearing" those by making the change anyway would silently reverse reasoning
that was already settled. An entry that says "we looked, and chose not to" is
closed. It is not open work.

---

## 1. Scope

**In:** items 8, 10–14, 15–21, 23–27, 29a–c, 32, 34–41. That is the whole
remaining file.

**Out:** nothing. That is the point of the cycle.

**Three user rulings shaped it** (2026-08-15):
1. **The `exports` map is strict** — root entry only. §5.
2. **A failed body capture stores nothing** — item 17. §2.3.
3. **Both lists**, correctness and Polish, are in scope.

---

## 2. Idempotency and the Store

### 2.1 Item 15 — the lookup-then-claim race

`createIdempotencyStage` does `store.get(key)` and then `store.set(key, …)`
with no compare-and-set across the await, so two concurrent identical requests
both read `undefined`, both claim, and both execute. Probe-verified in plan 5:
`runs: 2`, both 201. `MOCK_IDEMPOTENCY_IN_FLIGHT` is consequently reachable
only for a *wedged* prior request, never for a real race.

**`Store` gains `setIfAbsent(key, value, ttlMs?): Promise<boolean>`** — true
when this call created the entry. The claim inverts: attempt the claim first,
and only on failure read the entry and run the existing mismatch / in-flight /
replay logic. That is a genuine compare-and-set, and it removes the window
rather than narrowing it.

**The method is REQUIRED, not optional, and this is a breaking change to a
published interface.** An optional CAS that falls back to get-then-set would
reintroduce the exact race the item is about — invisibly, while the mock
advertised atomicity it did not have. One code path and an honest guarantee
beats two paths and a silent downgrade. At 0.1.0, with §5 tightening packaging
in the same cycle, this is the cheapest moment it will ever be.

### 2.2 Item 19 — the inert test half

`an injected 429 is not stored, so a retry re-runs` never increments its
`attempts` counter, because `decide` fires on every call so the `respond`
callback never runs. The name promises re-execution the assertions do not
check. **Fixed by making the test do what its name says**: the counter must
observe two executions. If the injected-failure setup makes that impossible,
the test is renamed to what it actually proves — but it may not keep a name
that describes uncovered behavior.

### 2.3 Item 17 — a failed capture stores nothing

**Ruled by the user: skip storage entirely when `captureBody` failed.** Today
the record is written with `body: null`, so the key replays a bodiless response
for the full TTL — a transient capture failure becomes a persistently wrong
response the client cannot recover from until expiry. Writing nothing lets a
retry re-execute and succeed. The in-flight marker is released either way.

---

## 3. The response guarantee, timers, and shutdown

### 3.1 Item 16 — the last hole in "a response always comes back"

`handle()`'s first line (`const startedAt = now()`) and `internalError()`'s
`String(error)` sit outside every guard, so an injected clock that throws, or a
throwable whose `toString` throws, makes `fetch()` reject with no response.
Both are fixed at the source: the clock read is guarded and falls back to `0`,
and `String(error)` is wrapped so an exotic throwable yields a fixed message
rather than escaping. Invariant: **`fetch()` never rejects**, and this is the
last known way it could.

### 3.2 Item 25 — `reset()` clears pending timers

`close()` clears every real timer in `pendingTimers`; `reset()` only bumps
`generation`. The emission is still correctly dropped, but the underlying
`setTimeout` keeps the event loop open — `settled()` right after `reset()`
blocks for the full `afterMs` (3005ms measured for 3000). **`reset()` now
clears and resolves the tracked timers exactly as `close()` does**, which is
the parity design §2.3 already implied in a single sentence.

### 3.3 Item 24 — the `clearTimeout` half gets an assertion

Deleting `clearTimeout(entry.handle)` from `close()` leaves the suite green:
the race is still unblocked by the resolved promise, and the only difference is
a real timer left running, which nothing measures. **A test asserts the timer
is cleared** — by observing that the process is not held open, or by asserting
on `pendingTimers` being empty after `close()`. Whichever is chosen, the
mutation to validate is deleting *only* the `clearTimeout` call and leaving
`entry.resolve()` in place, because that is the regression the item describes.

### 3.4 Item 26 — the `closedSignal` reaction, narrowed

Every `afterMs > 0` emission races its wait against a module-scoped
`closedSignal`, attaching a reaction released only when `close()` resolves. On
a long-lived `listen()` server that is never closed, those accumulate — bounded
by traffic, tiny, no cycle, so cosmetic rather than a leak.

**Narrowed rather than removed.** The race exists for an *injected* `sleep`,
where there is no timer handle to cancel. The default sleep's timers are
already unblocked by `close()` resolving each `pendingTimers` entry, so racing
`closedSignal` on that path is redundant. **The race now applies only when a
`sleep` was injected**, which is a test-time configuration on a short-lived
mock — so the accumulation no longer happens in the long-lived-server scenario
the item is about.

---

## 4. MCP residuals

**Item 29a — `findOperation` ignores `method`/`path` when `operationId` is
given.** A caller passing a mismatched pair alongside a valid `operationId`
gets silence. Now every supplied field must agree, and disagreement throws.
This is the behavior `bake`'s scope filter already implements (regenerate delta
§4), which deliberately did not reproduce the residual; the two now match.
**Three shipped tools change behavior** — `describe_operation`,
`sample_response`, `get_auth_requirements` — from silently-ignore to throw.
That is the correction, not a side effect, and `docs/mcp.md` documents the old
behavior in prose that must go.

**Item 29b — `list_webhooks` drops the declaring operation.**
`emittedBy: callback !== undefined && configured.length === 0 ? [callback.owner] : configured`
reports the declaring operation only when nothing is configured. The moment any
`emits` config names the webhook, the declaring operation vanishes even when it
is not among the configured emitters. Now it is the **union** of the declaring
operation and the configured emitters, deduplicated, order-stable.

**Item 29c — `payloadSchema` bypasses the `$comment` fallback.** `listWebhooks`
calls `toJsonSchema` directly while every other tool routes through
`jsonSchemaOf`, so a recursive webhook payload comes back `undefined` rather
than the placeholder that tells an agent the shape exists. Routed through the
helper.

**Item 32 — a false JSDoc.** `McpOptions.transport`'s comment says `'stdio'`
"connects immediately". Nothing reads `'stdio'` at all; a handle only talks
JSON-RPC after `connectStdio()`. The same false claim already leaked into
`docs/mcp.md` once and was corrected there while its source was left standing.
Corrected at the source.

---

## 5. Packaging — item 27

**Ruled by the user: strict.**

```json
"exports": {
  ".": "./src/index.ts",
  "./package.json": "./package.json"
}
```

Deep imports stop resolving. `index.ts` already re-exports the store and source
factories precisely so that nothing *needs* one — that export block was added
in plan 7 with a comment noting the deep-import path worked "solely because
package.json declares no `exports` map." This closes that.

**A `files` field lands with it.** There is none, so `npm publish` today ships
`test/`, `docs/`, and every scratch file in the tree. `files` is restricted to
`src` plus the readme and license.

**Why now:** an `exports` map added later is a breaking change for anyone who
found a working deep import in the meantime. At 0.1.0 the blast radius is the
smallest it will ever be, which is the ledger entry's own argument.

`./package.json` is exported because tooling reads it and Node otherwise blocks
even that.

---

## 6. The docs harness — items 34–41

These are all test-infrastructure defects in `test/docs/`. They matter because
the harness is what makes every guide's claims checkable, and a check that
cannot fire advertises coverage that does not exist.

- **34 — `assertPrintableLogs` only scans for `console.log(`.** Any other route
  to stdout is invisible. Now every write to stdout is detected —
  `process.stdout.write`, `console.error`, `console.info`, `console.dir` — and
  anything other than a single-argument `console.log` is rejected with a
  message naming the offending line.
- **35 — three quote-trackers disagree on backslash escapes.** `splitArgs` has
  no escape handling at all, and the other two mis-read a doubled backslash as
  an escaped quote, so `console.log('a\\', payload)` is accepted with two
  arguments. **One shared scanner** replaces all three, so they cannot disagree
  again — the same reasoning as invariant 1 for schemas.
- **36 — nothing ties a `console` fence to the `ts` block above it.**
  `assembleProgram` and `expectedOutput` filter independently by language, so
  only relative order within each language survives. Now the pairing is
  checked: a `console` fence must follow a `ts` fence, and a document that puts
  expected output above the code producing it fails.
- **37 — a `txt` fence is inert.** It has no branch at all, so fabricated
  output in one is never checked. `txt` stays inert by design (the docs-design
  §2.3 table calls it "directory listings and file trees"), but **a `txt` fence
  that looks like program output is now rejected** — the check is on shape, and
  the guide's one legitimate use (a CLI error message) is moved to a fence
  language that says what it is.
- **38 — `checkJsonFence` only inspects `mcpServers`.** A config shaped for a
  host using a different top-level key gets no argument checking while the spec
  describes the check as unconditional. Now any JSON fence containing an
  `args` array of strings is fed through the real parser, whatever key holds it.
- **39 — a >1 MB stdout fails opaquely.** `execFile` runs with the 1 MB
  default, and exceeding it produces a plain "exited 1" with the whole
  truncated megabyte in the message and no mention of `maxBuffer`. Now
  `maxBuffer` is raised and the specific error code is recognized and reported
  by name.
- **40 — the coverage sweep is non-recursive and hardcodes README.**
  `readdir` without `recursive`, so a guide in a subdirectory is never
  discovered; `README.md` is a literal entry, never verified to exist by the
  sweep. Now the walk is recursive and every reader-facing markdown file in the
  repo — including top-level ones — must be either covered or explicitly
  exempted by name.
- **41 — citation style drifts.** Some citations name the source document,
  others give a bare `§4` that could belong to any of three specs. Every
  citation in every guide now names its document.

---

## 7. Polish — fixed, or closed with a ruling

| # | Entry | Ruling |
|---|---|---|
| 8 | `chaosSeed` frozen at construction, `setSeed` does not update it | **Fix.** It is a one-line inconsistency, and "the seed control does not control this seed" is a trap regardless of whether chaos happens to vary anyway. |
| 10 | Latency skipped on an injected failure | **Document, do not change.** A slow outage is arguably more realistic, but changing it alters timing semantics every existing failure test depends on, to no one's benefit. Master §7.2 gains the sentence the entry asks for. |
| 11 | Check nothing else reads `union.mode` expecting the old looseness | **Verify and record.** This is an audit, not a change. Every reader is enumerated and the finding written into the entry. |
| 12 | `OperationConfig`'s numeric index signature could collide with `status`/`respond` | **Closed, cannot occur.** A numeric status key cannot collide with those names. The entry says so already; it is a note, not work. |
| 13 | `toSecuritySchemes` casts with no runtime validation | **Fix, narrowly.** A malformed `type` silently yields an invalid scheme that the auth stage then acts on. An unknown `type` is dropped with a warning through `onWarn` rather than trusted. Leniency elsewhere in the loader stays. |
| 14 | `split()` duplicated in `resolve/target.ts` and `spec/routes.ts` | **Closed, deliberate.** Identical one-liners; extracting couples two modules for little gain. Reversing that reasoning now would be change for its own sake. |
| 18 | A failed body parse consumes a request ordinal | **Closed, documented.** Harmless — `requestId` never feeds the PRNG — but it is an unremarked behavior change from plan 5, so the entry records it as intended rather than accidental. |
| 20 | The log block's `try`/`catch` is untested | **Fix.** Defense in depth is still testable: a sink that throws proves the guard. An untested guard is indistinguishable from an absent one. |
| 21 | `templateFor` duplicates `allowedMethods`' loop | **Closed, deliberate.** Same reasoning as 14. |
| 23 | Test `finally` closes `mock` before `hook`, leaking a socket if the first throws | **Fix.** Cheap, and the failure mode is a hung test run, which is the worst way to learn about it. |

---

## 8. What does not change

**Invariants 1–6 all hold.** The one that gets closer scrutiny is 2: nothing
here adds a source of nondeterminism, and §3.4 removes a `Promise.race` from
the default path rather than adding one.

**Invariant "a response always comes back"** is strengthened, not touched —
§3.1 closes its last hole.

**`Store` is the one published interface that breaks** (§2.1), deliberately and
at the cheapest possible moment.

**The docs harness changes will surface guide errors.** §6 makes several checks
fire that never could before, and each may fail against guides written while
they were inert. Those are real findings, not regressions of this cycle, and
must be fixed in the guides rather than by loosening the check back.

---

## 9. Testing

Everything that fixes behavior gets a test with a named mutation. Three
specifically:

- **§2.1** needs a test that genuinely races — two concurrent requests through
  one handler, asserting the operation executed **once**. Comparing two
  responses proves nothing here: determinism makes them identical whether one
  or both executed, which is shape 4 in the test-cannot-fail ledger. A counter
  in a `respond` callback is the observation.
- **§3.1** needs a clock that throws and a throwable whose `toString` throws,
  asserting `fetch()` resolves rather than rejects.
- **§3.3** is the item whose whole point is that the obvious test passes
  without the fix. Validate the mutation before trusting the test.

For §6, each harness check needs a document that *should* fail it, proving the
check fires — a check added without one is the same defect the items describe.

---

## 10. What this leaves

Nothing. `docs/superpowers/deferred-items.md` becomes a record of closed
findings rather than a backlog, and the file's own header — which still
describes it as findings "deliberately deferred rather than fixed at the time"
and dates its status to 2026-08-12 — is rewritten to say what it now is.

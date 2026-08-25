# Findings ledger

Findings raised by code review across plans 2–13, each with the ruling that
resolved it. **Nothing here is open.** Every entry is either fixed or closed as
a deliberate choice with the reasoning recorded - and the difference matters:
several entries exist precisely because someone decided a change was not worth
making, and "clearing" those by making it anyway would silently reverse a
decision that was already settled.

This file is tracked in git on purpose. The SDD ledgers that originally held these
live under `.superpowers/` inside per-plan worktrees, which is gitignored scratch -
one `git worktree remove` and the reasoning is gone. Anything here is meant to
survive that.

**Status as of 2026-08-15**, after the ledger-clearing cycle (plan 13): every
numbered phase, every deferred feature, and every deferred finding is closed.
1105 tests passing, typecheck clean. New findings belong here in the same
shape - what was found, and the ruling that resolved it.

**Read the closed entries before assuming a behavior is accidental.** Several
record that the obvious fix was tried and rejected, or that the reported
symptom turned out not to be the real one - items 8, 28, 29c and 33 each
contain a correction to their own original text, found by reproducing the claim
rather than trusting it.

---

## Settled

1. **Collapse `run()`'s four exit points into one.** Settled by Task 1. The
   single exit is `handle()` - `produce()` keeps its branches and fills a mutable
   `Trace`, but every response, however it was built, passes through `handle()`
   before it leaves. See phases 7–9 design §2.8.

2. **Give each stage a named factory colocated with its module.** Settled by
   Task 1. Stages moved to named factories beside their own modules
   (`createAuthStage`, `createIdempotencyStage`, etc.), executed through one
   ordered loop in `handler.ts`.

3. **Settle whether `reset()` owns the whole Store.** Settled by Task 2. Both
   surfaces now clear the store: `Handler.reset()` clears it, and `Mock.reset()`
   delegates to it. The contract is "`reset()` clears the store it was given."
   `Handler.reset()` is now `Promise<void>`.

4. **`circuit-count` has no TTL.** Settled by Task 9. `CircuitPolicy.within`
   bounds how long failures accumulate, in milliseconds, defaulting to
   `openFor` (no explicit window, the natural scale is how long the circuit
   stays open once it trips). See phases 7–9 design §6, known limitation 4.

5. **Circuit keys are scoped by operation, not by the policy that declared
   them.** Settled by Task 9. `compilePolicies` (`src/runtime/failure.ts`)
   assigns each compiled policy `id: String(index)` at compile time - the
   policy's target string is not part of the id. The circuit keys are
   `` circuit-open|${id}|${targetKey} `` and `` circuit-count|${id}|${targetKey} ``,
   where `targetKey` is the *matched operation's* key. Both axes are carried:
   two policies matching the same operation get separate circuits (the id
   differs), and one wildcard policy matching several operations still gets one
   circuit per operation (the targetKey differs). A fix-round correction - the
   first pass under this task satisfied its own test literals with an id-only
   key, which silently dropped the per-operation axis; a new test now proves one
   wildcard policy keeps separate circuits per operation.

9. **`requestKey` is computed twice per request.** Settled by Task 1 -
   `requestKey` is now computed once and threaded through the pipeline.

---

## Correctness, not blocking

6. **`override()` is absent from `Mock`** although phases 4–6 design §7.3 and §1.3
   both specify it. Decide deliberately and record the outcome; it was never
   consciously dropped, it was simply never planned in. The scope question was
   put to the user during plan 5 and they ruled it out of that plan's scope - a
   deliberate deferral, not an oversight. It was expected to land in plan 6, but
   plan 6 turned out to be webhooks alone, leaving it unscheduled until plan 10
   opened the override surface.
   **Status: DONE, plan 10 (runtime-override cycle), commits `c8e8ecc` through
   `d70a1db` inclusive, plus the phase-12 docs task.** `Mock.override(target,
   value)` and `Mock.clearOverrides(target?)` now ship, with `set_override`
   and `clear_overrides` as the corresponding MCP write tools - see
   `docs/superpowers/specs/2026-08-14-mockingham-runtime-overrides-design.md`.

   **The third deferred item, `regenerate_fixture`, is DONE too - regenerate
   cycle (2026-08-15).** With it, **nothing is deferred**: every tool master
   §15 declares now ships, and every numbered phase is complete. What is left
   in this file below is the non-blocking list (items 15, 16, 17, 19, 22, 24,
   25, 27, 29a–c, 34–41), none of which is a contract violation.

   Three things that cycle established, worth keeping:
   - **The sources disagreed about what the tool was.** Master §15 said
     "re-run the LLM for one operation"; `docs/mcp.md` said "a tool to save a
     live-generated response as a committed fixture" - a different tool
     needing no LLM. The MCP delta §9 settled it by naming "the scoped
     re-bake", and the user confirmed. `docs/mcp.md` had described a tool that
     was never specified, for a full cycle, and is corrected.
   - **It is `bake()` with a filter, not a second entry point.**
     `BakeOptions.only` narrows inside the planning loop that already runs, so
     chunking, persona, scope narrowing, hashing and the store write are all
     reached by the same code a full bake reaches them by.
   - **A scope matching nothing throws**, following `compileTarget`. A scope
     matching an operation with nothing bakeable is reported as `skipped`.
     Naming something that does not exist and asking for something that cannot
     be baked are different answers, and an agent handed `{generated: 0}` for
     a typo has been told it succeeded at doing nothing.

   Also settled there: **a write tool may reach disk.** With a disk-backed
   fixture store, `regenerate_fixture` writes to the fixture directory exactly
   as `bake()` does. Master §15's "Write tools mutate only runtime state" was
   too broad and is corrected at the source; the promise that holds is that no
   tool edits the user's *config*, and `write: true` is the gate.

7. **Cookie parameters cannot validate.** `Parameter['location']` includes
   `'cookie'` and `src/runtime/validate.ts` handles only path/query/header.
   *Plan 3 deferred this on the grounds that nothing in the runtime parsed cookies;
   plan 3's own auth work then added a cookie parser, and the final review caught
   the stale rationale. It was fixed in plan 3's fix wave - listed here only so the
   pattern is on record: a deferral's justification can expire while the deferral
   sleeps.*
   **Status: DONE, plan 3.**

15. **The idempotency lookup-then-claim is not atomic.** `createIdempotencyStage`
    (`src/runtime/idempotency.ts`) does `store.get(key)` and then
    `store.set(key, {state: 'in-flight'}, ...)` with no compare-and-set across
    the await. Two genuinely concurrent identical requests in the same process
    can both read `undefined`, both claim, and both execute - probe-verified
    during plan 5's final review: `runs: 2`, both 201. `MOCK_IDEMPOTENCY_IN_FLIGHT`
    is consequently reachable only for a *wedged prior* request (a dead process,
    or a throw before the boundary catch releases the marker), not for a real
    race. A `Store` with no compare-and-set primitive cannot fix this properly.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** `Store` gained a
    **required** `setIfAbsent(key, value, ttlMs?): Promise<boolean>`, and the
    claim attempts it FIRST rather than reading and then writing - no leading
    `get` fast path, because two routes to one decision is how the fast one
    drifts from the slow one. On a lost claim the existing mismatch /
    in-flight / replay logic runs on the entry that won.

    Verified by mutation: reverting to get-then-set fails the new concurrency
    test with `runs: 2`, the exact figure this entry recorded from plan 5.

    **Required rather than optional, and therefore a breaking change to a
    published interface.** An optional CAS falling back to get-then-set would
    reintroduce the very race while advertising atomicity the mock did not
    have. At 0.1.0, alongside item 27 tightening packaging in the same cycle,
    this was the cheapest moment it will ever be.

16. **The response-always-returned guarantee has one remaining hole.**
    `handle()`'s first line (`const startedAt = now()`) and `internalError()`'s
    `String(error)` sit outside every guard, so an injected clock that throws,
    or an exotic throwable whose `toString` throws, can still make `fetch()`
    reject with no response. The stage-11 block itself was fully guarded
    during plan 5's fix wave; this is the narrow remainder. Pre-existing
    rather than introduced.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** The clock read is
    guarded and falls back to `0` - a duration measured from zero is wrong, no
    response at all is worse - and `String(error)` moved into a
    `describeThrown` helper that catches a throwing `toString`. Each has its
    own test and its own mutation. **`fetch()` has no remaining known way to
    reject.**

17. **A failed body capture still stores an idempotency record.** When
    `captureBody` fails and a key was claimed, the record is written with
    `body: null`, so the key replays a bodiless response for the full TTL.
    That is better than the pre-fix behavior of rejecting the request
    outright, but arguably storage should be skipped entirely when capture
    failed. Untested either way.
    **Status: DONE by user ruling, ledger-clearing cycle (2026-08-15).**
    Storage is skipped: a capture failure now releases the key like any other
    non-storable outcome, so a retry re-executes and can succeed. Pinning a
    bodiless replay for the full TTL turned a transient failure into a
    persistently wrong response the client could not recover from - a 200 with
    nothing in it, for as long as the key lived. Tested, no longer "either
    way".

19. **`an injected 429 is not stored, so a retry re-runs` has an inert half.**
    The test (`test/server/idempotency.test.ts`) never increments its
    `attempts` counter, because `decide` fires on every call and the
    `respond` callback therefore never runs. The `idempotent-replay` header
    assertion is what gives the test teeth, and that was mutation-confirmed -
    but the name promises re-execution the assertions do not check.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** The injection is
    gated on its OWN counter rather than on `attempts`, so the retry actually
    reaches `respond`; the test now asserts the second request returns 201 and
    that the operation executed exactly once, on the retry. The name is true.

    Worth keeping as a shape: the guard was gated on the counter that only the
    guarded code increments, so the condition could never change. A test whose
    setup depends on the thing it is testing is a fixed point, not a test.

22. **The synchronous `EmitCtx` construction at the single exit is not wrapped
    in a try/catch.** In `src/server/handler.ts`'s trigger-two block, building
    `emitCtx` - `headersOf(response)` and `parseBodyText(captured, response)` -
    happens directly inside the `if (trace.emits !== undefined && ...)` guard,
    outside any `try`. The sibling callback-capture block immediately above it
    (trigger one, destination tier 2) wraps its equivalent computation -
    the same two helper calls, building `exprInput.result` - entirely inside
    its own `try`/`catch`. Only the per-emit async body (the `sleep`, the
    `runEmit` call) is guarded; the synchronous setup that precedes the `for`
    loop is not. Unreachable today - neither `headersOf` nor `parseBodyText`
    can throw for any `Response` this codebase produces - but it is asymmetric
    with the established pattern at that exit, and "something at the single
    exit outside the guard" is exactly the shape of plan 5's Critical defect
    (see "A refactor can move code out of a safety net" below). Inherited from
    the plan 6 brief's snippet, not introduced by the implementer; flagged for
    the whole-branch review, not fixed, because tasks 9 and 10 do not touch
    `handler.ts`.
    **Status: DONE, plan 6 whole-branch fix wave.** Folded into the same edit
    as finding C1 below - the `emitCtx` construction now sits inside the same
    `try`/`catch` as the delivery loop that follows it.

24. **I3's `clearTimeout` half has no assertion.** The whole-branch review's
    fix for `close()` waiting out a real, uncancelled `afterMs` timer has two
    halves: racing the wait against `closedSignal` (§2.3's "canceled by
    `close()`"), and clearing the underlying `setTimeout` so the event loop is
    not held open. The promptness test (`close() with a real (non-injected)
    sleep and a large afterMs returns promptly`) covers the race half -
    reverting `await Promise.race([emitSleep(delay), closedSignal])` to a bare
    `await emitSleep(delay)` fails that test at ~5005ms. But deleting only the
    `clearTimeout(entry.handle)` call inside `close()`, leaving
    `entry.resolve()` in place, leaves the suite green: the race is still
    unblocked by the resolved promise, and the only observable difference is a
    longer real process lifetime that nothing in the suite measures. A
    regression there - the real timer left running - would silently
    reintroduce "a CLI shutdown hangs for up to `afterMs`", the exact bug I3
    was raised to fix.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** A test patches
    `setTimeout`/`clearTimeout`, captures the handle the emission arms, and
    asserts `close()` clears **that exact handle** - not merely that some
    `clearTimeout` happened, since the runner and the fetch path both use
    timers and a count would pass on unrelated traffic. `reset()` gets the
    same assertion (item 25). Both fail under precisely the mutation this
    entry describes: deleting only the `clearTimeout` call while leaving
    `entry.resolve()` in place.

25. **`reset()` does not clear `pendingTimers`, while `close()` does.** Design
    §2.3 treats `close()` canceling pending timers and `reset()` clearing them
    as one sentence, implying parity. `close()`'s I3 fix (this wave) clears
    every real timer tracked in `pendingTimers`; `reset()` still only bumps
    `generation`. The emission itself is still correctly dropped - the
    `at !== generation` check inside the delayed IIFE catches it - but the
    underlying `setTimeout` is not cleared and keeps the event loop open until
    it naturally fires. Measured: `settled()` called right after `reset()`
    blocks for the full `afterMs` (3005ms observed for `afterMs: 3000`). This
    is a promptness and shutdown-symmetry gap, not a correctness one - nothing
    delivers late or twice - and it predates this wave (the timer was never
    cancellable before I3's fix). It is only visible now that `close()` has a
    `clearTimeout` for `reset()` to be asymmetric with.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** Both paths call one
    `clearPendingTimers()` helper, so `reset()` clears and resolves exactly
    what `close()` does and `settled()` straight after a reset returns
    promptly. `docs/webhooks.md` carried a "Known limitation" section for this
    and documents the behavior instead now - the guide is executed, so its own
    fence flipped from `waited out the afterMs anyway: true` to `false`, which
    is how the fix announced itself.

27. **The missing `exports` map.** The docs - README, all four guides -
    universally tell readers to `import { createMock } from 'mockingham'`.
    That resolves today only because `package.json` declares no `exports`
    map: `main` is `src/index.ts` and Node's default resolution falls through
    to it for the bare specifier. Deciding what is public - one export
    surface via a real `exports` map versus today's everything-resolves
    looseness - is a packaging decision with permanent blast radius: an
    `exports` map added later is a breaking change for anyone who found a
    working deep import in the meantime. It is not a docs decision, and
    phase 12's boundary is no `src/` or `package.json` changes.
    **Status: DONE by user ruling, ledger-clearing cycle (2026-08-15).**
    Strict: `exports` carries `.` and `./package.json` and nothing else, so
    paths inside `src/` no longer resolve through the package name. A `files`
    field lands with it - there was none, so a publish shipped `test/`,
    `docs/`, and every scratch file in the tree.

    **Asserted through real resolution, not by reading package.json back to
    itself.** Node permits a package to import itself by name only when it
    declares `exports`, so a self-referencing test fails outright if the map is
    removed, and a deep import is asserted to fail with
    `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing else in the suite could have
    covered this: every other test reaches into `src/` by relative path, which
    `exports` does not govern, and the docs harness rewrites the bare
    specifier to a path before running a document.

    **Still open, and NOT part of this item:** `package.json` declares
    `"license": "MIT"` and there is no LICENSE file. Authoring one is the
    owner's call, not a mechanical fix.

28. **`pattern` is silently ignored by value generation, while request
    validation enforces it.** `pattern` appears nowhere in
    `src/generate/values.ts` or `src/generate/constraints.ts` (confirmed by
    grep - zero hits in either file); `src/schema/compile.ts`'s `patternOf`
    compiles it into the zod validator incoming requests are checked against.
    The two directions disagree: a mock can emit a response body it would
    reject as a request body. Evidence, reproduced during Task 9 against
    `docs/example.json`'s `Payment.currency` (`{ "type": "string", "pattern":
    "^[A-Z]{3}$" }`): a bare `createMock` with no fixtures generates values
    like `"ember"` and `"larch"` for that field, neither of which matches
    `/^[A-Z]{3}$/`. No startup warning fires either - master §19 advertised
    both "covers a documented subset" and "warned at startup" for this gap;
    neither half was ever true. Master §19 has been corrected at the source
    (2026-08-14, phase 12) to state the true, asymmetric behavior instead of
    the false "covered subset, warned at startup" claim.
    **Status: DONE, correctness cycle (2026-08-15), commits `2a127a3` and
    `74cebe5`.** `src/generate/pattern.ts` generates a conforming value from
    the master §3 subset - literals, character classes, shorthand escapes,
    anchors, alternation, groups, quantifiers, with unbounded `*`/`+` capped at
    three repeats - drawing from the seeded `Rng` like every other generator.
    `generateString` consults `pattern` before `format` and returns the value
    directly, bypassing `fitLength`, which would pad or slice it out of the
    match.

    Two things the fix taught, both recorded in the cycle's design delta:
    - **The "startup warning" half of master §19 was not merely unimplemented,
      it was unbuildable as specified.** Nothing walks every schema at
      construction; `compile()` is lazy and exists for request validation, so a
      response-only schema - `Payment.currency`, the case that motivated this
      item - is never compiled at all. The warning now fires once per pattern
      on first generation, deduplicated in `handler.ts`. Master §3 carries a
      correction note.
    - **The `example` → `default` → placeholder fallback chain needed no new
      code.** `generateValue` already returns `example` before `default` before
      reaching `classify`, so `generateString` is only reached when neither
      exists and its existing placeholder IS the chain's last step.

    Still true, and now the whole of the limitation: a construct outside the
    subset falls back while requests are validated against the full pattern, so
    the two directions disagree for lookaround, backreferences, named groups
    and unicode property escapes. An override or fixture remains the escape
    hatch there.

    **Merge note (2026-08-25).** The refinements cycle ran on a branch that did
    not have the correctness cycle and recorded this item as "STILL OPEN after
    plan 11 - deliberately, not by oversight", reasoning that a regex-to-string
    generator was a subsystem too large to fold into a seven-item cycle. That
    reasoning was sound on that branch and is simply superseded: the generator
    exists. One consequence the two cycles could not have agreed on in advance,
    settled at the merge: a `pattern` outranks a conflicting `format`,
    `uuid7`/`x-mock-format` included, so a schema declaring both generates from
    the pattern. Pinned by `test/generate/values.test.ts`.

29. **Three MCP read-tool residuals from plan 8, rediscovered during phase 12
    rather than tracked.** All three were found and verified against
    `src/mcp/tools/read.ts` while writing `docs/mcp.md` (Task 8) and are
    documented in that guide, but plan 8 itself never recorded them here -
    they lived only in a gitignored SDD ledger inside a now-gone worktree,
    which is exactly the failure this file exists to prevent (see the file's
    own header). Recording them here for the first time:
    - **(a) `findOperation` ignores `method`/`path` when `operationId` is also
      supplied.** The `operationId` branch (`findOperation`, lines ~21-30)
      returns immediately on a match with no check that a co-supplied
      `method`/`path` agrees with it - passing a mismatched pair alongside a
      valid `operationId` raises nothing.
    - **(b) `list_webhooks` drops a callback's declaring operation from
      `emittedBy` when a configured emitter exists elsewhere.** `listWebhooks`
      (lines ~341-359): `emittedBy: callback !== undefined && configured.length
      === 0 ? [callback.owner] : configured`. The declaring operation
      (`callback.owner`) is reported only when nothing is configured; the
      moment any operation's `emits` config names the webhook, the declaring
      operation is silently dropped from the list even if it is not among the
      configured emitters.
    - **(c) `list_webhooks`'s `payloadSchema` bypasses the `$comment` fallback
      helper every other tool uses.** `jsonSchemaOf`
      (`src/mcp/tools/read.ts:69-72`) falls back to `{ "$comment": "not
      expressible as JSON Schema; this operation is generated only" }` when
      `toJsonSchema` returns `undefined`, and `describeOperation` and
      `contentSchemas` both route through it. `listWebhooks` instead called
      `toJsonSchema` directly. **The symptom this entry claimed — that a
      *recursive* webhook payload therefore came back as `payloadSchema:
      undefined` — was wrong when it was written.** See the corrected ruling
      below.
    None of the three surface in `docs/mcp.md`'s own runnable examples —
    `docs/example.json` has no scenario that naturally exercises any of them
    without a contrived setup - so all three are documented in prose there,
    with source citations, rather than demonstrated running.
    **Status: (a) and (b) DONE, plan 11, commit `a29b90d`.** The phase-12
    ruling was "fix belongs to whoever next opens `src/mcp/tools/read.ts`";
    plan 11's MCP work was that cycle, and both were fixed in the same edit
    that shipped the write tools. Neither was a regression from plan 8.
    **Status: (c) DONE in substance, plan 11, commit `a29b90d` — but the
    stated symptom never occurred and the diagnosis was false.** The single
    real residual was structural: `listWebhooks` was the one caller bypassing
    the shared helper, so two tools could in principle report differently for
    the same schema. `src/mcp/tools/read.ts:403` now routes through
    `jsonSchemaOf` like every other call site, which closes that. What does
    *not* survive contact with the source is the recursion claim.
    `src/schema/json-schema.ts:13-16` says so in its own docstring: the
    `undefined` branch covers exactly one thing, `z.toJSONSchema` refusing a
    compiled zod schema it cannot express, and "Recursion is NOT such a case —
    zod emits `{"$ref":"#"}` and this returns it." Probed directly rather than
    taken on trust: direct self-reference, mutual recursion, recursion nested
    under `oneOf` / `allOf` / `additionalProperties`, every string and integer
    `format`, object and array `const`/`enum`, and degenerate schemas — every
    one converted successfully, none returned `undefined`. The types
    `z.toJSONSchema` does refuse (`bigint`, `date`, and similar) are types
    `src/schema/compile.ts` never constructs; grepping its constructors
    confirms it builds only `string`/`number`/`boolean`/`null`/`literal`/
    `union`/`discriminatedUnion`/`array`/`object`/`unknown`/`lazy`. **The
    `$comment` fallback is therefore unreachable from any document**, so no
    mutation of this fix is observable and no test can meaningfully pin it.
    Recorded this way on purpose: the fix is right, the reasoning that
    justified it was not, and the difference matters — see "A deferred entry
    can carry a false diagnosis" below.

    **Merge note (2026-08-25).** The ledger-clearing cycle closed all three
    independently on its own branch, recording only "None was a regression from
    plan 8; all three were pre-existing and merely went unrecorded until phase
    12" - which still holds and is kept here. Where the two records disagree is
    on (c): that cycle restated the recursion symptom as fact, and the
    investigation above refutes it directly from
    `src/schema/json-schema.ts:13-16` and by probing every construct
    `schema/compile.ts` can build. The refutation is the surviving record. Both
    cycles landed the same structural fix - route `listWebhooks` through
    `jsonSchemaOf` - so only the reasoning differed, never the code.

    - **(a) fixed.** `findOperation` checks every supplied field and throws on
      disagreement, which changes three shipped tools -
      `describe_operation`, `sample_response`, `get_auth_requirements` - from
      silently-ignore to raise. `bake`'s scope filter already behaved this way
      (regenerate delta §4, which deliberately declined to reproduce the
      residual); the two agree now.
    - **(b) fixed.** `emittedBy` is the deduplicated union of the declaring
      operation and the configured emitters, declaring operation first, rather
      than a choice that dropped the declaring one the moment any config named
      the webhook.
    - **(c) fixed, and the entry was WRONG about why it mattered.** Routing
      `payloadSchema` through `jsonSchemaOf` landed - the asymmetry was real -
      but the stated trigger is false. "A recursive webhook payload comes back
      as `payloadSchema: undefined`" does not happen: zod expresses recursion
      through `$defs`/`$ref`, exactly as `src/schema/json-schema.ts`'s own
      docstring says ("Recursion is NOT such a case"). Probing found nothing
      this loader can build that the converter refuses, so the fix changes no
      observable output and the test asserts what is true rather than a
      placeholder that never appears. `docs/mcp.md` had repeated the same
      false claim and is corrected.

30. **`durationMs` is unobservable - not merely stable - under an injected
    fixed clock.** `src/server/handler.ts`: `startedAt = now()` (line 653) and
    `durationMs: now() - startedAt` (line 736) both read the same injectable
    `now` (`options.now ?? (() => Date.now())`, line 166). Pinning the clock
    for determinism, which every doc program and most of the test suite does,
    makes `durationMs` compute to exactly `0` on every request, not merely a
    repeatable non-zero value. Confirmed during Task 7 while writing
    `docs/logging-datadog.md`: with a frozen `now`, `durationMs` came back `0`
    across repeated requests in the same run. The guide deliberately omits
    `durationMs` from every `console` fence rather than showing the degenerate
    `0`, with a prose note explaining why a reader who tries it themselves
    under a real clock will see something else.
    **Status: DONE by ruling, correctness cycle (2026-08-15), commit
    `2933b5f`'s follow-up.** No code change. The ruling was put to the user
    against the alternative of an explicit `options.monotonic`, and the trade
    was declined: a second time source would put a non-injectable reading back
    inside the request path, which is what invariant 2 exists to prevent, and
    a diagnostic field is not worth a determinism guarantee.

    What changed is that the degeneracy is no longer silent -
    `HandlerOptions.now`'s doc comment now states that pinning the clock makes
    `durationMs` exactly `0`, so it is discoverable at the injection point
    rather than in a log. If observable timing under a pinned clock is ever
    wanted, `options.monotonic` is the shape, and it needs its own cycle and
    its own determinism argument.

31. **The cross-process half of the determinism invariant has no automated
    coverage.** `scripts/determinism.ts` exists to be run twice, as two
    separate `node` processes, and diffed by hand - but no test and no npm
    script ever does that. Confirmed: `grep -rln 'determinism.ts' test
    package.json` returns nothing. `test/fixtures/determinism.test.ts` is a
    real, passing test, but it proves a narrower claim - a baked fixture store
    serves the stored value byte-identically across independently constructed
    `Handler` instances, all within one process - not the cross-process case.
    Determinism is invariant 2, the README leans on it by name, and it is also
    the load-bearing assumption behind the entire phase-12 docs harness
    (docs-design §2.2: "this is only possible because of invariant 2 ... a doc
    can promise exact bytes"). The stronger cross-process claim the harness's
    own design rationale depends on is asserted nowhere in `npm test`.
    Found and corrected in prose during Task 9 (README no longer claims a test
    proves it) and in the docs-design spec §3.2 during Task 10 (which had
    itself claimed "the test that runs it" - see that document's 2026-08-14
    correction note).
    **Status: DONE, correctness cycle (2026-08-15), commit `2933b5f`.**
    `test/determinism/cross-process.test.ts` spawns `scripts/determinism.ts`
    twice as real child processes and byte-compares stdout.

    The guards matter as much as the comparison and precede it: two crashed
    processes both print nothing and compare equal, which is shape 12 in the
    test-cannot-fail ledger and is exactly what the previous determinism proof
    did. The test asserts both exit codes are `0`, that stdout is non-empty,
    that it carries one line per probed path, and that each line contains a
    generated body - then compares. Verified by mutation twice:
    `Math.random()` in `generateInteger` fails the byte comparison with
    divergent ids, and a throwing script fails the exit-code guard rather than
    passing on two empty strings.

33. **`4XX`/`5XX` range response keys are silently mis-parsed.**
    `src/spec/load.ts:34` uses `Number.parseInt(code, 10)` on every response
    status key, so a status key of `'4XX'` parses to `4` rather than being
    recognized as an OpenAPI range key (`Number.parseInt('4XX', 10) === 4`).
    An operation's declared error contract ends up loaded under status `4`,
    which no real request status can ever match, so the built-in error
    envelope is served instead - silently downgrading a declared contract to
    the generic fallback. OpenAPI 3.x permits `1XX`–`5XX` range keys for
    exactly this case. Found correcting README.md's error-contract guarantee
    during the phase 12 fix wave. This is a source defect; the fix wave's
    boundary is no `src/` changes.
    **Status: DONE, correctness cycle (2026-08-15), commits `8f0f0ec` and
    `ee81d8b`.** `toResponses` now tests a key before converting it -
    `/^[1-5]XX$/` for a range, `/^[1-5][0-9]{2}$/` for an exact status - and a
    range carries its bucket's lower bound in `status` plus a `range` flag, so
    every existing `response.status === x` comparison keeps its meaning.
    `responseForStatus` resolves exact, then the range whose bucket contains
    the status, then `default`, restamped with the REQUESTED status: a 422
    served from a `4XX` contract is a 422.

    **This entry understated the defect, which reproduction caught before the
    fix was designed.** It is not only a silent downgrade to the envelope.
    When a range key is an operation's ONLY declared response, selection fell
    through to `responses[0]` - status `4` - and `new Response` rejects
    anything outside 200–599, so the operation returned a hard 500 reporting
    the document's own valid OpenAPI as `MOCK_INTERNAL`. Reproduced before and
    after; it now serves 400.

    Two further notes for whoever reads this next:
    - **Key parsing was tightened beyond the reported defect, by user ruling.**
      `'200abc'` used to load as 200 and `'99'` as 99. Both are now skipped.
      Loading a malformed key under a plausible-looking number is how this
      defect stayed invisible for ten plans.
    - **`1XX` parses but is never selected.** Its bound of 100 is below the 200
      floor `new Response` enforces, so there is no status it can be served as;
      it degrades to the built-in envelope rather than throwing. This is the
      only case the `servable()` guard in `select.ts` handles - verified by
      mutation, since the range-only 500 is closed by the loader fix, not by
      that guard.

34. **`process.stdout.write(util.inspect(x))` bypasses `assertPrintableLogs`
    entirely.** `test/docs/fence-checks.ts`'s `assertPrintableLogs` only scans
    a `ts` fence for the literal substring `console.log(` - any other route to
    stdout (`process.stdout.write`, `console.error`, a helper that wraps
    `util.inspect` under a different name) is invisible to it. The
    determinism amendment the check exists to enforce - stable,
    cross-Node-version-printable output - can be sidestepped by writing to
    stdout through any path other than a literal `console.log(`.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** Every other route to
    a compared stream is now rejected by name - `process.stdout.write`,
    `process.stderr.write`, `console.error/warn/info/debug/dir/table/trace/group`,
    with the occurrence skipped when it sits inside a string, so prose about
    the API is not mistaken for a call. `test/docs/fixtures/stdout-bypass.md`
    exists to fail this check.

35. **Three quote-tracking loops in `test/docs/fence-checks.ts` disagree on
    backslash escapes.** `assertPrintableLogs` and `checkShellFence` both
    treat a quote character preceded by a backslash as escaped
    (`rest[i - 1] !== '\\'` / `withComment[i - 1] !== '\\'`); `splitArgs` has
    no escape handling at all - a backslash is an ordinary character to it.
    Confirmed by tracing `assertPrintableLogs` against
    `console.log('a\\', payload)`: the doubled backslash before the closing
    `'` is misread as an escaped quote, the tracker never exits the string,
    the paren-depth/comma-at-depth-1 check that would catch the second
    argument only runs outside a quote and so never fires, and the call is
    accepted despite passing two arguments.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** One `scanQuotes`
    replaces all three loops, counting escapes properly and reporting, per
    index, the enclosing quote, whether the character is a delimiter, and
    whether a run was left open. The three consumers cannot disagree again -
    the same reasoning invariant 1 applies to schema traversal.
    `test/docs/fixtures/escaped-quote.md` is the doubled-backslash case, and
    it fails the check.

36. **Nothing enforces that a `console` fence follows the `ts` block that
    produces its output.** `assembleProgram` and `expectedOutput`
    (`test/docs/harness.ts`) each filter the fence list independently by
    language and join in document order - only the relative order *within*
    each language survives. Nothing checks that a `console` fence sits next
    to, or even after, the `ts` fence whose output it claims to show; a
    document that prints an expected block above unrelated prose, or above
    the code that produces it, passes exactly the same as one that doesn't.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** A `console` fence
    appearing before any `ts` fence is rejected, so output cannot be shown
    above the code that produces it.
    `test/docs/fixtures/output-before-code.md` proves it fires.

37. **A `txt` fence is inert, so fabricated program output placed in one is
    never checked.** `runDocument`'s per-language dispatch
    (`test/docs/harness.ts`) branches on `ts`, `sh`, `json`, and `jsonc`; a
    `txt` fence passes `assertKnownFences` but has no branch at all, so its
    content is never run, never diffed, and never checked in any way - matching
    the docs-design spec's own §2.3 table, which lists `txt` as "inert -
    directory listings and file trees" by design. `docs/mcp.md:23-28`
    legitimately uses one for the "needs `@modelcontextprotocol/sdk`" message
    the CLI actually prints - verified by hand against `src/mcp/`'s lazy-load
    path - but the harness has no way to distinguish that from a document
    author simply typing whatever they want.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** `txt` stays inert by
    design; what is rejected is a `txt` fence whose CONTENT is shaped like
    program output - JSON, a stack frame, a status line, or the `mockingham:`
    message prefix. The fence keeps working for file trees, which is what it
    is for.

    **The check immediately caught the case this entry named as legitimate.**
    `docs/mcp.md`'s hand-verified CLI error message is now prose: no runnable
    example on that page provokes it, so no fence could ever have diffed it,
    and a block that looks verified while being hand-copied is exactly the
    failure mode worth removing. `test/docs/fixtures/fabricated-txt.md` proves
    the check fires.

38. **`checkJsonFence` only inspects a `mcpServers` key.**
    `test/docs/fence-checks.ts`'s `checkJsonFence` reads
    `(parsed as McpClientConfig).mcpServers` and returns immediately when it
    is `undefined` - a client config shaped for a host that uses a different
    top-level key (a bare `servers` map, say) receives no argument checking
    at all, even though the docs-design spec's §2.3 table states the check
    ("an MCP client config's `args` array is additionally fed through the
    real `mockingham mcp` parser") as if it applied to any JSON fence holding
    a client config, unconditionally.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** The fence is walked
    recursively for any `args` array of strings, wherever it sits and whatever
    key holds it, and each one that names `mockingham` goes through the real
    parser. Checking for the SHAPE rather than for one key is what makes the
    spec's description true. `test/docs/fixtures/other-args-key.md` puts a bad
    flag under a `servers` key and fails.

39. **A child process writing more than 1 MB to stdout fails opaquely, though
    not via the timeout path.** `runDocument` (`test/docs/harness.ts`) calls
    `execFile` with no `maxBuffer` override, so Node's 1 MB default applies.
    Verified against this repo's Node (v24.18.0): exceeding it does not set
    `error.killed` - it stays `undefined`, not `true` - so `runChild`'s
    `error.killed === true` timeout check never fires; `error.code` is
    instead the string `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, which
    `runChild`'s `typeof error.code === 'number' ? error.code : 1` folds into
    an ordinary `code: 1`. `assertDocument` then reports a plain "exited 1"
    failure with the entire truncated ~1 MB of stdout dumped into the error
    message and no mention of `maxBuffer` anywhere - unhelpful, but a
    different failure shape than a `killed`-driven timeout misdiagnosis would
    be.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** `maxBuffer` is
    raised to 32 MB - well past any real document - and
    `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is recognized by name and reported as
    itself, with a note that a document printing that much is almost certainly
    looping, instead of folding into a generic exit 1 with a truncated
    megabyte in the message.

40. **The coverage sweep only walks `docs/` non-recursively, with
    `README.md` hardcoded.** `test/docs/docs.test.ts`'s coverage test calls
    `readdir(join(REPO, 'docs'))` with no `recursive` option, so a guide
    placed in a subdirectory of `docs/` would never be discovered by the
    sweep. `README.md` is not discovered at all - it is simply one of the
    four literal entries in `DOCUMENTS`, exercised only because its own
    subtest runs, never verified to exist by the coverage assertion itself. A
    future top-level reader-facing markdown file outside `docs/` (a
    `CONTRIBUTING.md`, say) would be silently uncovered either way.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** The sweep walks the
    whole repo recursively, skipping `node_modules`/`.git`/`dist`, with
    exemptions declared BY NAME and with a reason - `CLAUDE.md` (an operating
    manual for agents, not for readers), `docs/superpowers` (specs, plans and
    this ledger), and `test/docs/fixtures` (documents that exist to be
    rejected). It also asserts every entry in the run list exists on disk,
    which is what `README.md` being a bare literal had escaped.

    The recursive walk found the harness's own fixture documents on its first
    run, which is the mechanism working.

41. **Citation style drifts across the guides.** Some name the source
    document - `docs/logging-datadog.md:38`: "phases 7-9 design §2.1";
    `docs/mcp.md:206`: "master §17" - others cite a bare section symbol with
    nothing naming which document it belongs to -
    `docs/webhooks.md:163`: "the same layering §4 applies". Every citation
    resolves to a real section in a real spec today, so nothing is broken,
    but the docs-design spec (§4) asks a guide that states a rule to cite
    "the invariant or spec section the rule comes from," and a bare `§4`
    does not say which of this repo's three specs that is.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** Every citation in
    every guide names its document: `master §N`, `the MCP design delta §N`,
    `the webhooks design delta §N`, `phases 7-9 design §N`. The one `(§ below)`,
    which pointed within the same document rather than at a spec, names the
    section instead.

*Items 42-46 are the known limitations refinements design §13 records for the
plan 11 cycle, entered here so they outlive that worktree's ledger. §13's third
limitation — `pattern` still ignored by generation — is item 28 above and is
not duplicated here.*

42. **Registration enumeration is process-local.** The webhook destination
    registry writes authoritative values through the `Store`, so the values
    themselves are as durable as whatever `Store` is in use, but the key index
    that makes `registrations(webhook)` and `list_registrations` enumerable is
    in-process state. A second process sharing the same store can resolve a
    registration it is asked about by key and still enumerate nothing. This is
    identical in kind to the delivery log's existing limitation (refinements
    design §3.5) and is accepted for the same reason: an enumerable index in
    the `Store` would need a key-range or set primitive the `Store` interface
    does not have — the same missing-primitive shape as item 15.
    **Status: documented limitation, plan 11.** See refinements design §13
    limitation 1 and §3.5.

43. **The link table is bounded at 1000 entries and one hour, and falls
    through silently past either.** Response linking (refinements design §4)
    recalls a value remembered by an earlier response so a create-then-read
    sequence returns the same id. Past 1000 live entries or an hour of age,
    the evicted key recalls nothing and the read falls through to ordinary
    seeded generation. That fall-through is deliberate — invariant 4's "a miss
    is never an error" applies to a recall miss too — but from the caller's
    view it is a silent behavior change rather than a signalled one: the
    response is well-formed and on-contract, it simply no longer agrees with
    the create that preceded it. A long soak test or a high-cardinality
    sequence is where this will first be felt.

    **And that bound is process-local, so it does not bound a shared store.**
    The recorded values go through the `Store`, but the insertion-ordered key
    index that decides what to evict lives in `createLinkTable`, in the
    process — the same wall item 42 and the delivery log hit, for the same
    reason: the `Store` interface has no enumeration or key-range primitive.
    Each process therefore evicts only the keys *it* recorded, so N processes
    sharing one `Store` can leave up to N × `max` entries per rule resident in
    it rather than `max`. With the default in-memory per-process store this is
    invisible; it becomes real exactly when a shared store is adopted to make
    linking survive a restart or span workers, which is the case that motivates
    a shared store in the first place. `ttlMs` is the only bound that still
    holds there, since expiry is the store's own job.
    **Status: documented limitation, plan 11.** See refinements design §13
    limitation 2 and §4.3.

44. **Redelivery cannot reach a delivery aged out of the 1000-entry log.**
    `redeliver(id)` resolves the original delivery out of the in-memory
    delivery log, which is bounded at 1000 entries; once an id has been
    evicted, the redelivery throws rather than quietly succeeding with a
    freshly built payload. Throwing is the right call — a "redelivery" that
    silently re-derived its body would not be the same delivery, which is the
    whole point of the stable delivery identity §7 introduced — but it does
    mean redelivery is only reliable within a recent window, and a test that
    drives 1000+ emissions before redelivering an early one will fail in a way
    that looks like a defect and is not.
    **Status: documented limitation, plan 11.** See refinements design §13
    limitation 4 and §7.3.

45. **`set_variant` and `Prefer: variant=` do not reach webhook payloads or
    error envelopes.** Variant selection is applied on the response-body path
    only. A webhook payload emitted by the same operation, and an error
    envelope served instead of the success body, are both generated without
    consulting the selected variant — so a test that pins a variant and then
    asserts on the emitted payload sees the unpinned shape. The boundary is
    defensible (the variant is a property of the operation's declared success
    schema, which is not what either of those paths generates from) but it is
    not obvious from the tool's name, and it is the kind of asymmetry a reader
    discovers by being surprised.
    **Status: documented limitation, plan 11.** See refinements design §13
    limitation 5 and §5.4.

46. **A `remember` expression addressing a non-scalar via a pointer records
    nothing.** `resolveExpression` funnels pointer forms through `scalar()`,
    so `{$response.body#/items}` — a pointer landing on an array or object —
    resolves to a failure and the `remember` records nothing at all. Only the
    whole-body forms are special-cased into structured values. The failure is
    silent by design (invariant 4 again), which means a document author who
    writes a pointer at a container gets a link that never recalls and no
    diagnostic saying why.
    **Status: documented limitation, plan 11.** See refinements design §13
    limitation 6 and §4.2.

47. **No test covers the post-`close()` guard on `redeliver`.**
    `src/server/handler.ts:1308-1316` rejects a `redeliver()` call made after
    `close()`, mirroring the `emit()` guard immediately above it at
    `src/server/handler.ts:1290-1297`. The `emit()` half is tested —
    `test/server/webhooks.test.ts:723`, "emit() after close() rejects rather
    than silently sending" — and the redelivery half has no equivalent. The
    guard is more than symmetry: a redelivery is an emission, so an unguarded
    one after `close()` would be untracked by `track()` and `settled()` would
    race past it, which is finding I2's exact failure mode reappearing on a
    second entry point. Deleting the `if (closed)` block from `redeliver`
    leaves the suite green.
    **Status: documented deferral, plan 11.** The test is small and buildable;
    it belongs to whoever next opens the webhook surface.

48. **An observed flake, not a confirmed defect: a `docs/webhooks.md`
    assertion that `settled()` waits out `afterMs` failed once under heavy
    parallel load.** The document asserts `resetElapsedMs >= 300` after a
    `reset()` with a 300ms `afterMs`, demonstrating item 25's behavior — that
    `reset()` leaves the real timer running, so `settled()` pays the delay
    anyway. It failed once during a fully parallel run of the suite and passed
    on four subsequent runs, twice of them in isolation. That is one
    observation with no reproduction, so the honest classification is *flaky
    under load*, not *broken*: the elapsed-time measurement could be losing to
    scheduler noise, or the timer bookkeeping item 25 describes could have a
    genuine race that only a loaded event loop exposes. Recorded so the next
    person to see it knows it has been seen before and knows which of those
    two it has *not* yet been narrowed to.
    **Status: documented observation, plan 11.** Cross-references item 25
    (`reset()` does not clear pending timers while `close()` does), which is
    the mechanism the assertion exists to demonstrate and the first place to
    look if it recurs. Do not treat this entry as evidence of a defect until
    someone reproduces it.

49. **A UUIDv7's uniqueness ACROSS requests rests entirely on the virtual
    clock, not on its 74 random bits.** Raised by the plan 11 docs implementer,
    who noticed that three `uuid7` values in `README.md` differ only in their
    timestamp field — the random bits are byte-identical — and correctly
    declined to claim anything about entropy in the guide. Probed directly
    rather than reasoned about, per the lesson item 29(c) taught in this same
    cycle:
    - Three `uuid7`s generated from ONE rng stream (an array in one response
      body) have **distinct** random bits. Entropy advances correctly within a
      stream; there is no defect in `generateUuid7`.
    - Three `uuid7`s generated from three independent, identically-seeded rngs
      — which is what successive requests to one operation actually are — have
      **identical** random bits, and differ only in the timestamp.
    The second case is invariant 2 doing its job: the same request must produce
    the same bytes, so the PRNG must be at the same position. It is not new
    with v7 — `format: uuid` behaves the same way, and three identically-seeded
    requests produce three byte-identical v4s today. v7 is strictly better
    there, because the advancing clock disambiguates where v4 cannot.
    The consequence worth knowing: **two v7s from separate requests would be
    identical if the clock ever failed to advance**, since nothing else varies
    between them. `createVirtualClock` steps unconditionally on every `next()`,
    so this is not reachable now; it becomes reachable the moment anyone adds a
    conditional step, a clock reset mid-sequence, or a second clock instance.
    **Status: documented property, plan 11.** Not a defect and nothing to fix.
    Recorded because "74 bits of randomness" reads as though entropy carries
    uniqueness across requests, and it does not.

50. **A Critical caught by the plan 11 whole-branch review: the seeded virtual
    clock, as designed and as implemented, broke the very invariant its design
    section claimed it upheld.** Recorded in full because the *shape* of the
    mistake is more reusable than the fix.
    Design §8.3 specified "a per-mock counter, advancing by a fixed step on
    each v7 generated", and §11's determinism table asserted "Same sequence →
    same bytes? Yes; counter is seeded and stepped fixed." Both were false. The
    counter was drawn at GENERATION time — which is after `readOverride`,
    `readVariant` and the fixture resolver have all awaited — and a webhook
    with `afterMs` generates its payload on a timer. So the order draws reached
    the counter was decided by wall-clock timing rather than by the request
    sequence. A strictly sequential caller doing `POST` then `GET` got a
    different `GET` **response body** depending only on how long they waited:

        gap=0    post …7c00  get …7c01  hook …7c02
        gap=60   post …7c00  get …7c02  hook …7c01

    The random halves were byte-identical across both runs, which is what
    isolated the shared counter as the sole cause — the per-request seeded rng
    was never involved.
    **Why nine plans of habit did not prevent it.** Every other
    sequence-dependent output in this codebase — request ordinals, the webhook
    counter, `failNext` consumption, idempotency claim — is drawn
    SYNCHRONOUSLY, per request, before anything can interleave. The clock was
    the first piece of generation state drawn after an await, and it was
    introduced by a design that reasoned about determinism carefully and still
    missed it, because "the counter is seeded and steps by a fixed amount" is
    true and sounds sufficient. It is not: *what* is drawn was never the
    problem, *when* it is drawn was.
    **The fix** (`src/generate/clock.ts`) makes the clock an allocator:
    `allocate()` reserves a block of `TICKS_PER_ALLOCATION` timestamps
    synchronously — at request entry, and at emission SCHEDULING rather than
    firing — and generation draws within its own block whenever it runs.
    **Status: FIXED, plan 11 fix wave.** Two regression tests
    (`test/server/handler.test.ts`): a delayed emission not shifting the next
    request's timestamp, and two concurrent requests ordered by issue rather
    than completion.
    **A test-design note worth as much as the fix.** The first draft of the
    concurrency test was inert twice over, and passed against the very mutation
    it existed to catch both times: it keyed a Store slowdown on a path
    parameter when `targetKey` uses the operationId or the route template, and
    it compared "slow" against "even" when the first-issued request wins every
    race by default, so the order never changed. Only slowing request A against
    slowing request B discriminates. Written by the same person who had spent
    the cycle catching this exact shape in other people's work.

51. **The plan 11 fix wave introduced two new defects of the same class it was
    written to close, and the scoped re-review caught both.** Recorded because
    "the fix wave needs the same scrutiny as the work" is a lesson this project
    had not yet paid for.
    - **The bare-expression fix missed the one call site its own rationale
      names.** `normalizeExpression` was applied to link keys, `remember`, the
      idempotency key, `registerVia.url` and `scopeBy` — but not to the
      document's `callbacks` expression (`src/server/handler.ts`), which is
      precisely the site both `expr.ts` and `capture.ts` cite when explaining
      why bare spellings must be accepted ("OpenAPI's own `callbacks` keys are
      written bare"). A bare key resolved to itself, so the literal text
      `$request.body#/hook` was stored as a destination and used as a delivery
      URL, with no warning — `isSupported` is vacuously true for a token-free
      string.
    - **The clock fix keyed its tickers by webhook NAME.** `trace.emits` is an
      array and two entries may name one webhook; a `Map` kept only the last,
      so both emissions shared a block and drew offsets at FIRING time —
      reintroducing, for that configuration, the exact race the reservation
      removes.
    **Status: FIXED, plan 11 re-review wave.** Both pinned by regression tests.
    Also fixed there: `seedTime`'s upper bound now leaves headroom for later
    blocks (`2**48 - 1` passed the old check and wrapped on request two,
    destroying the ordering the check exists to protect, while the boundary
    test certified it by only inspecting the first id); `normalizeExpression`
    now tests for a matched token rather than the presence of a `{`, so a stray
    brace is wrapped instead of passed through; and a README sentence claiming
    a `PUT` rule replaces what a `POST` recorded was corrected — records are
    namespaced per rule index, so rules never overwrite one another and
    declaration order alone decides which recall wins.

52. **A global regex's `lastIndex` leaked between two consumers.** Introduced
    and caught within the plan 11 re-review wave. `TOKEN` in
    `src/webhooks/expr.ts` is declared `/g`; calling `.test()` on it advances
    and LEAVES `lastIndex` advanced, and `String.prototype.matchAll` begins
    from the regex's current `lastIndex`. So a `test` inside
    `normalizeExpression` made the next `isSupported` call skip the first token
    of whatever expression it examined — reporting an unsupported expression as
    supported and silently withholding the startup warning. Four warning tests
    failed at once, which is the only reason it was noticed.
    **Status: FIXED, plan 11 re-review wave.** A separate stateless
    `ONE_TOKEN` pattern is used for one-shot checks; resetting `lastIndex` by
    hand at each call site was rejected as exactly the sort of convention that
    drifts. Pinned by a test that calls `normalizeExpression` and then
    `isSupported`, in that order.
    Worth generalizing: any `/g` regex shared between a `test`/`exec` caller
    and a `matchAll`/`replace` caller has this hazard, and it is invisible
    until the two run in the wrong order.

---

## Polish

All closed by the ledger-clearing cycle (2026-08-15). Four were fixed; the rest
are closed as **deliberate**, which is a decision and not an omission - several
of these entries exist precisely because someone weighed the change and
declined it.

8. `chaosSeed` is frozen at construction, so `setSeed` does not update it. Cosmetic
   only - chaos still varies because `requestKey` carries the seed.
   **FIXED.** A `chaosSeed` that merely defaulted to the seed now follows
   `setSeed` and `reset`; an explicitly configured one is left alone, since
   decoupling it is a deliberate choice.

   **The obvious test for this cannot fail, and passed against the unfixed
   code when tried.** Reseeding changes the chaos roll either way, because
   `requestKey` carries the seed - which is this entry's own reason for calling
   it cosmetic. What discriminates is comparing a reseeded handler against one
   BUILT with the new seed: both then share request keys, so only the chaos
   seed can differ. Mutation-verified in that form.
10. Latency is skipped on an injected failure. The literal spec order permits it,
    but a slow outage is the more realistic behavior. Worth one line in §7.2 either
    way.
    **CLOSED, behavior unchanged, documented.** Master §7 now states it
    outright: latency is last in the evaluation order and an injected failure
    short-circuits before reaching it, so `failNext`, an outage, an open
    circuit and a lost rate roll all return immediately. A slow outage is
    arguably more realistic; changing the order would alter the timing of every
    existing failure test to no one's benefit. The entry asked for one line
    "either way" and got it.
11. `classify`'s `union.mode` is consumed by the compiler now, but
    `additionalProperties: <Schema>` and `oneOf` exactly-one arrived in plan 4 -
    check nothing else reads `mode` expecting the old looseness.
    **CLOSED, audited, nothing to change.** Three consumers of
    `kind === 'union'` exist, and only one reads `mode`:
    - `src/schema/compile.ts` reads it, branching on `'one'`. The intended
      consumer.
    - `src/generate/generate.ts` picks one variant with the seeded rng and does
      not read `mode` - correct, since generating a single variant satisfies
      `oneOf` (exactly one) and `anyOf` (at least one) alike.
    - `src/fixtures/source.ts` walks every variant for recursion detection and
      does not read `mode` - correct, since whether a schema recurses does not
      depend on union semantics.
12. `OperationConfig`'s numeric index signature could collide with its reserved
    `status`/`respond` keys. Pre-existing since plan 2; numeric status keys cannot
    actually collide with those names.
    **CLOSED, cannot occur.** The entry states its own answer: a numeric key
    and the identifiers `status`/`respond` are disjoint. A note, not work.
13. `toSecuritySchemes` uses `as` casts with no runtime validation, so a malformed
    `type` silently yields an invalid scheme. Matches the existing loader style.
    **FIXED, and it was more than a style note.** An unrecognized `type` fell
    through to the bearer branch, so a document declaring `mutualTLS` - valid
    OpenAPI 3.1, credential carried in a TLS handshake a mock never sees - got
    a 401 on every request with no way to satisfy it. A typo'd type behaved the
    same way. An unrecognized type is now *unenforceable* rather than assumed
    bearer, and an enforceable member of the same requirement must still be
    met. The loader keeps its lenient casting; the fix is in `auth.ts`, where
    the consequence was.
14. `split()` is duplicated between `src/resolve/target.ts` and
    `src/spec/routes.ts`. Identical one-liners; extracting couples two modules for
    little gain.
    **CLOSED, deliberate.** The reasoning holds; reversing it now would be
    change for its own sake.
18. A failed body parse consumes a request ordinal. Parse failures now draw from
    `requestOrdinals` under the matched key, so a failed parse shifts the
    `requestId` of the next successful request sharing that identity. Harmless -
    `requestId` never feeds the PRNG - but it is an unremarked behavior change
    from plan 5.
    **CLOSED, intended.** Recorded here so it is remarked rather than
    accidental. `requestId` is a diagnostic handle, not an input to generation,
    so a shifted ordinal changes nothing a caller can observe in a response.
20. The log block's own `try`/`catch` in `src/server/handler.ts` is untested.
    Nothing inside it can realistically throw now that `emitLog` self-isolates,
    so this is defense in depth rather than a gap.
    **FIXED, and the premise was wrong.** `emitLog` does self-isolate - but the
    block also reads the clock for `durationMs` inside the same `try`, so a
    clock that throws on its second read proves the guard while leaving the
    caller's 200 intact. An untested guard is indistinguishable from an absent
    one.
21. `templateFor` duplicates `allowedMethods`' loop body in the router.
    Extracting the shared walk would couple two small functions for little gain.
    **CLOSED, deliberate.** Same reasoning as 14.
23. In `test/server/webhooks-loopback.test.ts`'s `finally` blocks, both tests
    run `await mock.close()` before `await hook.close()`. If `mock.close()`
    threw, `hook.close()` would be skipped, leaking the throwaway `node:http`
    receiver's listening socket. `mock.close()` has no plausible throwing
    surface, so this is cosmetic; it mirrors the accepted single-resource
    convention already in `test/server/node.test.ts`.
    **FIXED.** Nested `try`/`finally`, so a throwing `mock.close()` cannot skip
    `hook.close()`. Cheap, and the failure mode it prevents is a hung test run,
    which is the worst way to learn about a leaked socket.
26. Every `afterMs > 0` emission (I3's fix, plan 6) races its wait against the
    module-scoped `closedSignal` promise via `Promise.race`, which attaches a
    reaction that is only released when `close()` resolves `closedSignal`. On
    a short-lived mock or a test process this is inert. On a long-lived
    `listen()` server that accumulates traffic and is never closed, each such
    emission's reaction sits on `closedSignal`'s subscriber list for the rest
    of the process's life. Bounded by traffic rather than unbounded, and each
    reaction is tiny with no reference cycle, so this is cosmetic rather than a
    leak in the classic sense - worth a line if `closedSignal` ever gains a
    reason to reset itself (for instance, if `reset()` is taught to be
    symmetric with `close()`, per item 25).
    **Status: DONE, ledger-clearing cycle (2026-08-15).** Narrowed rather than
    removed: the race exists for an INJECTED `sleep`, which has no timer handle
    for `close()`/`reset()` to clear. The default sleep's wait is already
    released by `clearPendingTimers()`, so racing `closedSignal` there was pure
    waste - and the injected sleep is a test-time configuration on a
    short-lived mock, which is not the long-lived-server scenario this entry is
    about. The accumulation no longer happens on the path that had it.
32. `src/mcp/server.ts:6-9`'s `McpOptions.transport` JSDoc says `'stdio'`
    "connects immediately." It does not: `createMcpServer` (`src/mcp/server.ts`)
    only branches on `options.transport === 'http'` when building `path`;
    nothing there or in `mcp()` (`src/index.ts`) reads `'stdio'` at all. A
    `'stdio'` handle only starts talking JSON-RPC once the caller separately
    awaits `handle.connectStdio()` - which is exactly what the `mockingham mcp`
    CLI subcommand does on the caller's behalf
    (`src/server/cli.ts:540-541`: `mock.mcp({ transport: 'stdio', ... })`
    immediately followed by `await server.connectStdio()`). Found during
    phase 12 docs (Task 10) while correcting the same false claim, inherited
    from this JSDoc, that had leaked into `docs/mcp.md:76`. The guide was
    corrected at the source; this comment is source under `src/`, which is out
    of scope for the docs cycle's no-code-change boundary.
    **Status: DONE, ledger-clearing cycle (2026-08-15).** The JSDoc says what
    actually happens: `'stdio'` attaches nothing, and a handle talks JSON-RPC
    only once the caller awaits `connectStdio()`. Worth noting the shape - a
    false comment in source propagated into a guide, the guide was corrected,
    and the source that caused it was left standing for two more cycles.

---

## Process lessons worth keeping

**Four tests reached plans 2 and 3 that could not fail.** Each was caught by
review, never by the plan author. The three shapes:

- `async () => Promise.resolve(x)` is auto-flattened by JS before any settle logic
  sees it, so it passes against the single-pass implementation it exists to rule
  out. Prove nested settling with a *container* holding a pending promise.
- A test asserting two components **agree** cannot catch a blind spot they share -
  generation and validation both dropped `allOf`-nested constraints and agreed
  perfectly. Assert the constraint is **honored**.
- `assert.equal(result.ok, false)` passes when the code fails for an unrelated
  reason. Assert the specific error path.

**The countermeasure that worked every time:** require a mutation observation
before accepting a test that proves a mechanism. Revert the fix, watch the test
fail, report the exact message. That caught all four.

**A deferral's justification can expire.** See item 7.

**A deferred entry can carry a false diagnosis, confidently worded, and be read
as settled fact by every later cycle.** Item 29(c) named a specific symptom — a
recursive webhook payload returning `payloadSchema: undefined` — with a source
citation and a plausible mechanism. No such document exists. The mechanism was
contradicted by the docstring of the very file it cited
(`src/schema/json-schema.ts:13-16`: "Recursion is NOT such a case"), and a probe
across self-reference, mutual recursion, recursion under `oneOf`/`allOf`/
`additionalProperties`, every `format`, container `const`/`enum`, and degenerate
schemas found nothing that reaches the fallback at all. The real residual was
narrower and structural (one caller bypassing a shared helper), and worth
fixing, but nobody would have learned that from the entry.
This is the mirror of the lesson above: item 7 is a justification that *expired*
over time, this is one that was *never true*. Both are invisible to a later
reader, because a ledger entry looks the same whether or not anyone ever
reproduced it. Two countermeasures, both cheap: state in the entry whether the
symptom was **observed** or **reasoned from the code** — those are different
claims and only one of them survives being wrong; and when closing a deferred
item, reproduce its symptom before fixing it, exactly as this project already
requires a mutation observation before accepting a test. An unreproducible
symptom is itself the finding. See also item 48, which is deliberately worded
as an observation with no reproduction rather than as a defect.

**A deterministic system makes replay tests toothless by default.** Generation is
seeded, so two real executions of the same request already return byte-identical
bytes - an idempotency replay test that only compares bodies passes with
idempotency removed entirely. Plan 5's replay test counts executions through a
plain closure counter (`let runs = 0`, incremented inside the `respond`
callback) so the two paths genuinely differ. Whenever a test asserts "the same
output", ask what else could produce that same output.

**A mutation that exercises the wrong branch proves nothing.** A test in plan 5
survived both its author's and its implementer's mutation runs because both
mutated a nearby line rather than the specific condition the test targeted; a
reviewer caught it. Name the exact condition to mutate, not just "the
implementation line" - see Task 7's note in the plan 5 ledger.

**A brief that contradicts itself will be resolved silently unless the
implementer is asked to flag it.** One plan 5 task's key formula disagreed with
its own test literals, and the first resolution quietly dropped a scoping axis
(see item 5). Ask implementers to report self-contradictions rather than
resolve them unremarked.

**A refactor can move code out of a safety net without touching the net.**
Plan 5 split the request pipeline so every response leaves through one exit,
then hung idempotency's store write on that exit - outside the boundary catch
that had covered every previous `Store` touch. Each per-task review saw
correct code; the defect existed only where two tasks met, and only the
whole-branch review could see it. When a refactor relocates work, ask what
invariants were being enforced by its old location.

**A test that derives its expectation by calling the function under test can
verify plumbing but never pin a value.** Plan 6's retry test computed its
expected delay sequence by calling `backoffFor`, the function it was testing -
so mutating that function moved both sides of the assertion together, and the
mutation looked observed while doing nothing. It is the first shape found that
survives a naive mutation check. Hardcode the expected value, with a comment
saying what would legitimately change it.

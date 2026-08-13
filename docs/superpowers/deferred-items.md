# Deferred items

Findings raised by code review during plans 2–5, deliberately deferred rather than
fixed at the time, each with the ruling that deferred it and where it belongs.

This file is tracked in git on purpose. The SDD ledgers that originally held these
live under `.superpowers/` inside per-plan worktrees, which is gitignored scratch —
one `git worktree remove` and the reasoning is gone. Anything here is meant to
survive that.

Status as of 2026-08-12: plan 5 (phases 7–9) is merged to `main`. Plan 6
implements the phase 8 webhooks design (`2026-08-12-mockingham-webhooks-design.md`)
on worktree branch `worktree-plan-6-webhooks`, not yet merged to `main`. 585
tests passing, up from a 509-test baseline, typecheck clean.

---

## Settled

1. **Collapse `run()`'s four exit points into one.** Settled by Task 1. The
   single exit is `handle()` — `produce()` keeps its branches and fills a mutable
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
   assigns each compiled policy `id: String(index)` at compile time — the
   policy's target string is not part of the id. The circuit keys are
   `` circuit-open|${id}|${targetKey} `` and `` circuit-count|${id}|${targetKey} ``,
   where `targetKey` is the *matched operation's* key. Both axes are carried:
   two policies matching the same operation get separate circuits (the id
   differs), and one wildcard policy matching several operations still gets one
   circuit per operation (the targetKey differs). A fix-round correction — the
   first pass under this task satisfied its own test literals with an id-only
   key, which silently dropped the per-operation axis; a new test now proves one
   wildcard policy keeps separate circuits per operation.

9. **`requestKey` is computed twice per request.** Settled by Task 1 —
   `requestKey` is now computed once and threaded through the pipeline.

---

## Correctness, not blocking

6. **`override()` is absent from `Mock`** although phases 4–6 design §7.3 and §1.3
   both specify it. Decide deliberately and record the outcome; it was never
   consciously dropped, it was simply never planned in.
   **Status: decided deferral, plan 5.** The scope question was put to the user
   during plan 5 and they ruled it out of this plan's scope — a deliberate
   deferral, not an oversight. It was expected to land in plan 6, but plan 6
   turned out to be webhooks alone; it is now unscheduled, to be picked up when
   someone next opens the override surface.

7. **Cookie parameters cannot validate.** `Parameter['location']` includes
   `'cookie'` and `src/runtime/validate.ts` handles only path/query/header.
   *Plan 3 deferred this on the grounds that nothing in the runtime parsed cookies;
   plan 3's own auth work then added a cookie parser, and the final review caught
   the stale rationale. It was fixed in plan 3's fix wave — listed here only so the
   pattern is on record: a deferral's justification can expire while the deferral
   sleeps.*
   **Status: DONE, plan 3.**

15. **The idempotency lookup-then-claim is not atomic.** `createIdempotencyStage`
    (`src/runtime/idempotency.ts`) does `store.get(key)` and then
    `store.set(key, {state: 'in-flight'}, ...)` with no compare-and-set across
    the await. Two genuinely concurrent identical requests in the same process
    can both read `undefined`, both claim, and both execute — probe-verified
    during plan 5's final review: `runs: 2`, both 201. `MOCK_IDEMPOTENCY_IN_FLIGHT`
    is consequently reachable only for a *wedged prior* request (a dead process,
    or a throw before the boundary catch releases the marker), not for a real
    race. A `Store` with no compare-and-set primitive cannot fix this properly.
    **Status: documented deferral, plan 5.** `Store.setIfAbsent` is the eventual
    fix — adding it mid-plan-5 was judged out of scope for a fix wave. Expected
    to land in plan 6, but plan 6 turned out to be webhooks alone; it is now
    unscheduled, to be picked up when someone next opens the `Store` interface.
    See phases 7-9 design §6 (known limitation 6) and master spec §11.

16. **The response-always-returned guarantee has one remaining hole.**
    `handle()`'s first line (`const startedAt = now()`) and `internalError()`'s
    `String(error)` sit outside every guard, so an injected clock that throws,
    or an exotic throwable whose `toString` throws, can still make `fetch()`
    reject with no response. The stage-11 block itself was fully guarded
    during plan 5's fix wave; this is the narrow remainder. Pre-existing
    rather than introduced.
    **Status: documented deferral, plan 5.**

17. **A failed body capture still stores an idempotency record.** When
    `captureBody` fails and a key was claimed, the record is written with
    `body: null`, so the key replays a bodiless response for the full TTL.
    That is better than the pre-fix behavior of rejecting the request
    outright, but arguably storage should be skipped entirely when capture
    failed. Untested either way.
    **Status: documented deferral, plan 5.**

19. **`an injected 429 is not stored, so a retry re-runs` has an inert half.**
    The test (`test/server/idempotency.test.ts`) never increments its
    `attempts` counter, because `decide` fires on every call and the
    `respond` callback therefore never runs. The `idempotent-replay` header
    assertion is what gives the test teeth, and that was mutation-confirmed —
    but the name promises re-execution the assertions do not check.
    **Status: documented deferral, plan 5.**

22. **The synchronous `EmitCtx` construction at the single exit is not wrapped
    in a try/catch.** In `src/server/handler.ts`'s trigger-two block, building
    `emitCtx` — `headersOf(response)` and `parseBodyText(captured, response)` —
    happens directly inside the `if (trace.emits !== undefined && ...)` guard,
    outside any `try`. The sibling callback-capture block immediately above it
    (trigger one, destination tier 2) wraps its equivalent computation —
    the same two helper calls, building `exprInput.result` — entirely inside
    its own `try`/`catch`. Only the per-emit async body (the `sleep`, the
    `runEmit` call) is guarded; the synchronous setup that precedes the `for`
    loop is not. Unreachable today — neither `headersOf` nor `parseBodyText`
    can throw for any `Response` this codebase produces — but it is asymmetric
    with the established pattern at that exit, and "something at the single
    exit outside the guard" is exactly the shape of plan 5's Critical defect
    (see "A refactor can move code out of a safety net" below). Inherited from
    the plan 6 brief's snippet, not introduced by the implementer; flagged for
    the whole-branch review, not fixed, because tasks 9 and 10 do not touch
    `handler.ts`.
    **Status: DONE, plan 6 whole-branch fix wave.** Folded into the same edit
    as finding C1 below — the `emitCtx` construction now sits inside the same
    `try`/`catch` as the delivery loop that follows it.

24. **I3's `clearTimeout` half has no assertion.** The whole-branch review's
    fix for `close()` waiting out a real, uncancelled `afterMs` timer has two
    halves: racing the wait against `closedSignal` (§2.3's "canceled by
    `close()`"), and clearing the underlying `setTimeout` so the event loop is
    not held open. The promptness test (`close() with a real (non-injected)
    sleep and a large afterMs returns promptly`) covers the race half —
    reverting `await Promise.race([emitSleep(delay), closedSignal])` to a bare
    `await emitSleep(delay)` fails that test at ~5005ms. But deleting only the
    `clearTimeout(entry.handle)` call inside `close()`, leaving
    `entry.resolve()` in place, leaves the suite green: the race is still
    unblocked by the resolved promise, and the only observable difference is a
    longer real process lifetime that nothing in the suite measures. A
    regression there — the real timer left running — would silently
    reintroduce "a CLI shutdown hangs for up to `afterMs`", the exact bug I3
    was raised to fix.
    **Status: documented deferral, plan 6.**

25. **`reset()` does not clear `pendingTimers`, while `close()` does.** Design
    §2.3 treats `close()` canceling pending timers and `reset()` clearing them
    as one sentence, implying parity. `close()`'s I3 fix (this wave) clears
    every real timer tracked in `pendingTimers`; `reset()` still only bumps
    `generation`. The emission itself is still correctly dropped — the
    `at !== generation` check inside the delayed IIFE catches it — but the
    underlying `setTimeout` is not cleared and keeps the event loop open until
    it naturally fires. Measured: `settled()` called right after `reset()`
    blocks for the full `afterMs` (3005ms observed for `afterMs: 3000`). This
    is a promptness and shutdown-symmetry gap, not a correctness one — nothing
    delivers late or twice — and it predates this wave (the timer was never
    cancellable before I3's fix). It is only visible now that `close()` has a
    `clearTimeout` for `reset()` to be asymmetric with.
    **Status: documented deferral, plan 6.**

---

## Polish

8. `chaosSeed` is frozen at construction, so `setSeed` does not update it. Cosmetic
   only — chaos still varies because `requestKey` carries the seed.
10. Latency is skipped on an injected failure. The literal spec order permits it,
    but a slow outage is the more realistic behavior. Worth one line in §7.2 either
    way.
11. `classify`'s `union.mode` is consumed by the compiler now, but
    `additionalProperties: <Schema>` and `oneOf` exactly-one arrived in plan 4 —
    check nothing else reads `mode` expecting the old looseness.
12. `OperationConfig`'s numeric index signature could collide with its reserved
    `status`/`respond` keys. Pre-existing since plan 2; numeric status keys cannot
    actually collide with those names.
13. `toSecuritySchemes` uses `as` casts with no runtime validation, so a malformed
    `type` silently yields an invalid scheme. Matches the existing loader style.
14. `split()` is duplicated between `src/resolve/target.ts` and
    `src/spec/routes.ts`. Identical one-liners; extracting couples two modules for
    little gain.
18. A failed body parse consumes a request ordinal. Parse failures now draw from
    `requestOrdinals` under the matched key, so a failed parse shifts the
    `requestId` of the next successful request sharing that identity. Harmless —
    `requestId` never feeds the PRNG — but it is an unremarked behavior change
    from plan 5.
20. The log block's own `try`/`catch` in `src/server/handler.ts` is untested.
    Nothing inside it can realistically throw now that `emitLog` self-isolates,
    so this is defense in depth rather than a gap.
21. `templateFor` duplicates `allowedMethods`' loop body in the router.
    Extracting the shared walk would couple two small functions for little gain.
23. In `test/server/webhooks-loopback.test.ts`'s `finally` blocks, both tests
    run `await mock.close()` before `await hook.close()`. If `mock.close()`
    threw, `hook.close()` would be skipped, leaking the throwaway `node:http`
    receiver's listening socket. `mock.close()` has no plausible throwing
    surface, so this is cosmetic; it mirrors the accepted single-resource
    convention already in `test/server/node.test.ts`.
26. Every `afterMs > 0` emission (I3's fix, plan 6) races its wait against the
    module-scoped `closedSignal` promise via `Promise.race`, which attaches a
    reaction that is only released when `close()` resolves `closedSignal`. On
    a short-lived mock or a test process this is inert. On a long-lived
    `listen()` server that accumulates traffic and is never closed, each such
    emission's reaction sits on `closedSignal`'s subscriber list for the rest
    of the process's life. Bounded by traffic rather than unbounded, and each
    reaction is tiny with no reference cycle, so this is cosmetic rather than a
    leak in the classic sense — worth a line if `closedSignal` ever gains a
    reason to reset itself (for instance, if `reset()` is taught to be
    symmetric with `close()`, per item 25).

---

## Process lessons worth keeping

**Four tests reached plans 2 and 3 that could not fail.** Each was caught by
review, never by the plan author. The three shapes:

- `async () => Promise.resolve(x)` is auto-flattened by JS before any settle logic
  sees it, so it passes against the single-pass implementation it exists to rule
  out. Prove nested settling with a *container* holding a pending promise.
- A test asserting two components **agree** cannot catch a blind spot they share —
  generation and validation both dropped `allOf`-nested constraints and agreed
  perfectly. Assert the constraint is **honored**.
- `assert.equal(result.ok, false)` passes when the code fails for an unrelated
  reason. Assert the specific error path.

**The countermeasure that worked every time:** require a mutation observation
before accepting a test that proves a mechanism. Revert the fix, watch the test
fail, report the exact message. That caught all four.

**A deferral's justification can expire.** See item 7.

**A deterministic system makes replay tests toothless by default.** Generation is
seeded, so two real executions of the same request already return byte-identical
bytes — an idempotency replay test that only compares bodies passes with
idempotency removed entirely. Plan 5's replay test counts executions through a
plain closure counter (`let runs = 0`, incremented inside the `respond`
callback) so the two paths genuinely differ. Whenever a test asserts "the same
output", ask what else could produce that same output.

**A mutation that exercises the wrong branch proves nothing.** A test in plan 5
survived both its author's and its implementer's mutation runs because both
mutated a nearby line rather than the specific condition the test targeted; a
reviewer caught it. Name the exact condition to mutate, not just "the
implementation line" — see Task 7's note in the plan 5 ledger.

**A brief that contradicts itself will be resolved silently unless the
implementer is asked to flag it.** One plan 5 task's key formula disagreed with
its own test literals, and the first resolution quietly dropped a scoping axis
(see item 5). Ask implementers to report self-contradictions rather than
resolve them unremarked.

**A refactor can move code out of a safety net without touching the net.**
Plan 5 split the request pipeline so every response leaves through one exit,
then hung idempotency's store write on that exit — outside the boundary catch
that had covered every previous `Store` touch. Each per-task review saw
correct code; the defect existed only where two tasks met, and only the
whole-branch review could see it. When a refactor relocates work, ask what
invariants were being enforced by its old location.

**A test that derives its expectation by calling the function under test can
verify plumbing but never pin a value.** Plan 6's retry test computed its
expected delay sequence by calling `backoffFor`, the function it was testing —
so mutating that function moved both sides of the assertion together, and the
mutation looked observed while doing nothing. It is the first shape found that
survives a naive mutation check. Hardcode the expected value, with a comment
saying what would legitimately change it.

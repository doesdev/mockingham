# Deferred items

Findings raised by code review during plans 2–5, deliberately deferred rather than
fixed at the time, each with the ruling that deferred it and where it belongs.

This file is tracked in git on purpose. The SDD ledgers that originally held these
live under `.superpowers/` inside per-plan worktrees, which is gitignored scratch —
one `git worktree remove` and the reasoning is gone. Anything here is meant to
survive that.

Status as of 2026-08-12: plan 5 merged, 494 tests, `main` at the phases 7–9
design spec (now implemented).

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
   during plan 5 and they ruled it out of this plan's scope. It goes to plan 6 —
   this is now a deliberate deferral, not an oversight.

7. **Cookie parameters cannot validate.** `Parameter['location']` includes
   `'cookie'` and `src/runtime/validate.ts` handles only path/query/header.
   *Plan 3 deferred this on the grounds that nothing in the runtime parsed cookies;
   plan 3's own auth work then added a cookie parser, and the final review caught
   the stale rationale. It was fixed in plan 3's fix wave — listed here only so the
   pattern is on record: a deferral's justification can expire while the deferral
   sleeps.*
   **Status: DONE, plan 3.**

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
`ctx.seq()`-backed callback so the two paths genuinely differ. Whenever a test
asserts "the same output", ask what else could produce that same output.

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

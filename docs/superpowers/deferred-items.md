# Deferred items

Findings raised by code review during plans 2–4, deliberately deferred rather than
fixed at the time, each with the ruling that deferred it and where it belongs.

This file is tracked in git on purpose. The SDD ledgers that originally held these
live under `.superpowers/` inside per-plan worktrees, which is gitignored scratch —
one `git worktree remove` and the reasoning is gone. Anything here is meant to
survive that.

Status as of 2026-08-12: plans 1–4 merged, 408 tests, `main` at the phases 7–9
design spec.

---

## Must be done first in plan 5

These block phase 9 rather than merely annoying it.

1. **Collapse `run()`'s four exit points into one.**
   `src/server/handler.ts` returns from the 404/405 path, the body-parse failure,
   a stage short-circuit, and the rendered response. Logging is pipeline stage 11
   and must observe **every** response — a 401 from auth and a 503 from chaos are
   exactly what an operator wants — and there is nowhere to hook it.
   *Deferred twice: once in plan 3's fix wave, once in plan 4's, both times because
   a single fix wave with no second review is the wrong place for a restructure
   sitting beside correctness fixes.*

2. **Give each stage a named factory colocated with its module.**
   Phases 4–6 design §2.3 specifies an explicit named sequence; the code has an
   array of anonymous closures, losing both stated benefits — the order
   typechecking, and a stack trace naming the stage that responded.

3. **Settle whether `reset()` owns the whole Store.**
   `Mock.reset()` calls `store.clear()`, wiping a caller-supplied store wholesale,
   while `Handler.reset()` does not touch the store at all. The two surfaces
   disagree, and idempotency records are about to start living there.

---

## Correctness, not blocking

4. **`circuit-count` has no TTL** (`src/runtime/failure.ts`), so it never decays.
   A policy with `after: 5` eventually trips from failures accumulated across the
   whole process lifetime rather than within any window.

5. **Circuit keys are scoped by operation, not by the policy that declared them.**
   Two failure policies each carrying a `circuit` block and matching the same
   operation share one counter and one open-state. Fix when policies gain identity.

6. **`override()` is absent from `Mock`** although phases 4–6 design §7.3 and §1.3
   both specify it. Decide deliberately and record the outcome; it was never
   consciously dropped, it was simply never planned in.

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
9. `requestKey` is computed twice per request in `src/server/handler.ts`.
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

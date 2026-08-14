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

27. **The missing `exports` map.** The docs — README, all four guides —
    universally tell readers to `import { createMock } from 'mockingham'`.
    That resolves today only because `package.json` declares no `exports`
    map: `main` is `src/index.ts` and Node's default resolution falls through
    to it for the bare specifier. Deciding what is public — one export
    surface via a real `exports` map versus today's everything-resolves
    looseness — is a packaging decision with permanent blast radius: an
    `exports` map added later is a breaking change for anyone who found a
    working deep import in the meantime. It is not a docs decision, and
    phase 12's boundary is no `src/` or `package.json` changes.
    **Status: deferred, phase 12 docs cycle.** Belongs to whichever cycle next
    opens packaging. See docs-design delta §5.4.

28. **`pattern` is silently ignored by value generation, while request
    validation enforces it.** `pattern` appears nowhere in
    `src/generate/values.ts` or `src/generate/constraints.ts` (confirmed by
    grep — zero hits in either file); `src/schema/compile.ts`'s `patternOf`
    compiles it into the zod validator incoming requests are checked against.
    The two directions disagree: a mock can emit a response body it would
    reject as a request body. Evidence, reproduced during Task 9 against
    `docs/example.json`'s `Payment.currency` (`{ "type": "string", "pattern":
    "^[A-Z]{3}$" }`): a bare `createMock` with no fixtures generates values
    like `"ember"` and `"larch"` for that field, neither of which matches
    `/^[A-Z]{3}$/`. No startup warning fires either — master §19 advertised
    both "covers a documented subset" and "warned at startup" for this gap;
    neither half was ever true. Master §19 has been corrected at the source
    (2026-08-14, phase 12) to state the true, asymmetric behavior instead of
    the false "covered subset, warned at startup" claim.
    **Status: documented deferral, phase 12 docs cycle.** Fixing generation to
    honor `pattern` (a real regex-to-string generator, or at minimum a startup
    warning naming the schema path) belongs to whoever next opens
    `generate/values.ts`; an override or fixture is the only present escape
    hatch. See master §19 and README's Known limitations.

29. **Three MCP read-tool residuals from plan 8, rediscovered during phase 12
    rather than tracked.** All three were found and verified against
    `src/mcp/tools/read.ts` while writing `docs/mcp.md` (Task 8) and are
    documented in that guide, but plan 8 itself never recorded them here —
    they lived only in a gitignored SDD ledger inside a now-gone worktree,
    which is exactly the failure this file exists to prevent (see the file's
    own header). Recording them here for the first time:
    - **(a) `findOperation` ignores `method`/`path` when `operationId` is also
      supplied.** The `operationId` branch (`findOperation`, lines ~21-30)
      returns immediately on a match with no check that a co-supplied
      `method`/`path` agrees with it — passing a mismatched pair alongside a
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
      helper every other tool uses.** `jsonSchemaOf` (lines ~52-56) falls back
      to `{ "$comment": "not expressible as JSON Schema; this operation is
      generated only" }` when `toJsonSchema` refuses a schema (chiefly
      recursive ones), and `describeOperation` and `contentSchemas` both route
      through it. `listWebhooks` (line ~350) instead calls `toJsonSchema`
      directly: `media ? toJsonSchema(media.schema, compiler) : undefined` — a
      recursive webhook payload comes back as `payloadSchema: undefined`
      rather than the `$comment` placeholder.
    None of the three surface in `docs/mcp.md`'s own runnable examples —
    `docs/example.json` has no scenario that naturally exercises any of them
    without a contrived setup — so all three are documented in prose there,
    with source citations, rather than demonstrated running.
    **Status: documented deferral, phase 12 docs cycle.** None is a regression
    from plan 8; all three are pre-existing and merely went unrecorded until
    now. Fix belongs to whoever next opens `src/mcp/tools/read.ts`.

30. **`durationMs` is unobservable — not merely stable — under an injected
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
    **Status: documented deferral, phase 12 docs cycle.** Not a defect —
    `now() - startedAt` is the correct implementation for a real clock — but
    any test or document that pins the clock cannot use `durationMs` to prove
    anything about timing, and should not be written as though it can.

31. **The cross-process half of the determinism invariant has no automated
    coverage.** `scripts/determinism.ts` exists to be run twice, as two
    separate `node` processes, and diffed by hand — but no test and no npm
    script ever does that. Confirmed: `grep -rln 'determinism.ts' test
    package.json` returns nothing. `test/fixtures/determinism.test.ts` is a
    real, passing test, but it proves a narrower claim — a baked fixture store
    serves the stored value byte-identically across independently constructed
    `Handler` instances, all within one process — not the cross-process case.
    Determinism is invariant 2, the README leans on it by name, and it is also
    the load-bearing assumption behind the entire phase-12 docs harness
    (docs-design §2.2: "this is only possible because of invariant 2 ... a doc
    can promise exact bytes"). The stronger cross-process claim the harness's
    own design rationale depends on is asserted nowhere in `npm test`.
    Found and corrected in prose during Task 9 (README no longer claims a test
    proves it) and in the docs-design spec §3.2 during Task 10 (which had
    itself claimed "the test that runs it" — see that document's 2026-08-14
    correction note).
    **Status: documented deferral, phase 12 docs cycle.** Wiring
    `scripts/determinism.ts` into `npm test` — spawning it twice as real child
    processes and diffing stdout — is real, buildable coverage; phase 12's
    no-code-change boundary is why it wasn't done here.

33. **`4XX`/`5XX` range response keys are silently mis-parsed.**
    `src/spec/load.ts:34` uses `Number.parseInt(code, 10)` on every response
    status key, so a status key of `'4XX'` parses to `4` rather than being
    recognized as an OpenAPI range key (`Number.parseInt('4XX', 10) === 4`).
    An operation's declared error contract ends up loaded under status `4`,
    which no real request status can ever match, so the built-in error
    envelope is served instead — silently downgrading a declared contract to
    the generic fallback. OpenAPI 3.x permits `1XX`–`5XX` range keys for
    exactly this case. Found correcting README.md's error-contract guarantee
    during the phase 12 fix wave. This is a source defect; the fix wave's
    boundary is no `src/` changes.
    **Status: documented deferral, phase 12 docs cycle.** Fix belongs to
    whichever cycle next opens `src/spec/load.ts`.

34. **`process.stdout.write(util.inspect(x))` bypasses `assertPrintableLogs`
    entirely.** `test/docs/fence-checks.ts`'s `assertPrintableLogs` only scans
    a `ts` fence for the literal substring `console.log(` — any other route to
    stdout (`process.stdout.write`, `console.error`, a helper that wraps
    `util.inspect` under a different name) is invisible to it. The
    determinism amendment the check exists to enforce — stable,
    cross-Node-version-printable output — can be sidestepped by writing to
    stdout through any path other than a literal `console.log(`.
    **Status: documented deferral, phase 12 docs cycle.**

35. **Three quote-tracking loops in `test/docs/fence-checks.ts` disagree on
    backslash escapes.** `assertPrintableLogs` and `checkShellFence` both
    treat a quote character preceded by a backslash as escaped
    (`rest[i - 1] !== '\\'` / `withComment[i - 1] !== '\\'`); `splitArgs` has
    no escape handling at all — a backslash is an ordinary character to it.
    Confirmed by tracing `assertPrintableLogs` against
    `console.log('a\\', payload)`: the doubled backslash before the closing
    `'` is misread as an escaped quote, the tracker never exits the string,
    the paren-depth/comma-at-depth-1 check that would catch the second
    argument only runs outside a quote and so never fires, and the call is
    accepted despite passing two arguments.
    **Status: documented deferral, phase 12 docs cycle.**

36. **Nothing enforces that a `console` fence follows the `ts` block that
    produces its output.** `assembleProgram` and `expectedOutput`
    (`test/docs/harness.ts`) each filter the fence list independently by
    language and join in document order — only the relative order *within*
    each language survives. Nothing checks that a `console` fence sits next
    to, or even after, the `ts` fence whose output it claims to show; a
    document that prints an expected block above unrelated prose, or above
    the code that produces it, passes exactly the same as one that doesn't.
    **Status: documented deferral, phase 12 docs cycle.**

37. **A `txt` fence is inert, so fabricated program output placed in one is
    never checked.** `runDocument`'s per-language dispatch
    (`test/docs/harness.ts`) branches on `ts`, `sh`, `json`, and `jsonc`; a
    `txt` fence passes `assertKnownFences` but has no branch at all, so its
    content is never run, never diffed, and never checked in any way — matching
    the docs-design spec's own §2.3 table, which lists `txt` as "inert —
    directory listings and file trees" by design. `docs/mcp.md:23-28`
    legitimately uses one for the "needs `@modelcontextprotocol/sdk`" message
    the CLI actually prints — verified by hand against `src/mcp/`'s lazy-load
    path — but the harness has no way to distinguish that from a document
    author simply typing whatever they want.
    **Status: documented deferral, phase 12 docs cycle.**

38. **`checkJsonFence` only inspects a `mcpServers` key.**
    `test/docs/fence-checks.ts`'s `checkJsonFence` reads
    `(parsed as McpClientConfig).mcpServers` and returns immediately when it
    is `undefined` — a client config shaped for a host that uses a different
    top-level key (a bare `servers` map, say) receives no argument checking
    at all, even though the docs-design spec's §2.3 table states the check
    ("an MCP client config's `args` array is additionally fed through the
    real `mockingham mcp` parser") as if it applied to any JSON fence holding
    a client config, unconditionally.
    **Status: documented deferral, phase 12 docs cycle.**

39. **A child process writing more than 1 MB to stdout fails opaquely, though
    not via the timeout path.** `runDocument` (`test/docs/harness.ts`) calls
    `execFile` with no `maxBuffer` override, so Node's 1 MB default applies.
    Verified against this repo's Node (v24.18.0): exceeding it does not set
    `error.killed` — it stays `undefined`, not `true` — so `runChild`'s
    `error.killed === true` timeout check never fires; `error.code` is
    instead the string `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, which
    `runChild`'s `typeof error.code === 'number' ? error.code : 1` folds into
    an ordinary `code: 1`. `assertDocument` then reports a plain "exited 1"
    failure with the entire truncated ~1 MB of stdout dumped into the error
    message and no mention of `maxBuffer` anywhere — unhelpful, but a
    different failure shape than a `killed`-driven timeout misdiagnosis would
    be.
    **Status: documented deferral, phase 12 docs cycle.**

40. **The coverage sweep only walks `docs/` non-recursively, with
    `README.md` hardcoded.** `test/docs/docs.test.ts`'s coverage test calls
    `readdir(join(REPO, 'docs'))` with no `recursive` option, so a guide
    placed in a subdirectory of `docs/` would never be discovered by the
    sweep. `README.md` is not discovered at all — it is simply one of the
    four literal entries in `DOCUMENTS`, exercised only because its own
    subtest runs, never verified to exist by the coverage assertion itself. A
    future top-level reader-facing markdown file outside `docs/` (a
    `CONTRIBUTING.md`, say) would be silently uncovered either way.
    **Status: documented deferral, phase 12 docs cycle.**

41. **Citation style drifts across the guides.** Some name the source
    document — `docs/logging-datadog.md:38`: "phases 7-9 design §2.1";
    `docs/mcp.md:206`: "master §17" — others cite a bare section symbol with
    nothing naming which document it belongs to —
    `docs/webhooks.md:163`: "the same layering §4 applies". Every citation
    resolves to a real section in a real spec today, so nothing is broken,
    but the docs-design spec (§4) asks a guide that states a rule to cite
    "the invariant or spec section the rule comes from," and a bare `§4`
    does not say which of this repo's three specs that is.
    **Status: documented deferral, phase 12 docs cycle.**

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
32. `src/mcp/server.ts:6-9`'s `McpOptions.transport` JSDoc says `'stdio'`
    "connects immediately." It does not: `createMcpServer` (`src/mcp/server.ts`)
    only branches on `options.transport === 'http'` when building `path`;
    nothing there or in `mcp()` (`src/index.ts`) reads `'stdio'` at all. A
    `'stdio'` handle only starts talking JSON-RPC once the caller separately
    awaits `handle.connectStdio()` — which is exactly what the `mockingham mcp`
    CLI subcommand does on the caller's behalf
    (`src/server/cli.ts:540-541`: `mock.mcp({ transport: 'stdio', ... })`
    immediately followed by `await server.connectStdio()`). Found during
    phase 12 docs (Task 10) while correcting the same false claim, inherited
    from this JSDoc, that had leaked into `docs/mcp.md:76`. The guide was
    corrected at the source; this comment is source under `src/`, which is out
    of scope for the docs cycle's no-code-change boundary.
    **Status: documented deferral, phase 12 docs cycle.** Fix belongs to
    whichever cycle next opens `src/mcp/server.ts`.

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

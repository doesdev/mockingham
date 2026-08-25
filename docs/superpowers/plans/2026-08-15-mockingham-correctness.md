# mockingham Correctness Cycle Implementation Plan

> **EXECUTED 2026-08-15**, branch `plan-11-correctness`, 1000 → 1050 tests.
> All six tasks landed; deferred items 28, 30, 31 and 33 are closed in the
> ledger. The checkboxes below were not ticked as it ran - the commits and
> `docs/superpowers/deferred-items.md` are the record.
>
> **Three things the plan got wrong, all caught by running its own mutation
> steps rather than by re-reading them:**
> 1. Task 1's sort mutation was vacuous - an exact key is integer-like and JS
>    iterates it before a string range key, so the tiebreak is unobservable
>    through `loadApi`. The test was rewritten to say what it really guards.
> 2. Task 2's restamp was unnecessary (a range bound already equals its wire
>    status) and its second mutation was wrong (the range-only 500 is closed by
>    Task 1's loader fix, not the `servable` guard).
> 3. Task 3's mutation was vacuous - pinning a repeat count to `max` satisfies
>    every bound assertion, so quantifier seeding was untested until a test was
>    added that observes more than one length.
>
> **And one defect the plan did not anticipate at all:** ranges share a status
> with an exactly declared response, which collided in `bake`'s per-status
> fixture key - three generated, two stored, reported as success. Found by
> reviewing the branch, not by the suite. See the final two commits.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four contract violations the phase 12 docs cycle found and
deliberately did not fix. Nothing here is a feature; every task closes a gap
between what the spec promises and what the code does.

**Architecture:** Three independent seams and one doc change. Range response
keys are a loader change plus a selection change - the loader learns a
representation, selection learns a precedence and a restamp. `pattern` is a new
leaf-value producer called from the one place strings are generated; the
fallback chain it needs already exists and must not be rebuilt. Cross-process
determinism is a test that spawns the script nobody runs.

**Tech Stack:** TypeScript run directly by Node 24's native type stripping,
`node:test`, `zod` (the only runtime dependency).

**Spec:** `docs/superpowers/specs/2026-08-15-mockingham-correctness-design.md`
Read it before Task 1. The master contract is
`docs/superpowers/specs/2026-08-11-mockingham-design.md`; the delta wins where
they disagree - including on the `pattern` warning, which the delta amends from
§3's "startup warning" to first-encounter.

## Global Constraints

- **Node >= 24.2.0**, ESM, **erasable syntax only**: no `enum`, no `namespace`,
  no parameter properties. Use `const X = {...} as const`.
- **The core stays pure.** `src/generate/pattern.ts` imports no `node:` module.
  The Task 5 test is a test, not core, and may spawn processes freely.
- **Determinism.** The regex generator draws from the seeded `Rng` and nothing
  else. No `Math.random()`, no `Date.now()`, no iteration over an unordered
  `Set`/object in a generation path.
- **One schema interpretation.** No new schema traversal. The pattern generator
  is a leaf producer called from `generateString`, not a walk.
- **US English spelling** everywhere - `honor`, `behavior`, `serialize`,
  `normalize`, `canceled`.
- **One plain command per Bash call, with literal arguments.** No `&&`, `||`,
  `;`, pipes, `$(...)`, `VAR=value` prefixes, heredocs, `>` redirects, or `cd`.
  Use the Write tool for files.
- `git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy.
- Tests live in `test/` mirroring `src/`, TypeScript, run by `node:test`.
  Write the test first, watch it fail, then implement.
- `npx tsc --noEmit` must stay clean.
- **`npm test` starts at 1000 passing and is EXPECTED to go red during Task 4.**
  See that task's warning - changing generated values changes byte-compared doc
  fences. Do not "fix" that by reverting the generator.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/generate/pattern.ts` | The regex subset parser and seeded string producer |
| `test/generate/pattern.test.ts` | Per-construct unit tests |
| `test/determinism/cross-process.test.ts` | Spawns `scripts/determinism.ts` twice and byte-compares |

**Modified:**

| File | Change |
|---|---|
| `src/spec/types.ts` | `ResponseSpec.range?: boolean` |
| `src/spec/load.ts` | `toResponses` - strict key parsing, range representation, total sort |
| `src/runtime/select.ts` | Range precedence in `responseForStatus`; restamp and 1XX skip in `selectResponse` |
| `src/generate/values.ts` | `generateString` consults `pattern` before `format`, bypasses `fitLength` |
| `src/generate/generate.ts` | `GenerateOptions.onUnsupportedPattern`, threaded to `generateString` |
| `src/server/handler.ts` | Builds `onUnsupportedPattern` over a dedupe set; `now` doc comment |
| `test/spec/load.test.ts` | Range and malformed-key cases |
| `test/runtime/select.test.ts` | Precedence, restamp, 1XX |
| `test/generate/values.test.ts` | Pattern honored, `fitLength` bypassed |
| `docs/superpowers/specs/2026-08-11-mockingham-design.md` | §3 warning wording, §19 retire the correction note |
| `README.md` | Known limitations - `pattern` no longer unsupported |
| `docs/superpowers/deferred-items.md` | Close items 28, 30, 31, 33 |

**Ordering rationale:** the two range tasks are sequential on the same feature
and land first because item 33 is the only one of the four that currently
returns a 500. The pattern tasks are sequential on each other but independent of
range. Task 5 is independent of everything. Task 6 is documentation and closes
the ledger, so it runs last and can absorb whatever the earlier tasks learned.

---

## Task 1: Range response keys in the loader

**Files:**
- Modify: `src/spec/types.ts`, `src/spec/load.ts`
- Test: `test/spec/load.test.ts`

**Interfaces:**
- `ResponseSpec` gains `range?: boolean`. `status` carries the range's lower
  bound (`4XX` → 400), so every existing `response.status === x` comparison
  keeps its meaning.

- [ ] **Step 1: Write the failing tests**

In `test/spec/load.test.ts`:

```ts
test('a 4XX range key loads as status 400 flagged as a range', () => {
  const api = loadApi(docWithResponses({ '4XX': errorResponse }))
  const [spec] = api.operations[0].responses
  // 400, NOT 4 - Number.parseInt('4XX', 10) is 4, which is what shipped.
  assert.equal(spec.status, 400)
  assert.equal(spec.range, true)
})

test('an exact status is not flagged as a range', () => {
  const api = loadApi(docWithResponses({ '404': errorResponse }))
  assert.equal(api.operations[0].responses[0].range, undefined)
})

test('an exact status sorts before a range at the same bound', () => {
  // Input order deliberately puts the range first, so a sort that is not
  // total would preserve it and this would fail.
  const api = loadApi(docWithResponses({ '4XX': errorResponse, '400': okResponse }))
  const [first, second] = api.operations[0].responses
  assert.equal(first.range, undefined)
  assert.equal(second.range, true)
})

test('a malformed response key is skipped rather than coerced', () => {
  // '200abc' parsed to 200 and '99' to 99 before this cycle.
  const api = loadApi(docWithResponses({ '200abc': okResponse, '99': okResponse }))
  assert.deepEqual(api.operations[0].responses, [])
})

test('every range bucket 1XX through 5XX is recognized', () => {
  const keys = ['1XX', '2XX', '3XX', '4XX', '5XX']
  const api = loadApi(docWithResponses(Object.fromEntries(
    keys.map((key) => [key, okResponse])
  )))
  assert.deepEqual(
    api.operations[0].responses.map((r) => r.status),
    [100, 200, 300, 400, 500]
  )
})
```

Run `node --test test/spec/load.test.ts`. The first, third, fourth, and fifth
must fail. **If the second passes already, that is correct** - `range` is
undefined today because the field does not exist; keep it as a regression guard
but do not count it as evidence.

- [ ] **Step 2: Implement**

In `src/spec/types.ts`, add `range?: boolean` to `ResponseSpec` with a comment
saying `status` holds the lower bound.

In `src/spec/load.ts`, replace the `parseInt` in `toResponses`:

```ts
const RANGE_KEY = /^([1-5])XX$/i
const EXACT_KEY = /^[1-5][0-9]{2}$/

// parseInt is a converter here, never a parser: it accepted '4XX' as 4 and
// '200abc' as 200, which is how a declared error contract loaded unreachable.
```

Sort must be total - by `status`, then exact before range:

```ts
responses.sort((a, b) =>
  a.status - b.status || Number(a.range ?? false) - Number(b.range ?? false)
)
```

- [ ] **Step 3: Verify by mutation**

Delete the `|| Number(...)` tiebreak. The exact-sorts-before-range test must
fail. **Validate this mutation before trusting it** - if the test still passes,
the input order in the fixture is doing the work and the test is wrong, not the
mutation.

- [ ] **Step 4:** `npx tsc --noEmit` clean. Full `npm test` - note any test that
moves. Adding `range` should move nothing; a response count changing means a
document in the fixtures had a malformed key that used to load, which is a
finding worth reporting, not silently accepting.

---

## Task 2: Range precedence and restamping in selection

**Files:**
- Modify: `src/runtime/select.ts`
- Test: `test/runtime/select.test.ts`

**Interfaces:**
- `responseForStatus` resolves exact → range → `default` → undefined.
- `selectResponse` never returns a spec carrying a range bound as a wire status.

- [ ] **Step 1: Write the failing tests**

```ts
test('a declared 4XX contract serves an injected 422', async () => {
  // The reported defect, end to end through the public surface.
  const mock = createMock(docWith4XX, { seed: 's' })
  await mock.failNext('listPayments', { status: 422 })
  const res = await mock.fetch(new Request('http://localhost/payments'))
  const body = await res.json()
  assert.equal(res.status, 422)
  // The built-in envelope has `error.code`; the declared contract does not.
  assert.equal(Object.hasOwn(body, 'declaredErrorContract'), true)
})

test('an exact declared status beats a range that contains it', () => {
  const operation = operationWith({ '400': exactSpec, '4XX': rangeSpec })
  assert.equal(responseForStatus(operation, 400), exactSpec)
  // ...and the range still serves the rest of its bucket.
  assert.equal(responseForStatus(operation, 401), rangeSpec)
})

test('a range beats default, and default still serves outside every range', () => {
  const operation = operationWith({ '4XX': rangeSpec }, defaultSpec)
  assert.equal(responseForStatus(operation, 404), rangeSpec)
  assert.equal(responseForStatus(operation, 503)?.status, 503)
})

test('an operation whose only response is a range still serves', async () => {
  // Shipped behavior: a hard 500, because new Response rejects status 4.
  const mock = createMock(docWithOnly4XX, { seed: 's' })
  const res = await mock.fetch(new Request('http://localhost/only-range'))
  assert.equal(res.status, 400)
  assert.notEqual(res.status, 500)
})

test('a 1XX range is never selected as the response', async () => {
  // new Response rejects anything below 200, so 1XX has no servable status.
  // It degrades to the built-in envelope rather than throwing.
  const mock = createMock(docWithOnly1XX, { seed: 's' })
  const res = await mock.fetch(new Request('http://localhost/informational'))
  assert.notEqual(res.status, 500)
})
```

- [ ] **Step 2: Implement**

```ts
const RANGE_STATUS = { 2: 200, 3: 300, 4: 400, 5: 500 } as const

/** A range spec can never go on the wire carrying its bound. */
function servable(spec: ResponseSpec): ResponseSpec | undefined {
  if (!spec.range) return spec
  const stamped = RANGE_STATUS[Math.floor(spec.status / 100) as 2 | 3 | 4 | 5]
  // 1XX has no servable status at all - new Response requires >= 200.
  return stamped === undefined ? undefined : { ...spec, status: stamped }
}
```

`responseForStatus` gains the range branch between exact and `default`:

```ts
const ranged = operation.responses.find(
  (r) => r.range === true && status >= r.status && status < r.status + 100
)
if (ranged) return { ...ranged, status }
```

Note the restamp to the *requested* status there, not the bound - a 422 served
from a `4XX` contract is a 422.

In `selectResponse`, the 2xx finder and the `responses[0]` fallback both route
through `servable()` and skip a spec it rejects.

- [ ] **Step 3: Verify by mutation**

Two separate mutations, run one at a time - item 10 in the test-cannot-fail
ledger is two paths where one masks the other, and `responseForStatus` and
`selectResponse` are exactly that shape here:

1. Remove the range branch from `responseForStatus`. The injected-422 test must
   fail. If only the precedence test fails, the end-to-end test is not reaching
   this path.
2. Make `servable()` return the spec unchanged. The range-only test must fail
   with the 500.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`.

---

## Task 3: The regex subset generator

**Files:**
- Create: `src/generate/pattern.ts`, `test/generate/pattern.test.ts`

**Interfaces:**
- `generateFromPattern(pattern: string, rng: Rng): string | undefined` -
  `undefined` when the pattern uses anything outside the supported subset, which
  is the caller's signal to fall back.

Supported: literals and escaped literals, `.`, character classes with ranges
and negation, `\d \w \s \D \W \S`, anchors `^ $`, quantifiers `? {n} {n,m}`,
capped `* +`, alternation and groups.
Unsupported, returning `undefined`: lookaround, backreferences, named groups,
unicode property escapes.

- [ ] **Step 1: Write the failing tests**

Every test asserts the generated value **matches the pattern** - never that two
components agree. Shape 2 in the test-cannot-fail ledger is asserting agreement
instead of correctness, and generation-versus-validation agreement is the exact
bug this item is about.

```ts
const rng = createRng('pattern-tests')

for (const pattern of [
  '^[A-Z]{3}$', '^\\d{4}-\\d{2}-\\d{2}$', '^(cat|dog)$',
  '^[a-z][a-z0-9_]{2,8}$', '^#[0-9a-f]{6}$', '^\\w+@\\w+\\.[a-z]{2,3}$'
]) {
  test(`generates a value matching ${pattern}`, () => {
    const value = generateFromPattern(pattern, createRng('seed'))
    assert.notEqual(value, undefined)
    assert.match(value!, new RegExp(pattern))
  })
}

test('an unsupported construct returns undefined rather than a wrong value', () => {
  assert.equal(generateFromPattern('^(?=.*\\d)[a-z]+$', rng), undefined)
})

test('the same seed produces the same value', () => {
  // Determinism, invariant 2 - asserted on the producer directly.
  assert.equal(
    generateFromPattern('^[a-z]{8}$', createRng('fixed')),
    generateFromPattern('^[a-z]{8}$', createRng('fixed'))
  )
})

test('different seeds produce different values for a wide pattern', () => {
  // Guards the seed actually reaching the generator: a constant would pass
  // the determinism test above with the rng ignored entirely.
  assert.notEqual(
    generateFromPattern('^[a-z]{16}$', createRng('a')),
    generateFromPattern('^[a-z]{16}$', createRng('b'))
  )
})
```

That last test exists because the determinism test alone passes against a
hardcoded return value - shape 4 in the ledger, determinism making a test
toothless by default.

- [ ] **Step 2: Implement**

A small recursive-descent parser to an alternation/sequence/atom tree, then a
seeded emit pass. `*` emits 0–3 repetitions, `+` emits 1–3, both via `rng.int`.
Anchors parse and emit nothing. Return `undefined` from the parser - not a
throw - on any unsupported construct, and let the caller decide.

- [ ] **Step 3: Verify by mutation**

Replace the `rng.int` in the quantifier emitter with a constant `1`. The
`{2,8}` test must still pass (1 is out of range only for `{2,8}`, so pick the
mutation to bite: use a constant `0`) - **validate which constant actually
falls outside the tested bounds before trusting this step.** The prescribed
mutation being vacuous is the single most common failure in this project's
plans; eight of plan 7's sixteen tasks had one.

- [ ] **Step 4:** `npx tsc --noEmit`, full `npm test`. Nothing should move yet -
this module has no callers until Task 4.

---

## Task 4: Hook `pattern` into generation, and warn once

**Files:**
- Modify: `src/generate/values.ts`, `src/generate/generate.ts`,
  `src/server/handler.ts`
- Test: `test/generate/values.test.ts`

> **This task changes generated output, and the docs suite byte-compares
> generated output.** `docs/example.json`'s `Payment.currency` is
> `^[A-Z]{3}$` and currently generates `"larch"`. Every ```console fence
> carrying that value changes. `npm test` WILL go red mid-task. Re-run the docs
> suite, update the fences to the new values, and report which documents moved.
> Do not revert the generator to keep the suite green.

- [ ] **Step 1: Write the failing tests**

```ts
test('a patterned string generates a value matching its pattern', () => {
  const value = generateString({ type: 'string', pattern: '^[A-Z]{3}$' }, rng)
  assert.match(value, /^[A-Z]{3}$/)
})

test('pattern wins over format', () => {
  // compile.ts enforces the pattern on requests, so a conforming `email`
  // that fails the pattern is the asymmetry this item exists to close.
  const value = generateString(
    { type: 'string', format: 'email', pattern: '^[A-Z]{3}$' }, rng
  )
  assert.match(value, /^[A-Z]{3}$/)
})

test('fitLength does not run on a pattern-generated value', () => {
  // minLength 20 would append `-word` and break the match.
  const value = generateString(
    { type: 'string', pattern: '^[A-Z]{3}$', minLength: 20 }, rng
  )
  assert.match(value, /^[A-Z]{3}$/)
  assert.equal(value.length, 3)
})

test('an unsupported pattern warns once across many generations', () => {
  const seen: string[] = []
  const schema = { type: 'string', pattern: '^(?=.*\\d)[a-z]+$' }
  for (let i = 0; i < 5; i++) {
    generateString(schema, rng, { onUnsupportedPattern: (p) => seen.push(p) })
  }
  // Dedupe lives in handler.ts, so at this level it fires every time -
  // assert the COUNT the producer is responsible for, and test dedupe
  // separately through createMock rather than asserting it here.
  assert.equal(seen.length, 5)
})

test('createMock warns once per pattern across requests', async () => {
  const warnings: string[] = []
  const mock = createMock(docWithUnsupportedPattern, {
    seed: 's', onWarn: (m) => warnings.push(m)
  })
  await mock.fetch(new Request('http://localhost/thing'))
  await mock.fetch(new Request('http://localhost/thing'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /pattern/)
})
```

Note the warning test asserts a count and a substring, not an order - the delta
records that warning order varies with request order.

- [ ] **Step 2: Implement**

`generateString(schema, rng, options?)`. Before the `format` switch:

```ts
if (schema.pattern !== undefined) {
  const value = generateFromPattern(schema.pattern, rng)
  // Returned directly: fitLength would append or slice and break the match.
  if (value !== undefined) return value
  options?.onUnsupportedPattern?.(schema.pattern)
  // Falls through to the placeholder - `example` and `default` were already
  // consulted by generateValue before this was ever called.
}
```

`GenerateOptions` gains `onUnsupportedPattern?: (pattern: string) => void`, and
`generateValue` passes it through at the `generateString` call.

In `handler.ts`, build it over a dedupe set held outside the request path:

```ts
const warnedPatterns = new Set<string>()
// Membership only - never iterated, so invariant 2 is untouched.
const onUnsupportedPattern = (pattern: string) => {
  if (warnedPatterns.has(pattern)) return
  warnedPatterns.add(pattern)
  warn(`pattern not supported by value generation, falling back: ${pattern}`)
}
```

- [ ] **Step 3: Verify by mutation**

Make `generateFromPattern` always return `undefined`. The three pattern tests
must fail and the warn-once test must still pass. Then remove the
`warnedPatterns.has` guard: the createMock warn-once test must fail with 2.

- [ ] **Step 4: Reconcile the docs suite**

Run `node --test test/docs/`. Update every fence whose value moved. Report the
list of changed documents and values in the commit message - a reader of the
diff must be able to tell a legitimate regeneration from an accidental one.

- [ ] **Step 5:** `npx tsc --noEmit`, full `npm test` back to green.

---

## Task 5: Cross-process determinism coverage

**Files:**
- Create: `test/determinism/cross-process.test.ts`

- [ ] **Step 1: Write the test**

```ts
test('two separate processes produce byte-identical output', () => {
  const runOnce = () => spawnSync(
    process.execPath, ['scripts/determinism.ts'], { encoding: 'utf8' }
  )
  const first = runOnce()
  const second = runOnce()

  // Guards before the comparison: two crashed processes both print nothing
  // and compare equal. This is shape 12 - the designated proof that proves
  // nothing - and it is the exact shape the previous determinism proof had.
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout.trim().split('\n').length, 3)

  assert.equal(first.stdout, second.stdout)
})
```

- [ ] **Step 2: Verify by mutation**

Introduce `Math.random()` into a generation path the petstore document reaches
(`generateInteger`'s `rng.int` call is the direct one) and confirm the two
stdouts diverge and the test fails on the byte comparison, not on a guard.
**Name the exact line; do not break something adjacent.** Plan 5's dead 5xx
test survived two mutation checks because both broke a nearby line.

Then separately confirm the guards bite: make the script throw, and check the
test fails on the exit-code assertion rather than passing on two empty strings.

- [ ] **Step 3:** Full `npm test`. This adds 1 test.

---

## Task 6: Documentation, the spec, and the ledger

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-mockingham-design.md`, `README.md`,
  `docs/superpowers/deferred-items.md`, `src/server/handler.ts`

- [ ] **Step 1: The master spec**

§3's `pattern` paragraph: change "emits a single startup warning" to the
first-encounter behavior the delta amends it to, and state the `*`/`+` cap.

§19: retire the 2026-08-14 correction note - it describes a gap this cycle
closed. Replace it with the true remaining limitation: the subset is minimal,
lookaround and backreferences fall back, and a `pattern` that conflicts with
`minLength`/`maxLength` resolves in the pattern's favor.

- [ ] **Step 2: `HandlerOptions.now`**

Extend the doc comment at `handler.ts:112-115` to state that pinning the clock
makes `durationMs` compute to exactly 0, so it is discoverable at the injection
point rather than in a log. This is all item 30 gets, by ruling.

- [ ] **Step 3: README**

Known limitations: `pattern` is no longer unsupported. State what the subset
covers and what falls back.

- [ ] **Step 4: Close the ledger**

Items 28, 30, 31, and 33 each get a `**Status: DONE**` line naming this cycle
and its commits, in the style items 6 and 29 already use. Item 33's entry must
record the 500 that the original entry missed - the ledger is the durable record
and the escalation is the most useful thing this cycle learned about it.

- [ ] **Step 5:** Full `npm test`, `npx tsc --noEmit`, and `node --test test/docs/`.

---

## Verification

- `npm test` green, at 1000 + the new tests.
- `npx tsc --noEmit` clean.
- The two reproductions from the delta §7 now behave correctly: a declared 4XX
  contract serves an injected 422, and a range-only operation returns 400 rather
  than 500.
- `docs/example.json`'s `Payment.currency` generates a value matching
  `^[A-Z]{3}$`.
- `test/determinism/cross-process.test.ts` fails when a generation path is made
  non-deterministic.

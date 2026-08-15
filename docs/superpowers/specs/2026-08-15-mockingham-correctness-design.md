# mockingham — correctness cycle design delta

**Status:** approved 2026-08-15
**Amends:** `2026-08-11-mockingham-design.md` §3 (generation), §19 (known
limitations), and the response-loading behavior §2 implies
**Implements:** deferred items 28, 30, 31, and 33

This is a delta. The master spec is the contract; where this document
contradicts it, this document wins and the reason is stated.

This cycle fixes defects the phase 12 docs cycle found and deliberately did not
fix — that cycle's boundary was "change no `src/` file", so everything it found
was recorded instead. Four items come off that list here. Nothing in this cycle
adds a feature; every task closes a gap between what the spec promises and what
the code does.

**The finding that shaped this design:** two of the four are not the defects the
ledger describes. Item 33 is worse than recorded — a range-only operation does
not degrade to the built-in envelope, it returns a hard 500. Item 28 is smaller
than it looks — master §3 already specifies the exact generator to build, in
detail, and it was simply never implemented, so this is not a design question
but an unfinished one. Both were established by reproduction before this
document was written (§7).

---

## 1. Scope

**In:** OpenAPI range response keys (item 33); a minimal regex generator for
`pattern` (item 28); cross-process determinism coverage in `npm test`
(item 31); and a ruling on `durationMs` under a pinned clock (item 30).

**Out:** `regenerate_fixture`, still. It is the last survivor of the phase 10
deferral and it needs its own cycle — a narrow re-entry into the bake pipeline
with budget, staleness, and single-operation-scope questions that have nothing
to do with anything here. The runtime-overrides delta §1 declined to bundle it
for the same reason and that reasoning has not changed.

Also out: the other open items this cycle does not touch — `Store.setIfAbsent`
(item 15), `reset()` and pending timers (item 25), the three MCP read-tool
residuals (item 29a–c), the missing `exports` map (item 27), and the docs-harness
polish items 34–41. They are independent and none of them is a contract
violation.

---

## 2. Item 33 — range response keys

### 2.1 What is actually wrong

`src/spec/load.ts:34` runs `Number.parseInt(code, 10)` over every response key.
`Number.parseInt('4XX', 10)` is `4`. The declared response loads under status
`4`, which no request can ever produce.

Reproduced against a two-response document (`200` and `4XX`):

```
loaded response statuses: [4,200]
injected 422 -> body {"error":{"code":"MOCK_FAILURE_INJECTED", ...}}
on declared contract: false
```

That is an invariant 5 violation — "emit the operation's declared error schema
when one exists; only fall back to the built-in envelope when it does not." The
operation declares one. The envelope serves anyway.

### 2.2 The escalation the ledger did not record

When a range key is the operation's *only* declared response, `selectResponse`
falls through the 2xx finder to `operation.responses[0]` — status `4` — and
`new Response(body, { status: 4 })` throws, because the Fetch standard requires
200–599. Reproduced:

```
status: 500
body: {"error":{"code":"MOCK_INTERNAL",
  "message":"init[\"status\"] must be in the range of 200 to 599, inclusive."}}
```

So the operation is not degraded, it is dead, and it reports its own document's
valid OpenAPI as an internal mockingham defect. Item 33 was filed as a silent
downgrade; it is also a crash. This is why the cycle leads with it.

### 2.3 Representation

`ResponseSpec.status` stays a number and gains a sibling flag:

```ts
interface ResponseSpec {
  status: number      // 400 for '4XX' — the range's lower bound
  range?: boolean     // true when the key was 1XX-5XX
  // ...unchanged
}
```

Rejected: a separate `range: 1|2|3|4|5` field, which would make every existing
`response.status === x` comparison in the codebase wrong by omission rather than
by construction. With the lower bound in `status`, the existing comparisons keep
their meaning — an exact `400` and a `4XX` both sort and compare at 400 — and
only the code that must distinguish them needs to read `range`.

`default` keeps its current treatment: status `0`, held in `defaultResponse`,
not in `responses`. It is already the widest fallback and nothing here changes
it.

### 2.4 Key parsing

`toResponses` stops using `parseInt` as a parser and starts using it as a
converter after an explicit test:

- `/^[1-5]XX$/` (case-insensitive) — a range key. Status is the lower bound.
- `/^[1-5][0-9]{2}$/` — an exact status.
- `default` — unchanged.
- Anything else — skipped, as today.

**Ruled by the user, 2026-08-15: tighten.** This is a deliberate behavior change
beyond the reported defect. Today
`'200abc'` loads as 200 and `'99'` loads as 99. After this change both are
skipped. A key that is not a status and not a range is malformed OpenAPI, and
loading it under a plausible-looking number is how item 33 stayed invisible.
The plan must carry a test for each, because "we tightened a parser" is exactly
the kind of change that quietly drops a response someone depended on.

### 2.5 Precedence

`responseForStatus(operation, status)` — the function on-contract error
construction calls — resolves in OpenAPI's order:

1. an exact declared status,
2. a range whose bucket contains it (`status >= bound && status < bound + 100`),
3. `defaultResponse`, restamped with the requested status,
4. nothing, and the caller falls back to the built-in envelope.

An operation may declare both `400` and `4XX`; the exact one wins at 400 and the
range serves 401–499. Sorting in `toResponses` must therefore be total and
deterministic: by `status`, then exact before range. Sorting by `status` alone
leaves two entries at 400 in input order, and input order is object key order —
which is stable in JS but is not something this codebase relies on anywhere
else, and invariant 2 exists to keep it that way.

### 2.6 Selection, and the crash

`selectResponse` needs one rule: **a range spec is never returned carrying its
bound as a wire status.** Any range spec chosen as the response gets restamped
to a concrete status, exactly as `defaultResponse` already is:

- `2XX` → 200, `3XX` → 300, `4XX` → 400, `5XX` → 500.
- `1XX` → **never selectable.** `new Response` rejects any status below 200, so
  there is no concrete status a `1XX` range can be served as. It parses, it is
  addressable by `responseForStatus` for completeness, and the success finder and
  the `responses[0]` fallback both skip it. An operation declaring only `1XX`
  serves the built-in envelope rather than throwing — a degradation, chosen
  because the alternative is the 500 in §2.2.

The 2xx success finder (`status >= 200 && status < 300`) already admits a `2XX`
range at 400-vs-200 arithmetic — a `2XX` bound is 200, so it matches, which is
correct: a `2XX` key is a success declaration. It just has to come back stamped
200.

---

## 3. Item 28 — `pattern` in value generation

### 3.1 This is unfinished work, not new design

Master §3 line 225 already specifies it:

> **Defined limitation — `pattern`.** A minimal regex generator covers literals,
> character classes, anchors, and bounded quantifiers. Anything outside that
> subset falls back to `example`, then `default`, then a deterministic
> placeholder, and emits a single startup warning naming the schema path.

That is a complete specification of the intended behavior, including the
fallback chain and the warning. It was never built. §19 was corrected in phase
12 to describe the reality instead, which left the master spec describing two
different behaviors in two sections — §3 as though the generator exists, §19
saying it does not. **This cycle implements §3 and retires §19's correction
note.** No new design authority is needed; the design was approved in the
original spec.

Reproduced, against the ledger's own example
(`Payment.currency`, `^[A-Z]{3}$`): generated `"larch"`, matches `false`.

### 3.2 The generator

New module `src/generate/pattern.ts`, pure, seeded, consuming the same `Rng`
every other generator does. Supported subset, matching §3's four named
categories:

| Construct | Support |
|---|---|
| Literals, escaped literals | yes |
| `.` | yes — a safe printable, not any codepoint |
| Character classes `[a-z]`, `[^0-9]`, unions | yes |
| Shorthand `\d \w \s \D \W \S` | yes |
| Anchors `^` `$` | yes — consumed, they constrain nothing to emit |
| Quantifiers `?` `{n}` `{n,m}` | yes |
| Quantifiers `*` `+` | yes, capped (§3.3) |
| Alternation `\|`, groups `( )`, `(?: )` | yes — seeded pick among branches |
| Lookaround, backreferences, named groups, unicode property escapes | **no** |

Anything unsupported takes §3's fallback chain — `example`, then `default`, then
the current placeholder — and warns once.

### 3.3 Four rulings the spec line does not make

**Unbounded quantifiers are capped.** `*` and `+` are "bounded quantifiers" only
after this cycle picks a bound. `*` generates 0–3 repetitions, `+` generates
1–3, seeded. A `pattern` of `.*` therefore produces a short string rather than
an empty one, which is both more useful as a mock value and still valid.

**`pattern` beats `format`, and `enum`/`const` beat `pattern`.** When both
`pattern` and `format` are declared, the pattern is what request validation
enforces (`compile.ts` compiles both, and a generated `email` that fails the
declared pattern is the exact asymmetry item 28 is about). `enum` and `const`
are more specific than either and keep winning, unchanged.

**`fitLength` must not run on a pattern-generated value.** It appends
`-${word}` to reach `minLength` and slices to `maxLength`; either operation
breaks the match, which would replace a silent wrong value with a differently
silent wrong value. Pattern generation returns its value directly. Where a
`pattern` and a length bound genuinely conflict, the pattern wins and the
conflict is a documented limitation — the generator honors length only through
the quantifier bounds it derives from the pattern itself.

**The warning goes through `onWarn`.** It already exists —
`handler.ts:190`, `options.onWarn ?? console.warn`, whose own comment says it is
where startup warnings go and names unsupported runtime expressions as the other
case. The pure core does not learn to print; it reuses the sink. "A single
warning" means once per schema path, deduplicated, at construction — not once
per generated value, which would be per-request noise.

### 3.4 Where it hooks in

`generateString`'s `default:` branch (`values.ts:80`) is the only call site.
`pattern` is checked before `format` per §3.3 and before `fitLength`. No second
traversal — invariant 1 is untouched, because this is a leaf-value producer, not
a schema walk.

---

## 4. Item 31 — cross-process determinism coverage

`scripts/determinism.ts` exists to be run twice as two processes and diffed by
hand. Nothing runs it. Invariant 2's cross-process half — the half the README
leans on by name, and the load-bearing assumption behind the whole phase-12 docs
harness — is asserted nowhere in `npm test`.

New `test/determinism/cross-process.test.ts`: spawn `node scripts/determinism.ts`
twice as real child processes, compare stdout byte-for-byte.

**This test is shape 12 waiting to happen** — "the designated proof that proves
nothing", the entry in the test-cannot-fail ledger describing the previous
determinism proof, which compared two responses a fixed seed already guaranteed
identical. Two child processes that both crash print identical empty stdout and
the comparison passes. The test therefore asserts, in this order:

1. both exit codes are `0`,
2. stdout is non-empty and has exactly the 3 lines the script emits,
3. the two stdouts are byte-identical.

**Prescribed mutation, to be validated before it is trusted:** introduce
`Math.random()` into a generation path reached by the petstore document and
confirm the two stdouts diverge. Not "break a nearby line" — plan 5's dead 5xx
test survived two mutation checks that broke adjacent code. If the mutation does
not bite, the test is wrong, not the mutation.

---

## 5. Item 30 — `durationMs` under a pinned clock

`startedAt = now()` and `durationMs: now() - startedAt` read the same injectable
clock, so pinning it for determinism makes `durationMs` exactly `0` on every
request rather than merely repeatable.

**Ruling: no code change** — put to the user 2026-08-15 and confirmed against
the `options.monotonic` alternative. `now() - startedAt` is correct for a real clock, and
the alternative — a second, separate monotonic source — puts a non-injectable
time reading back inside the request path, which is what invariant 2 exists to
prevent. Trading a determinism guarantee for a diagnostic field is the wrong
trade.

What this cycle does instead is stop the field from being *quietly* degenerate:
`HandlerOptions.now`'s doc comment states that pinning it zeroes `durationMs`,
so the next person reads it at the type rather than discovering it in a log.
Item 30 closes as "working as designed, documented at the injection point."

**This is the one item in the cycle where I am overriding a plausible
alternative rather than fixing a clear defect, so it is the one worth
disagreeing with.** If observable timing under a pinned clock matters more than
a single time source, the fix is an explicit `options.monotonic` and it belongs
in its own cycle with its own determinism argument.

---

## 6. What does not change

**Invariant 1.** No new schema traversal. §3's generator is a leaf-value
producer called from the existing one.

**Invariant 2.** The regex generator draws from the seeded `Rng` and nothing
else. Item 31 adds coverage for this invariant rather than risking it, and §5
declines the one change that would have weakened it.

**Invariant 3.** `pattern.ts` imports no `node:` module. The item 31 test is a
test, not core, and may spawn processes freely.

**Invariant 5.** §2 is entirely in service of it — a declared range contract
becomes reachable, which is the whole point.

**The docs harness.** Any guide touched here is executed and byte-compared, so
a changed generated value changes a `console` fence. §3 changes generated output
for any patterned string field — `docs/example.json` has at least one
(`Payment.currency`) — so **the plan must budget for re-running the docs suite
and updating fences, and must expect `npm test` to go red in the middle of the
pattern task by design.** This is the cycle's most likely source of surprise.

---

## 7. Evidence

Every claim of defect here was reproduced before it was written down, per the
plan-sequence lesson that a reviewer's severity claim gets repeated unchecked
otherwise. Item 33's `[4,200]`, its 500, and item 28's `"larch"` are quoted from
actual runs against current `main` (`9bfa072`), not from the ledger. Items 30
and 31 were confirmed by reading current source and by
`grep -rn 'determinism.ts' test/ package.json scripts/` returning nothing.

The ledger's description of item 33 was incomplete, and the ledger's description
of item 28 understated how much of the design already existed. Both corrections
came from reproduction.

---

## 8. Testing

- **Item 33:** the two reproductions above become tests, plus exact-beats-range
  precedence, both-declared sorting, the 1XX degradation, and one test per
  rejected malformed key from §2.4.
- **Item 28:** per-construct generator tests asserting the value *matches the
  pattern* — never that two components agree, which is shape 2 in the
  test-cannot-fail ledger and is exactly how generation and validation came to
  disagree here in the first place. Plus: the fallback chain fires for an
  unsupported construct, the warning fires once rather than per-value, and a
  patterned field with `minLength` does not get `fitLength` applied.
- **Item 31:** §4, including its exit-code and line-count guards.
- **Item 30:** no test; a doc comment.

Every test that proves a mechanism gets a named mutation, and the mutation names
the exact condition to break.

---

## 9. What this leaves

After this cycle the open list is `regenerate_fixture` (the last phase 10
deferral), `Store.setIfAbsent` (item 15), `reset()` and pending timers (item 25),
the three MCP read-tool residuals (item 29a–c), the missing `exports` map
(item 27), and docs-harness polish (items 34–41). None is a contract violation;
all four contract violations found by phase 12 are closed here.

# mockingham — docs (phase 12) design delta

**Status:** approved 2026-08-14
**Amends:** `2026-08-11-mockingham-design.md` §18 (sequencing, phase 12), §1
(instance surface), §19 (known limitations), §17 (testing)
**Implements:** master spec phase 12

This is a delta. The master spec is the contract; where this document
contradicts it, this document wins for phase 12 and the reason is stated.

Phase 12 is the last numbered phase. It is also the first one whose deliverable
is read by strangers rather than executed by the machine, and that is the whole
design problem: prose has no compiler. Every prior cycle's worst defects were
two artifacts that each looked correct alone and disagreed at their seam. A
document is the highest-drift artifact this repo will ever hold, because
nothing fails when it goes stale.

So the central decision here is not what to write. It is that **the docs are
executed by the test suite**, and a document that lies fails `npm test`.

---

## 1. Scope

**In:**

- `README.md` — the public front door. There is no README in the repo today.
- `docs/example.json` — one canonical OpenAPI document that every guide runs
  against.
- `docs/logging-datadog.md`, `docs/fixtures.md`, `docs/webhooks.md`,
  `docs/mcp.md` — the four guides master §18 names.
- `test/docs/` — the extraction-and-execution harness, plus one subtest per
  document.
- Corrections to non-code artifacts the docs prove wrong: `CLAUDE.md`, master
  §1, master §19.

**Out:**

- **Any behavior change.** Not one line of `src/` changes in this cycle.
  Anything the docs expose that needs code becomes a deferred item with a
  ruling. This is a hard boundary, and §7 explains what it costs.
- The runtime-override cycle. `set_override`, `clear_overrides`,
  `regenerate_fixture`, and master §1's `Mock.override()` are the next cycle's
  work; the docs name them as absent rather than omitting them.

**Amendment 1.1 — phase 12 gains two deliverables master §18 does not list.**
§18 names five documents. It does not name the example document they share or
the harness that runs them. Both are load-bearing: without a shared document
each guide invents its own API and the reader learns five; without the harness
the other five deliverables are unverifiable prose. They are in scope.

---

## 2. The harness

### 2.1 One program per document

Every ```ts fence in a document concatenates, in source order, into a single
module. The harness rewrites `from 'mockingham'` to an absolute path into
`src/index.ts`, writes the module to a temp directory, and runs it in a child
process under plain `node` — Node 24 strips the types itself, which is the same
execution path the reader is on.

Concatenation rather than per-block isolation is deliberate. Prose builds state:
a guide says "now that you have a mock, emit a webhook," and the second block
legitimately depends on the first. Isolating blocks would force every one of
them to repeat its imports and setup, which is worse writing and worse
copy-paste fidelity for the blocks that matter. The quickstart blocks are
written self-contained anyway, so the path a reader is most likely to copy
whole still stands alone.

### 2.2 The output fence is the assertion

Expected stdout is the concatenation of that document's ```console fences, in
order, compared **byte-exactly** against what the child process printed. A
nonzero exit fails the subtest with the child's stderr attached.

One comparison covers both directions of drift: an unclaimed `console.log` and
a stale expected line are the same failure. There is no sidecar expectations
file to fall out of sync, and no test-only scaffolding in the prose — the
expectation is the thing the reader already wanted to see.

This is only possible because of invariant 2. The same request produces
byte-identical output across processes, so a doc can promise exact bytes.
A project without that invariant could not have this harness.

### 2.3 Every other fence gets a check; unknown fences fail

| Fence | Check |
|---|---|
| `ts` | executed, per §2.1 |
| `console` | the expectation for the run |
| `sh` | each `mockingham …` line is parsed by the real CLI parser; every other line must match a small allow-set (`npm install`, `ollama pull`, `ollama serve`, `npm test`, `npx tsc --noEmit`) |
| `json` / `jsonc` | parsed; an MCP client config's `args` array is additionally fed through the real `mockingham mcp` parser |
| `txt` | inert — directory listings and file trees |
| anything else | **test failure** |

Failing on an unrecognized info string is the point. A checked-in list of
exempt blocks is a list that goes stale silently; a hard failure means adding a
new kind of block is a decision someone makes on purpose.

The `sh` rule is what keeps the CLI documentation honest. Every flag printed in
a guide is fed to the parser that actually runs it, so a renamed flag fails the
docs suite without anyone running a server.

### 2.4 Determinism is injected, not hoped for

Doc programs inject everything that would otherwise vary:

- a fixed `now` for log timestamps,
- `listen(0)` where a server is needed, with the port never printed,
- a fake `fetch` wherever the network would be reached,
- `createRecordedSource` wherever a model would be.

The Datadog recipe's sink posts to that fake `fetch` and prints the exact body
and headers it would have sent to the intake. The reader sees the real wire
payload; the harness asserts it. Nothing in the docs suite reaches the network,
which matches the existing suite's rule.

**Anything that cannot be made deterministic does not ship as a runnable
block.** If a behavior can only be shown non-deterministically, the guide
describes it in prose and says why it is not shown running.

### 2.5 `console.log` may not print raw objects

**Amendment 2.5.** `console.log(someObject)` renders through `util.inspect`,
whose exact formatting is not a stability contract across Node minor versions.
A doc suite asserting on it would fail on a reader's Node for reasons unrelated
to mockingham, and worse, would fail in CI on an upgrade that broke nothing.

Doc programs print strings, template literals, or `JSON.stringify(value, null,
2)`. The harness enforces this by rejecting a `console.log` whose sole argument
is none of those three. This is a constraint on how the docs are written, and
it exists because the alternative is a suite that cries wolf.

---

## 3. What each document contains

### 3.1 `docs/example.json`

One payments API, shared by all five documents, chosen because idempotency keys
and webhooks are self-evidently motivated there rather than contrived:

- `POST /payments` — bearer auth, idempotent, `201` plus a declared error
  schema, and a `paymentSucceeded` callback.
- `GET /payments/{id}` — path parameter, declared `404`.
- `GET /payments` — paged, with an array query parameter.
- `POST /refunds` — API-key auth, to show two schemes in one document.
- A top-level `paymentFailed` webhook.

Schema content worth generating: `uuid`, `date-time`, a `number` with
`minimum`/`multipleOf`, an `enum` status, and a `pattern` inside the documented
subset of §19. Tags on every operation, so `list_operations` and
`search_operations` have something real to return.

It also makes `CLAUDE.md`'s own run command work for the first time (§5).

### 3.2 `README.md`

Written for a stranger on npm or GitHub, in this order: what it is; why not
Prism, MSW, or WireMock; requirements and install; a 60-second quickstart; a
tour with one tight section per subsystem, each ending in a link to its guide;
a CLI reference for `mockingham`, `mockingham bake`, and `mockingham mcp`; and
the known limitations, stated up front the way master §19 does.

The Node ≥ 24.2 native-type-stripping requirement is stated as a deliberate
choice with its reason — no build step, the published source is the source you
debug — not buried as a footnote. It is the first thing that will surprise
someone, so it goes near the top.

The tour's determinism claim is demonstrated rather than asserted. The runnable
block builds two mocks on the same seed and prints that their bytes match; the
prose then points at `scripts/determinism.ts` for the stronger cross-process
claim — **corrected 2026-08-14 (Task 9/10): no test spawns or imports that
script.** Nothing in `test/` does either; `test/fixtures/determinism.test.ts`
is a real, passing test, but it proves a narrower claim (a baked fixture store
serves the stored value byte-identically across independently constructed
handlers, all within one process), not the cross-process case. The README
says what is true — run the script, run it again, and diff the two runs by
hand — rather than claiming an automated test covers it. The README does not
spawn a subprocess of its own to prove it — that would duplicate an existing
check inside a document, which §4 exists to prevent. See
`docs/superpowers/deferred-items.md` (item 31, phase 12).

### 3.3 `docs/logging-datadog.md`

The `LogRecord` field table, then a batching `onLog` sink that flushes on size,
on an interval, and on close, posting to
`https://http-intake.logs.datadoghq.com/api/v2/logs` with a `DD-API-KEY`
header.

The point the recipe exists to make: **`route` is the templated path and is
safe as a tag; `path` is resolved, high-cardinality, and must never be one.**
That distinction is already in `runtime/logging.ts`'s own comments, and getting
it wrong is how a mock server produces a surprising metrics bill. The guide
also covers `ctx.log` for custom fields and `onError`, so that a sink failure
can never reach a response.

### 3.4 `docs/fixtures.md`

The four modes (`off`, `bake`, `lazy`, `live`), local model first: bake against
`http://localhost:11434/v1`, commit the fixture files, serve them with
`--fixtures`. Then the staleness warning when the document moves underneath a
fixture, `scope.byName` / `scope.bySchema`, `persona`, and `budget` — carrying
the recorded caveat that **`maxConcurrency` is a per-call batch size, not a
concurrency bound**. `createRecordedSource` for tests. Anthropic as the hosted
alternative, second.

Local first because the OpenAI-compatible wire format is the built-in default
provider, needs no API key, and lets a reader follow along in five minutes.

The whole guide is framed by invariant 4: a fixture or LLM miss is never an
error, it falls through to seeded generation. A reader who takes only that away
has taken the right thing.

### 3.5 `docs/webhooks.md`

Declaring callbacks and top-level webhooks, configuring destinations, and what
triggers a fire — then the testing loop that is the actual reason to read it:
`captureOnly: true` → `settled()` → `deliveries()` → assert → `clearDeliveries()`.
Signing and manual `emit()` follow. Invariant 6 is stated plainly: emission
never affects the response.

States the known limitation that `reset()` leaves emission timers pending while
`close()` cancels them, so `settled()` after a `reset()` waits out the full
`afterMs` (deferred item 25).

### 3.6 `docs/mcp.md`

Both transports — `mockingham mcp <doc>` over stdio, and
`mock.mcp({ transport: 'http' })` mounted on the mock's own fetch surface,
which works before or after `listen()`. The twelve shipped tools, one line
each. A ready-to-paste client config, whose flags the harness parses (§2.3).

Then the three things a user otherwise discovers the hard way:

1. `--write` gates the five write tools.
2. With the gate closed those five names **still appear in `tools/list`** with
   a `Disabled.` description. Hiding them and naming the enabling flag in the
   refusal cannot both happen; the flag is the more useful half.
3. `sample_response` **is** `mock.fetch`, so it 401s on an auth-protected
   operation unless the caller supplies credentials. An auth shortcut would
   recreate the second code path the no-drift design exists to prevent.

`set_override`, `clear_overrides`, and `regenerate_fixture` are named as not
yet existing, with a pointer to the next cycle.

---

## 4. Guides are not a second contract

A guide shows usage. The design docs remain authoritative. Where a guide states
a rule, it cites the invariant or spec section the rule comes from rather than
restating it in new words.

This is not stylistic. Two documents that both define the same behavior in
their own words are exactly the seam that plan 7's worst defects lived in, and
a guide that quietly becomes a contract is one nobody knows to update when the
contract changes.

---

## 5. Corrections to non-code artifacts

Each is recorded in `docs/superpowers/deferred-items.md` with its ruling.

**5.1 `CLAUDE.md`'s run command is broken.** It documents
`node src/server/cli.ts docs/example.json --port 4000`, and `docs/example.json`
has never existed. §3.1 makes the command work rather than deleting it.

**5.2 Master §1 advertises a method that has never existed.** The instance
surface lists `override(target: string, value: Override): void`. It has never
been implemented at any point in the project. It is marked as deferred to the
runtime-override cycle rather than left reading as shipped — a public README
derived from a surface listing a phantom method is how a phantom method gets
into someone's code.

**5.3 Master §19's limitations are reconciled with what shipped.** The README
restates them for a public audience, and any that reality has overtaken are
corrected at the source rather than diverging silently.

**5.4 The missing `exports` map is recorded, not fixed.** The docs tell readers
to `import { createMock } from 'mockingham'`, which resolves today only because
`package.json` declares no `exports` map. That is a real packaging question with
a real blast radius — it decides what is public forever — and it is not a docs
decision. Deferred with this ruling attached.

---

## 6. Testing

`npm test` gains one subtest per document, five child processes total.
`npx tsc --noEmit` stays clean.

**Prove the harness can fail.** Before the guides are written, and again at the
end, three deliberate mutations must each produce a distinct failure:

1. one character changed inside a ```console fence,
2. one flag renamed inside the MCP client config,
3. one `ts` block pointed at a method that does not exist.

A docs harness that passes against wrong docs is worse than no harness, because
it converts "nobody checked" into "the suite says it is fine." This repo has
shipped that shape before; it does not ship again unproven.

The harness itself is built and mutation-proven against a deliberately wrong
throwaway document **before** any real guide exists, so its first real input is
not also its first test.

---

## 7. What the no-code-change boundary costs

Stating it plainly rather than discovering it mid-cycle: writing tested docs
against a surface always surfaces things the surface should do differently.
Every one of them will be recorded and none will be fixed here.

The cost is that some guides will document a rough edge instead of a smooth
one. That is the right trade for a cycle whose entire value is that its output
is trustworthy — a docs cycle that also changes behavior produces documents
describing code that changed while they were being written, which is the drift
this design exists to prevent, arriving through the front door.

---

## 8. Sequencing

1. `docs/example.json` — everything runs against it.
2. The harness, mutation-proven against a throwaway document (§6).
3. The four guides. Independent of each other; parallelizable.
4. `README.md`, which links to all four.
5. The corrections pass (§5), with rulings in `deferred-items.md`.

---

## 9. What this leaves for the next cycle

The runtime-override cycle: `set_override`, `clear_overrides`,
`regenerate_fixture`, and master §1's never-implemented `Mock.override()`. Its
design has to settle precedence — runtime override vs. config override vs.
fixture vs. spec example — in `resolve/layer.ts`, the layer that has produced
more defects than any other in this project.

Plus whatever §5.4 and §7 accumulate in `deferred-items.md` while these
documents are written.

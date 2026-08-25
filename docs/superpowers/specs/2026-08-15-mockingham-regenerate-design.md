# mockingham - regenerate_fixture design delta

**Status:** approved 2026-08-15
**Amends:** `2026-08-11-mockingham-design.md` §1 (instance surface), §14
(fixtures/LLM), §15 (MCP tools)
**Implements:** the last item deferred by the phase 10 MCP delta §1

This is a delta. The master spec is the contract; where this document
contradicts it, this document wins and the reason is stated.

This closes the final deferral. `regenerate_fixture` has been deferred twice -
by the phase 10 MCP delta, which shipped twelve of §15's fourteen tools, and
again by the runtime-overrides delta, which took the other two. Both cited the
same reason: `bake()` walks every operation and every JSON response, so
re-running one is a new entry point with its own budget, staleness, and scope
semantics. Those three questions are answered in §5.

**The finding that shaped this design:** the sources disagreed about what the
tool *is*. Master §15 says "re-run the LLM for one operation." `docs/mcp.md`
says "a tool to save a live-generated response as a committed fixture" - a
different tool, needing no LLM at all. The MCP delta §9 settles it by naming
"the **scoped re-bake** beneath the third," and the user confirmed that reading.
`docs/mcp.md`'s sentence is a phase-12 inaccuracy and is corrected here.

---

## 1. Scope

**In:** `regenerate_fixture` (write) and `list_fixtures` (read), plus the core
change beneath the first - a scope filter on `bake()`.

**Also in, by ruling:** the tool may persist. With `createDiskFixtureStore`,
`store.set` already writes through to disk, and this tool does not fight that.
See §6.

**Out:** everything else. This is the last deferral and the cycle is sized to
close it, not to reopen the fixture subsystem. Specifically out: re-baking by
wildcard target, a fixture *delete* tool, editing a stored value in place, and
the three MCP read-tool residuals (items 29a–c) that live in the file this
cycle touches - except that §4 declines to *repeat* 29a, which is different
from fixing it.

---

## 2. What it is

`regenerate_fixture` re-runs the configured `ContentSource` for one operation -
optionally one status - and stores the result, exactly as `bake()` does for the
whole document. It is `bake()` with a filter, not a second pipeline.

It therefore **requires an LLM source**. Without one it refuses, with the
message `Mock.bake()` already uses. That is not a violation of invariant 4: the
invariant says a fixture or LLM *miss* falls through to seeded generation while
serving a request, and this is not a request - it is an explicit instruction to
regenerate, which cannot be silently satisfied by doing nothing.

**Master §15's one-line description stands. `docs/mcp.md`'s does not** and is
corrected: nothing in this cycle saves a live-generated response as a fixture.
That tool ("promote what the mock just generated") is a coherent idea and was
explicitly considered and not chosen; it is recorded in §10 rather than built.

---

## 3. The core change

`BakeOptions` gains one optional field:

```ts
export interface BakeScope {
  /** `operationSlug` - the document's operationId when it has one. */
  operationId?: string
  method?: string
  /** Templated form, e.g. /orders/{orderId}. */
  path?: string
  /** Absent means every declared JSON status for the operation. */
  status?: number
}

export interface BakeOptions {
  // ...unchanged
  only?: BakeScope
}
```

It is applied in the existing planning loop - the one that already walks
operations and responses - as a `continue` before `buildRequest`. **No second
traversal and no second entry point.** Every downstream behavior (chunking,
`persona`, `scope` narrowing, `schemaHash`, the store write, the summary) is
reached by exactly the code that reaches it today, which is the whole reason to
filter rather than to write a `regenerate()` beside it.

`Mock.bake()` takes the filter as an optional argument rather than growing a
sibling method:

```ts
bake(options?: { only?: BakeScope }): Promise<BakeSummary>
```

**Amends master §1**, which types `bake()` as taking nothing. The argument is
optional, so every existing call and every doc example is unchanged.

---

## 4. Targeting, and the rule that a miss is an error

**Method plus path identifies an operation; `operationId` is the friendlier
alias.** `operationSlug` - `operationId` when the document supplies one, else
`method_path` - is what the fixture store is keyed by, so matching on it is
matching on the thing that actually names a fixture.

**When both `operationId` and `method`/`path` are supplied they must agree, and
disagreement throws.** This is deliberate and is the one place the cycle looks
at a known residual: `findOperation` (item 29a) ignores `method`/`path` entirely
when `operationId` is also given, so a caller passing a mismatched pair gets
silence. That residual is not fixed here - it is in the shared read helper and
fixing it would change three shipped tools - but the new filter will not
reproduce it.

**A filter matching nothing throws rather than returning an empty summary.**
The precedent is `compileTarget`, which throws on a target that matches no
operation instead of silently arming nothing, and the reasoning carries: an
agent that typos an operationId and receives `{generated: 0, skipped: 0}` has
been told its regeneration succeeded at doing nothing. A `status` that the
operation does not declare is the same error.

A filter that matches an operation whose only responses are non-JSON, recursive,
or a range key is **not** an error - those are the existing `skipped` paths, and
the summary reports them honestly. The distinction is between "you named
something that does not exist" and "what you named cannot be baked."

---

## 5. The three deferred questions, answered

Both deferrals named budget, staleness, and scope. None needed new machinery.

**Budget - inherited, and the filter is the real bound.** `regenerate_fixture`
uses the mock's configured `llm.budget` exactly as `bake()` does. `maxCalls` is
applied after planning, so a filter that plans three requests under a
`maxCalls: 1` budget attempts one and reports two skipped - the same rule,
observably. No per-call budget argument: an MCP tool that can raise its own
spending limit is a tool that can spend without asking.

**Staleness - regeneration is the remedy, and now it is reachable.** A stored
fixture carries `schemaHash` and `generatedAt`; `warnOnStaleFixtures` compares
that hash against the current document at construction and warns without
removing anything. Regenerating rewrites both fields, so the entry stops being
stale. Until now the only remedy was re-baking the entire document. Note the
warning is a *startup* check, so it does not re-fire after a regeneration - the
fix is visible through `list_fixtures` (§7), which is a large part of why that
tool earns its place in this cycle.

**Scope - the configured one, and it is a property of the entry.** The run uses
`llm.scope` exactly as `bake()` does, so a regenerated entry carries the same
`scoped: true` meta and `resolve()` treats it identically. **A regeneration
under a different `llm.scope` than the original bake changes that entry's shape
between whole-value and layer.** That is the honest behavior - the meta records
what the entry actually is, which is precisely why `FixtureMeta.scoped` exists
rather than reading the ambient config at serve time - and it is documented
rather than guarded against.

---

## 6. Disk writes

**Ruled by the user, 2026-08-15: the tool persists like anything else.** It
calls `store.set`; whether that reaches disk is the store's business, and with
`createDiskFixtureStore` it does, debounced. An agent with write tools enabled
can therefore cause a write into the developer's fixture directory.

**This amends master §15's "Write tools mutate only runtime state. They never
edit the user's config file."** The second sentence stays true and is the one
that matters - no tool edits configuration. The first is too broad as written:
a fixture store is the mock's own data, the gate is `write: true` (opt-in on
both transports, and already the boundary for `reset` and `set_seed`), and a
regenerate that evaporates on restart would not be a "committed fixture" in any
sense worth having.

The alternatives were considered and declined: memory-only writes fight the
store abstraction and make the tool's whole effect temporary, and a `persist`
argument buys a second code path to test for a decision the store has already
made.

---

## 7. `list_fixtures`

A read tool over the fixture store, which no tool has been able to see. The MCP
delta §8 parked exactly this here - "surfacing the fixture store through MCP is
`regenerate_fixture`'s territory, deferred with it."

```
list_fixtures({ operationId?, status?, includeValues? })
  -> Array<{ operationId, status, key, generatedAt?, schemaHash?,
             scoped?, stale, value? }>
```

- **`stale`** is computed against the live document with `schemaHashLookup`, the
  same helper the startup check uses. This is the tool's real value: "which of
  my fixtures no longer match the document" is currently answerable only by
  restarting and reading a warning.
- **`includeValues` defaults false.** A whole document's fixture values is a lot
  of tokens to hand an agent that asked what exists.
- Output order is `records()`, which is already sorted so persistence writes
  byte-identical files - so the tool is deterministic for free, and must not
  re-sort by anything derived from an object's key order.

It is a **read** tool: it reveals what the mock would serve, which is what
`sample_response` already does one response at a time.

**Tool counts move from 7 read / 7 write to 8 / 8**, and `mcpTools({ write:
true })` from fourteen to sixteen. The inventory test added in the
runtime-override cycle pins these and must be updated deliberately, which is
the point of it.

---

## 8. What does not change

**Invariants 1 and 2.** No new schema traversal; the filter sits inside the
existing walk. Nothing in the generation path gains a new source of
nondeterminism, and `records()` is already ordered.

**Invariant 3.** `bake.ts` stays free of `node:` imports; persistence is the
disk store's business, behind the same interface.

**Invariant 4.** Unchanged and worth restating precisely, because §2 could be
misread as eroding it: a fixture or LLM miss while *serving* still falls through
to seeded generation. Refusing an explicit regenerate with no source configured
is not that case.

**The docs harness.** `docs/mcp.md` is executed and byte-compared. It states a
tool count and lists the tools, and §7 changes both, so its fences will move by
construction. `docs/fixtures.md` covers the bake-commit-serve loop and is the
natural home for the new tools' prose.

---

## 9. Testing

- The filter: by `operationId`, by `method`+`path`, with and without `status`.
- The error cases, each distinct: an unknown operation, a status the operation
  does not declare, and a mismatched `operationId` vs `method`/`path` pair.
- The non-error skips: non-JSON content, recursive schema, range key - each
  reports `skipped` rather than throwing.
- A regeneration **replaces** a stored entry rather than appending, and updates
  `generatedAt` and `schemaHash`. The source must return a *different* value
  from the first bake, or the test passes with the write removed entirely -
  determinism makes replace-vs-noop invisible otherwise, which is shape 4 in
  the test-cannot-fail ledger.
- Budget truncation with a filter, asserting the summary, not just the store.
- `list_fixtures`: `stale` true after the document's schema changes under a
  stored fixture, and false after regenerating it. That pair is the tool's
  reason to exist and neither half proves it alone.
- Both tools behind the write gate: `regenerate_fixture` absent from a
  read-only server's callable set, `list_fixtures` present.

Every test that proves a mechanism gets a named mutation, and the mutation names
the exact condition to break - the last cycle had three vacuous ones out of six
and every one was caught by running it rather than re-reading it.

---

## 10. What this leaves

**Nothing deferred.** This is the last item on the phase 10 list, and with it
every numbered phase and every deferred *feature* is closed. What remains is the
non-blocking correctness list - items 15 (`Store.setIfAbsent`), 25 (`reset()`
and pending timers), 27 (the missing `exports` map), 29a–c (the MCP read-tool
residuals), and 34–41 (docs-harness polish).

**Recorded, not built:** a "promote the live-generated response to a fixture"
tool - take what the mock produces right now, with no LLM involved, and store it.
It came from `docs/mcp.md`'s description of `regenerate_fixture` and is a
genuinely useful idea for a document with no LLM configured, which is most of
them. It is not this tool, and naming it `regenerate_fixture` would have made
the spec's own sentence false. If it is ever wanted, it is small, and it should
be called something like `pin_fixture`.

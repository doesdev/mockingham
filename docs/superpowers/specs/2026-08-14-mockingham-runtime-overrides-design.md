# mockingham — runtime overrides design delta

**Status:** approved 2026-08-14
**Amends:** `2026-08-11-mockingham-design.md` §1 (instance surface), §4
(overrides), §10 (state), §12 (logging/debug headers), §15 (MCP tools)
**Implements:** the runtime-override work deferred by the phase 10 MCP delta §1

This is a delta. The master spec is the contract; where this document
contradicts it, this document wins and the reason is stated.

This cycle makes master §1's `Mock.override()` real. It has been specified since
the first design and implemented at no point — phase 12 marked it
`NOT IMPLEMENTED` in the master spec rather than let it read as shipped, and
that marker comes off here.

**The finding that shaped this design:** precedence already exists. `render.ts`
composes `[fixtureLayer, ...bodyOverrides]` and applies them in sequence, which
is what makes `override > fixture > example > generated` fall out of the
existing override machinery rather than a bespoke merge. A runtime override does
not need a new precedence model. It needs a slot in the one that is already
there, and the whole of §3 is a consequence of that.

---

## 1. Scope

**In:** `Mock.override()`, `Mock.clearOverrides()`, and the `set_override` and
`clear_overrides` MCP tools.

**Out, deferred again and deliberately:** `regenerate_fixture`. The phase 10
delta §1 already recorded why — `bake()` walks every operation and every JSON
response, so re-running one operation is a new entry point with its own budget,
staleness, and scope semantics. Those questions have nothing to do with
overrides, and bundling them would put two unrelated subsystems in one plan.
Plan 7's lesson was that the worst defects live at the seam between two things
that each look correct alone; this cycle declines to build such a seam.

Also out: TTL'd overrides, `respond` at runtime, overriding request validation
or auth, and any new validation of override bodies (§5.2).

---

## 2. Surface

```ts
interface RuntimeOverride {
  status?: number
  [status: number]: { body?: OverrideNode; headers?: Record<string, OverrideNode> }
}

mock.override(target: string, value: RuntimeOverride): Promise<void>
mock.clearOverrides(target?: string): Promise<void>
```

`RuntimeOverride` is `OperationConfig` minus `respond` and `emits`. One is a
function that cannot cross a JSON boundary; the other fires webhooks and belongs
with the emission lifecycle, not with "what does this endpoint return right
now."

**Amendment 2.1 — both methods are async, against master §1's `void`.** The
Store is async. §1 already drifts here: it declares `failNext` and `outage` as
`void` while `index.ts` has shipped them as `Promise<void>` since phase 6. This
delta follows the code, not the older spec.

**Amendment 2.2 — `override()` rejects a value that is not JSON-serializable**,
naming the offending path in the error. A function inside an override node would
survive an in-process Store and vanish through an injected external one: the
same code, two deployments, silently different behavior. Refusing it at the door
is also what keeps `Mock.override()` and `set_override` the same surface in fact
rather than in name — the property the MCP delta §3.3 calls structural no-drift.

**Targets** resolve through the existing `resolveTarget`, so `'getPayment'`,
`'GET /payments/{id}'`, and wildcards behave exactly as they do for `failNext`.
An unmatched target **throws at call time** rather than silently arming nothing,
which is the rule `index.ts` already documents for the control plane.

### 2.3 Keying and repeated writes

Runtime overrides are keyed **per resolved operation**, so setting the same
target twice replaces rather than stacks. An agent poking at a live mock
converges on what it last asked for instead of accumulating invisible layers it
cannot enumerate or unwind.

**There is no layering among runtime overrides**, and the consequence is worth
stating because it differs from the config model. Two distinct targets that
resolve to disjoint operations never interact — they are separate keys. But two
distinct targets that both resolve to the *same* operation collide there, and
the later write wins for that operation: `override('*')` followed by
`override('getPayment')` leaves `getPayment` carrying only the second value,
not a merge of both. Config overrides layer because they are compiled together
at construction and their order is fixed and readable; runtime overrides arrive
one at a time, from a caller who cannot see what is already set, and a merge
they cannot inspect is worse than a replacement they can predict.

`clearOverrides(target)` resolves the target the same way `override()` did and
clears the resulting operations: the argument that set them clears them.

---

## 3. Storage and lifecycle

State lives in the Store, keyed per resolved operation, following the
`failNext`/`outage` precedent in `index.ts` exactly. This satisfies master §10's
one-kernel rule, and it means an injected external Store shares overrides across
processes — a feature, not an accident.

**A new module, `runtime/overrides.ts`, owns the key convention, the write, and
the read.** `index.ts` writes through it; the pipeline reads through it; neither
invents a key. This is the reasoning `failure.ts` records in its own comment
about exported key builders: the writing side and the reading side sharing a key
by coincidence is a defect that leaves both test suites green.

### 3.1 Clearing everything, and why the obvious answer is wrong

`Store` exposes `get`, `set`, `delete`, `incr`, and `clear`, and no enumeration.
So `clearOverrides()` cannot ask which override keys exist.

`store.clear()` would work and is wrong: it also discards idempotency keys,
chaos counters, and captured callback URLs — far more than was asked.

Instead, `clearOverrides()` deletes the override key for **every operation in the
document**. The operation list is finite, known at construction, and already the
authority for what a target can resolve to. No index entry to keep consistent, no
second state location, correct against an external Store. The cost is N deletes
where N is the number of operations.

### 3.2 Lifecycle

`reset()` already clears runtime overrides, because it calls `store.clear()`.
Master §1 has always claimed `reset()` clears runtime overrides; this is the
first cycle in which that claim has anything to clear. It is asserted by a test
rather than inferred from `store.clear()`.

No TTL and no expiry. `failNext` has `times` and `outage` has `forMs` because
failure injection is inherently temporary. An override is a statement about what
the mock returns until told otherwise. A timed override can be added later
without disturbing anything here.

---

## 4. The pipeline seam

One read, three composition points, nothing else moves.

The read goes immediately after `resolveConfigs` in `server/handler.ts`,
returning a `ResolvedConfig`-shaped view — or a shared empty singleton when no
override exists, so the common path allocates nothing.

| Point | Composition |
|---|---|
| Status selection | `runtime.status ?? config.status` |
| `bodyOverrides` | `[...config.bodies(s), ...runtime.bodies(s)]` |
| `headerOverrides` | `{ ...config.headers(s), ...runtime.headers(s) }` |

That is the entire integration. The fixture still sits beneath both. Resolvers,
promise settling, and the single exit are untouched, because a runtime override
is not a new kind of thing — it is one more entry in an array `render.ts`
already walks. Invariant 1's spirit is "never add a second traversal," and this
adds none.

The read happens **once, early**, rather than at render, because `config.status`
feeds status selection and selection runs well before the body is rendered. One
read serves both.

### 4.1 The cost, stated

One additional `store.get` on every request that matched an operation, whether
or not an override exists. An in-memory "have any been set?" flag would avoid
it, and would be wrong precisely when a shared external Store is doing its job:
another process's write would never flip this process's flag. One lookup is the
honest price.

### 4.2 Two interactions, documented rather than discovered

**A configured `respond` beats a runtime override.** `handler.ts` returns
`config.respond(ctx)` before status selection and render happen at all. This is
correct — `respond` replaces the whole render — but it means the one config knob
a runtime override cannot reach is the one that most looks like it should lose.

### 4.3 The debug header

**Amendment 4.3 — `debugHeaders` gains `x-mock-override: applied`** when a
runtime override contributed to the response. Master §12 defines the debug
headers as `x-mock-seed`, `x-mock-status-source`, and `x-mock-operation`; this
adds a fourth. An agent that has just called `set_override` needs a way to
confirm the override took effect that is not "read the body and squint," and the
mechanism already exists for exactly this purpose.

---

## 5. What does not change

### 5.1 Determinism

Invariant 2 is restated, not weakened. "The same request produces byte-identical
output across processes" has always meant *given the same control-plane state* —
`setSeed` and `failNext` already change what a request returns. Runtime
overrides join that set. Nothing in the generation path becomes
non-deterministic, no `Math.random()` or `Date.now()` enters it, and the docs
harness stays byte-exact because doc programs set no override they do not also
assert.

### 5.2 No new validation

An override body is not validated against the operation's response schema.
That is already true of config overrides, and a runtime override that behaved
differently would be a second validation path — the divergence invariant 1
exists to prevent. Producing an off-contract body remains possible and remains
the caller's choice.

---

## 6. MCP tools

`set_override` takes `{ target, value }`; `clear_overrides` takes `{ target? }`.
Both are thin adapters over the `Mock` methods — the tool calls the method, it
never reimplements it (MCP delta §3.3).

Both are **write tools**, gated behind `--write`. The gated set grows from five
to seven, and the phase 10 behavior extends unchanged: with the gate closed both
names still appear in `tools/list` carrying a `Disabled.` description, because
hiding them and naming the enabling flag in the refusal cannot both happen and
the flag is the more useful half.

An unmatched target throws and surfaces as a tool error. A silent no-op is how
an agent concludes the mock is broken.

---

## 7. What this cycle deliberately breaks

Each of these is a check doing its job, and each is required work, not cleanup:

- `test/server/public-surface.test.ts` pins the exported API and the MCP tool
  list. It fails until updated.
- `MCP_USAGE` in `server/cli.ts` names the five write tools in its `--write`
  help text. Seven now.
- **`docs/mcp.md` fails its own subtest.** It states twelve tools and drives real
  `tools/list` frames whose output the docs harness compares byte-for-byte.
  Adding two tools changes that output and the docs suite goes red.
- `README.md`'s tour and `docs/mcp.md` both describe all three deferred tools as
  not existing. Two of the three now exist.
- Master §1's `NOT IMPLEMENTED` marker on `override()` comes off.

The phase 12 harness earns its cost on the very next cycle: a stale tool list is
now a build failure rather than a thing someone notices months later.

---

## 8. Testing

- `test/runtime/overrides.test.ts` — the key convention, the
  JSON-serializability rejection and its message, target resolution, a wildcard
  writing one entry per matching operation, and a typo throwing.
- `test/server/overrides.test.ts` — runtime cases join the existing config-override
  suite, driven end to end through `mock.fetch`. **Precedence is asserted here,
  through the public surface, not in a unit test of the composition helper.**
  Plan 7's defining lesson was that seam defects surface only end to end.
- **Every precedence assertion must have all five layers present at once.** A
  test with a runtime override over a generated body proves nothing about
  ordering — it passes with the whole composition removed. This is shapes 2 and
  12 on the project's own list of tests that cannot fail, and it is the single
  most likely defect in this cycle.
- MCP tool tests, including the gate-closed refusal for both new names.
- `reset()` clears overrides — asserted, not inferred from `store.clear()`.
- Documentation updates are part of the work, and the docs suite will not go
  green without them.

---

## 9. What this leaves

`regenerate_fixture`, and with it the narrow re-entry into the bake pipeline —
budget accounting, staleness, and single-operation scope. That is the last piece
of the phase 10 deferral, and it wants its own delta.

# mockingham — MCP server (phase 10) design delta

**Status:** approved 2026-08-13
**Amends:** `2026-08-11-mockingham-design.md` §15 (MCP server), §17 (testing),
§1 (instance surface)
**Implements:** master spec phase 10

This is a delta. The master spec is the contract; where this document
contradicts it, this document wins for phase 10 and the reason is stated. Read
master §15 first — it is short, and everything here argues against it.

---

## 1. Scope

Twelve of §15's fourteen tools, both transports.

**In:** all seven read tools — `list_operations`, `describe_operation`,
`search_operations`, `sample_response`, `get_auth_requirements`,
`list_webhooks`, `list_deliveries` — and five write tools: `fail_next`,
`outage`, `emit_webhook`, `set_seed`, `reset`.

**Out, deferred to a plan of its own:** `set_override`, `clear_overrides`,
`regenerate_fixture`.

The dividing line is not arbitrary and not about effort. The twelve in scope
are *exposure*: every one of them is a thin adapter over a `Mock` method that
already exists and is already tested. The three deferred ones require new core
behavior:

- **`set_override` / `clear_overrides`.** Overrides are compiled once at
  construction — `compileConfigs(options.operations, api.operations)` in
  `server/handler.ts` — and there is no runtime mutation path. Master §1's
  instance surface lists an `override(target, value)` method that has never
  existed at any point in the project. Adding it lands a precedence question
  (runtime override vs. config override vs. fixture vs. spec example) in
  `resolve/layer.ts`, which is the layer that has produced more defects than
  any other in plans 4–7.
- **`regenerate_fixture`.** `bake()` walks every operation and every JSON
  response. Re-running one operation is a new entry point with its own
  budget, staleness, and scope semantics.

Bundling those three into an exposure plan would hide a real design decision
inside work that has none. They get their own delta.

**Amendment 1.1.** Master §15 presents all fourteen tools as one deliverable.
Phase 10 ships twelve. `set_override`, `clear_overrides`, and
`regenerate_fixture` move to a later phase alongside the runtime-override
machinery they need. Master §18 already anticipates a split — "read tools
depend only on phases 1–3 … write tools need phases 6 and 8" — this draws the
line one notch differently, at *what exists* rather than at read-vs-write.

---

## 2. Module layout

```
src/mcp/
  context.ts        McpContext + createMcpContext()
  tools/read.ts     the seven read tools
  tools/write.ts    the five write tools
  tools/index.ts    assembles the tool list, applies the write gate
  server.ts         lazy SDK import, tool registration, per-request transport
```

### 2.1 The purity boundary

`context.ts` and `tools/*.ts` import nothing from `node:` and nothing from
`@modelcontextprotocol/sdk`. They are pure, they are the bulk of the code, and
they are where every tool's behavior is decided and tested.

An earlier draft listed an `http.ts` holding a hand-written transport. §3.4
explains why it no longer exists: the SDK supplies a `Request`-in/`Response`-out
transport, and what remains is a few lines inside `server.ts`.

`server.ts` is the only file that touches the SDK, and it imports it lazily
inside the function that starts a server — the same pattern
`fixtures/config.ts` uses for `@anthropic-ai/sdk`. It is Node-adjacent and is
never imported by `server/handler.ts`.

**Invariant 3 is unaffected.** The HTTP mount is composed in `src/index.ts`,
which already imports `server/node.ts` and is already outside the pure core.
`server/handler.ts` gains nothing and imports nothing new.

### 2.2 `McpContext`

Tools receive a narrow context, not a whole `Mock`. Two reasons: a tool that
can reach `mock.close()` is a tool that can be made to close the mock, and a
narrow interface is a testable one.

```ts
export interface McpContext {
  api: Api
  fetch(request: Request): Promise<Response>
  failNext(target: string, opts?: FailNextOptions): Promise<void>
  outage(target: string, opts?: OutageOptions): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(): Delivery[]
  /**
   * Which operations are configured to emit which webhook. Derived at
   * construction from the compiled operation configs — see §3.6.
   */
  emitters: Map<string, string[]>
  /** Origin for the synthetic Requests `sample_response` builds. */
  origin: string
}
```

`origin` defaults to `http://mock.local`. Route matching uses only the
pathname, so the origin never affects which operation is selected; it exists
because `new Request(url)` requires an absolute URL, and it is reported back in
`sample_response`'s `url` field so an agent can substitute its own base.

`createMcpContext(mock, options)` builds one from a `Mock`. Nothing in
`McpContext` exposes `listen`, `close`, `store`, or `bake`.

---

## 3. Amendments

### 3.1 `tags` is never loaded (Amendment 3.1)

Master §15 says `list_operations` is "filterable by tag" and that
`search_operations` matches "over path, summary, description, tags."

`Operation` in `src/spec/types.ts` has no `tags` field, and `src/spec/load.ts`
never reads one. Two of the seven read tools cannot do what the spec says
they do.

**Amendment.** `Operation` gains `tags: string[]`, defaulting to `[]`, loaded
from the operation object's `tags` array. Non-string entries are dropped
rather than coerced, matching how `load.ts` treats every other array it reads.

Document-level `tags` (the array of `{name, description}` objects at the root)
is **not** loaded. Nothing in §15 needs tag descriptions, and YAGNI.

### 3.2 `sample_response` needs concrete path parameters (Amendment 3.2)

Master §15 says `sample_response` returns "a live generated response for an
operation/status." An operation is not a URL: `GET /pets/{petId}` cannot be
fetched until something supplies `petId`.

**Amendment.** The tool's input is:

```ts
{
  operationId?: string          // or method + path
  method?: string
  path?: string                 // the templated path, e.g. /pets/{petId}
  params?: Record<string, string | number>
  query?: Record<string, string | number>
  headers?: Record<string, string>
  body?: unknown
  status?: number
}
```

An operation is addressed by `operationId`, or by `method` + `path` when the
document declares no `operationId`. Supplying neither, or both inconsistently,
is a tool error.

Path parameters not supplied in `params` are **generated**, using the same
`generateValue()` the mock itself uses, seeded on `` `${operationId}|${name}` ``.
Two consequences, both wanted:

- The generated value satisfies the parameter's declared schema, so it
  survives request validation instead of producing a 400 that tells the agent
  nothing.
- The root seed is deliberately **excluded** from that sub-seed. A synthesized
  path parameter is an *address*, not content: `set_seed` should change what
  `GET /pets/42` returns, not turn it into `GET /pets/91`. Response content
  still varies with the seed, because the pipeline seeds body generation
  itself. This also keeps fixture keys stable across reseeds, since
  `fixtureKey` includes params.

`status` is requested by setting `Prefer: status=N` on the synthetic request —
the mechanism master §2 already gives real clients. No new status-selection
path is introduced.

### 3.3 The no-drift guarantee becomes structural (Amendment 3.3)

Master §17 says `sample_response` "is asserted to equal what `mock.fetch()`
returns for the same operation — the two must never drift," framing it as a
test obligation.

**Amendment.** `sample_response` *is* `mock.fetch()`. It builds a `Request`
from its arguments, calls `context.fetch(request)`, and reports the status,
headers, and body it got back. There is no second generation path to drift
from the first.

The §17 test still gets written — it is the test that proves the tool builds
the request it claims to build — but it now guards argument marshalling rather
than guarding against two implementations diverging. That is the difference
between a test that catches a bug and a test that would have caught a whole
bug class we chose not to create. Invariant 1's reasoning, applied to a second
surface.

The tool returns the response as:

```ts
{ status: number, headers: Record<string,string>, body: unknown | string, url: string }
```

`body` is the parsed JSON when the response is JSON, the raw text otherwise.
`url` is the concrete URL that was fetched, so an agent can see which path
parameters were synthesized and reproduce the call with `curl`.

### 3.4 The HTTP transport is the SDK's, stateless and per request (Amendment 3.4)

An earlier draft of this section had us implementing the SDK's `Transport`
interface by hand, on the reasoning that `StreamableHTTPServerTransport`
operates on `node:http` objects while our surface is
`fetch(Request): Promise<Response>`. That reasoning was correct about
`StreamableHTTPServerTransport` and wrong about the SDK. Since 1.x the SDK also
ships **`WebStandardStreamableHTTPServerTransport`**
(`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`), whose entire
public entry point is:

```ts
handleRequest(req: Request, options?: HandleRequestOptions): Promise<Response>
```

That is exactly our surface. Writing our own transport would have been forty
lines of owned code duplicating a supported one, and would have skipped
protocol-version validation, session termination, and SSE — the parts hardest
to get right and least interesting to own.

**Amendment.** Use the SDK transport, in **stateless mode with a fresh
`McpServer` and transport per HTTP request**:

```ts
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,   // stateless
  enableJsonResponse: true         // JSON, not SSE
})
await buildMcpServer(context, { write }).connect(transport)
return transport.handleRequest(request)
```

Per-request construction is not a workaround; the SDK requires it. In stateless
mode `handleRequest` throws on a second call — *"Stateless transport cannot be
reused across requests"* — because reuse causes message-id collisions between
clients. The alternative is stateful mode with a `sessionIdGenerator`, which
buys shared state we have no use for and costs every client an
`Mcp-Session-Id` round trip.

Stateless is the better fit here for a reason beyond the SDK's constraint:
**our tools hold no state.** Every one of them reads or writes the `Mock`,
which lives independently of any MCP session. There is nothing for a session
to remember.

Two behaviors were verified empirically against SDK 1.30.0 rather than assumed:

- A fresh stateless transport answers `tools/list` and `tools/call`
  **without a prior `initialize`**, returning `200` and
  `content-type: application/json`. An agent can therefore call a tool with one
  `curl` and no handshake, which for this audience is the whole point.
- A handled request leaves **no dangling timers** — the keep-alive interval is
  armed for SSE streams only, and `enableJsonResponse` takes a different path.
  This matters more than it looks: a per-request timer would hang `node --test`
  at the end of every run.

Registering twelve tools per request is microseconds and buys an entire class
of shared-state bug never existing.

SSE is not served: `enableJsonResponse: true` makes every response plain JSON.
Every tool here is request/response and the server initiates nothing, so there
is no server-push to carry. `GET` and `DELETE` are passed to the transport,
which answers them per the MCP specification.

### 3.5 `mcp()` must work before or after `listen()` (Amendment 3.5)

Master §1 makes `mcp(opts)` an instance method and §15 shows
`mock.mcp({ transport: 'http', path: '/mcp' })`. If the mount were composed at
construction, a call after `listen()` would silently do nothing.

**Amendment.** `createMock` wraps `handler.fetch` in a dispatcher that reads a
mutable mount slot on every request:

```ts
const fetchWithMcp = async (request: Request): Promise<Response> => {
  const mount = mcpMount            // read per request, not captured
  if (mount && new URL(request.url).pathname === mount.path) {
    return mount.handle(request)
  }
  return handler.fetch(request)
}
```

`mock.mcp(opts)` returns a handle:

```ts
interface McpOptions {
  /** Default: 'inline' — a server with no transport attached. */
  transport?: 'http' | 'stdio' | 'inline'
  /** http only. Default: '/mcp'. */
  path?: string
  /** Expose the five write tools. Default: false — see §3.7. */
  write?: boolean
}

interface McpServer {
  /** The mounted path. Present only for transport 'http'. */
  path?: string
  /**
   * Serves this server over stdio. Node-only; rejects elsewhere. Available
   * on any handle, so a caller can build one inline and attach stdio later.
   */
  connectStdio(): Promise<void>
  /** Unmounts an http server and closes any attached transport. */
  close(): Promise<void>
}
```

Only `transport: 'http'` writes the mount slot. `'stdio'` mounts nothing and
connects stdio immediately; `'inline'` mounts nothing and connects nothing,
which is the form every tool unit test uses and the form `mcp/server.ts`
builds internally for the other two.

Order stops mattering, `mock.fetch()` serves `/mcp` in-process, and the
transport is testable without binding a port.

`Mock` gains `mcp(opts?: McpOptions): McpServer`, which master §1 already
declares. Unlike `bake()`, it is synchronous — the lazy SDK import happens
inside it and is awaited by `connectStdio()` and by the first HTTP request, so
constructing a handle never blocks.

### 3.6 `list_webhooks` can only half-derive its emitters (Amendment 3.6)

Master §15 says `list_webhooks` returns declared webhooks and callbacks "with
payload schemas and which operations emit them."

Half of that is derivable and half is not. A **callback** is declared inside an
operation, so `api.operations[].callbacks` gives the mapping directly. A
top-level **webhook** (`Api.webhooks`) carries no declared emitter at all — in
OpenAPI 3.1 it is a standalone outbound description. What actually links it to
an operation is mockingham's own `operations['POST /orders'].emits` config,
which `createHandler` compiles and does not expose.

**Amendment.** `createMock` computes an emitter map at construction by running
each operation against the compiled configs and collecting
`config.emits[].webhook`, and passes it to the context as
`McpContext.emitters`. `list_webhooks` reports, per entry:

```ts
{
  name: string
  kind: 'webhook' | 'callback'
  method: string
  payloadSchema?: unknown        // JSON Schema, for the JSON media type
  emittedBy: string[]            // "POST /orders" strings, [] when nothing emits it
  expression?: string            // callbacks only: the OpenAPI runtime expression
}
```

`emittedBy: []` is an honest and useful answer — it means the document declares
the webhook but nothing is configured to fire it, which is exactly the
misconfiguration an agent testing its receiver needs to know about.

### 3.7 Write tools are opt-in on both transports (Amendment 3.7)

Master §15 presents the write tools as unconditionally available.

Over HTTP they are mounted on the same port as the mock, so anything that can
reach the mock can also drive its failure modes, reseed it, or reset it — in a
shared development environment, that includes people who did not know the
control plane was there. Over stdio the risk argument is weaker, but a uniform
rule is one rule to remember instead of two, and the flag is one word.

**Amendment.** Write tools require an explicit opt-in:

```ts
mock.mcp({ transport: 'http', path: '/mcp', write: true })
```

```sh
mockingham mcp ./openapi.json --write
```

`write` defaults to `false`. With it off, the five write tools are absent from
`tools/list` **and** `tools/call` on one of them returns a tool error naming
the flag that would enable it. Both halves matter: a gate that only hides the
tools from the listing is not a gate.

### 3.8 A document operation may collide with the mount path (Amendment 3.8)

Nothing prevents an OpenAPI document from declaring `/mcp`.

**Amendment.** The mount wins — the dispatcher checks it before
`handler.fetch`. When `mcp()` mounts a path that an operation in the document
also matches, a warning naming both goes to `onWarn` at mount time. Silent
shadowing is the failure mode that costs an afternoon of debugging a 404 that
is not a 404.

### 3.9 `deliveries()` takes no filter (Amendment 3.9)

Master §1 shows `deliveries(filter?: DeliveryFilter)`; the implemented
`Mock.deliveries()` takes no argument, and `DeliveryFilter` has never been
defined.

**Amendment.** `list_deliveries` filters in the tool layer over the array
`deliveries()` returns — by `webhook` name and by `outcome`, both optional.
The core surface is not widened. Defining `DeliveryFilter` on `Mock` is a
change to a shipped API for one caller's benefit, and the filtering is four
lines wherever it lives.

### 3.10 Neither optional peer dependency is declared (Amendment 3.10)

`package.json` has no `peerDependencies` block. `@anthropic-ai/sdk` — which
plan 7 shipped as an optional peer dependency per master §14 — is declared
nowhere, and `@modelcontextprotocol/sdk` would have joined it.

**Amendment.** Add both:

```json
"peerDependencies": {
  "@anthropic-ai/sdk": ">=0.30.0",
  "@modelcontextprotocol/sdk": ">=1.30.0"
},
"peerDependenciesMeta": {
  "@anthropic-ai/sdk": { "optional": true },
  "@modelcontextprotocol/sdk": { "optional": true }
}
```

This closes a plan 7 gap as well as plan 8's. `zod` remains the only entry in
`dependencies`.

The `>=1.30.0` floor is not conservatism: `WebStandardStreamableHTTPServerTransport`
is what §3.4 mounts, and 1.30.0 is the version its behavior was verified
against. `@modelcontextprotocol/sdk` appears in `devDependencies` as well, for
the reason §4 gives.

---

## 4. The dev-dependency decision

Master §17 requires "one stdio round-trip smoke test." That needs the real
`@modelcontextprotocol/sdk` present when the suite runs, which makes it the
first package this test suite depends on to execute.

**Decision: take the dev dependency.** It is installed at `1.30.0`, which is
the version every empirical claim in §3.4 was verified against.

Since §3.4 stopped owning a transport, this is no longer really a choice.
The mount *calls* the SDK, so without it installed there is no HTTP transport
to test at all — not a weaker test, none. The only remaining question is the
stdio round trip, and the same answer applies: plan 7 could stub the Anthropic
source because what was under test was our prompt construction and our response
parsing, both of which a stub exercises fully. Here what is under test is
whether a real MCP client can talk to us, and a stub client cannot answer that.

`zod` remains the only runtime dependency; a `devDependency` does not weaken
that. The cost is that `npm test` now requires an install, which it already
did for `zod`.

---

## 5. The tools

### 5.1 Read

| Tool | Input | Returns |
|---|---|---|
| `list_operations` | `tag?`, `pathPrefix?` | `{method, path, operationId?, summary?, tags}[]` |
| `describe_operation` | `operationId?` \| `method`+`path` | params, request body schema, every declared response schema, security requirements, declared examples |
| `search_operations` | `query`, `limit?` | matches over path, summary, description, tags, ranked |
| `sample_response` | see §3.2 | see §3.3 |
| `get_auth_requirements` | `operationId?` | security schemes; per-operation requirements when an operation is named, the whole document's otherwise |
| `list_webhooks` | — | see §3.6 |
| `list_deliveries` | `webhook?`, `outcome?` | see §3.9 |

Schemas are emitted as JSON Schema through the same conversion
`fixtures/source.ts` uses (`buildRequest`'s JSON Schema path), not as raw
resolved `Schema` objects — those contain cycles and would not serialize.
Reusing that converter rather than writing a second one is invariant 1's
reasoning applied here: two schema-to-JSON-Schema paths would diverge.

A recursive schema that the converter refuses is reported as
`{ "$comment": "recursive; not expressible as JSON Schema" }` rather than
omitted, so an agent is told the shape exists and why it is not shown.

### 5.2 Write

| Tool | Input | Effect |
|---|---|---|
| `fail_next` | `target`, `times?`, `status?` | `mock.failNext` |
| `outage` | `target`, `forMs?`, `status?` | `mock.outage` |
| `emit_webhook` | `webhook`, `to?`, `body?` | `mock.emit`; returns the `Delivery` |
| `set_seed` | `seed` | `mock.setSeed` |
| `reset` | — | `mock.reset` |

`target` strings are the existing control-plane targets from master §4 —
`"POST /orders"`, `"*"`, an `operationId`. `resolveTarget` already throws on a
typo, and that throw becomes a tool error rather than a crash: an agent typing
a target wrong must be told, not disconnected.

`emit_webhook` returns the `Delivery` including `outcome: 'unresolved'` when
nothing resolved a destination. Per invariant 6 that is not an error, and the
tool must not turn it into one — an agent that gets a tool error for an
unresolved emit will conclude its receiver is broken when the mock simply had
no URL to send to.

---

## 6. CLI

```sh
mockingham mcp ./openapi.json [--seed <s>] [--fixtures <dir>] [--write]
```

Adds a third subcommand alongside `bake` and the default serve, following the
same shape: a `MCP_USAGE` string, a `parseMcpArgs`, and a `startMcp(argv, deps)`
that returns a handle for testing.

`startMcp` builds a `Mock` via `createMock`, not a bare `Handler` the way
`startCli` does — the write tools need `failNext`, `outage`, and `emit`, which
are `Mock`-level. It then calls `mcp({ write }).connectStdio()`.

Nothing is logged to stdout: stdout is the JSON-RPC channel over stdio, and a
stray log line corrupts the stream. All CLI logging for this subcommand goes to
stderr. This is the one place where the project's `log` convention has to bend,
and it bends for a protocol requirement rather than a preference.

---

## 7. Testing

Per master §17, plus what plan 7 taught.

- **Per-tool unit tests** calling handlers directly against a real
  `createMock`-backed `McpContext`. No SDK involved. This is the bulk.
- **`sample_response` equals `mock.fetch()`** for the same operation, asserted
  byte-for-byte on the body — §17's requirement, now guarding argument
  marshalling (§3.3).
- **The mount driven through `mock.fetch()`** with real JSON-RPC frames:
  `tools/list` and `tools/call` as separate `Request`s against the same mount,
  each asserted to succeed **without a preceding `initialize`** — that is the
  stateless property §3.4 depends on, and the one that would break silently if
  someone later switched the transport to stateful mode. Plus one `initialize`
  frame asserted to return a protocol version, since a client that does
  handshake must still work. **This test gets built early, not last** — see
  below.
- **No dangling handles.** The suite itself is the assertion: if a per-request
  transport ever armed a timer, `node --test` would stop exiting. Worth naming
  so that a future switch to SSE or stateful mode is understood to put this at
  risk.
- **One stdio round trip** through the CLI subcommand with a real MCP client
  from the SDK.
- **Write gate**, both halves: `tools/list` omits the five write tools when
  `write` is false, *and* `tools/call` on `fail_next` returns a tool error.
- **Path shadowing** (§3.8): a document declaring `/mcp`, mounted at `/mcp`,
  warns and serves MCP.
- **Determinism**: the same `sample_response` call twice returns identical
  bytes, and synthesized path parameters are unchanged by `set_seed` while the
  response body changes.

**The end-to-end test is scheduled early.** Plan 7's two worst defects — bake
keying fixtures with empty path params while requests keyed with resolved ones,
and a staleness check comparing against a hash bake never wrote — were both
seams where each side was individually correct and disagreed with the other.
Nine tasks of per-task unit review saw neither. Both surfaced the moment an
implementer built a test through the public surface. Phase 10 has exactly that
shape: a pure tool layer and an SDK adapter that are each easy to review alone.
The `mock.fetch('/mcp')` round trip is the test that crosses that seam, and it
lands as soon as one read tool and the transport exist.

---

## 8. Limitations, stated up front

- **No SSE, no streaming, no server-initiated notifications.** Every tool is
  request/response. A future tool that wants to push (a delivery stream, say)
  needs the transport extended.
- **No MCP sessions over HTTP.** The transport runs stateless (§3.4), so
  `Mcp-Session-Id` is neither issued nor honored and nothing carries between
  requests at the protocol layer. The *mock's* runtime state is still shared —
  two agents pointed at one mock both see the effect of a `set_seed` — which is
  the point of a shared mock, but is worth stating because "stateless" describes
  the transport, not the thing it controls.
- **Resumability and `Last-Event-ID` are unavailable.** They require an
  `EventStore` and SSE, and §3.4 serves JSON.
- **`sample_response` cannot express every request.** No multipart bodies, no
  binary bodies, no cookie parameters. JSON, form-encoded, and text bodies
  only, matching what master §2's body parsing supports.
- **The synthesized path parameter may not exist.** `GET /pets/42` returns a
  generated pet whether or not anything "created" 42 — the mock has no
  identity model. This is inherent to the mock, not to the tool, but an agent
  reading a sample response should not infer that the resource is persistent.
- **`describe_operation` shows declared examples, not fixtures.** A fixture
  baked for an operation is what `sample_response` will return, but it is not
  listed among the examples. Surfacing the fixture store through MCP is
  `regenerate_fixture`'s territory, deferred with it.
- **A missing `@modelcontextprotocol/sdk` is reported late.** Master §1 types
  `mcp()` as returning an `McpServer` synchronously, so the lazy import cannot
  be awaited inside it. A missing package therefore surfaces at
  `connectStdio()` or at the first request to the mount, not at `mcp()`. The
  error message names the package and the install command; making `mcp()`
  async to report it earlier would change a published signature for a
  once-per-setup mistake.
- **Tag filtering is exact-match, case-sensitive.** OpenAPI tags are free-form
  strings with no normalization rule; inventing one here would differ from
  whatever the document's other tooling does.

---

## 9. What this leaves for the next phase

`set_override`, `clear_overrides`, and `regenerate_fixture`, plus the runtime
override machinery beneath the first two and the scoped re-bake beneath the
third. Master §1's `Mock.override(target, value)` is part of that work: it is
in the published instance surface and has never existed.

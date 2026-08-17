# mockingham Plan 5 - Single Exit, Idempotency, Logging, CLI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the request pipeline a single exit point, then build the two
things that need one - idempotency (phase 7) and logging (phase 9) - and ship the
CLI that makes the mock runnable without writing a script.

**Architecture:** `handler.ts`'s `run()` is split into a producer (`produce`,
which may answer from any of four places) and a single exit inside `handle()`,
through which every response passes - a 404, a body-parse 400, an auth 401, a
chaos 503, a rendered 200, and the boundary 500 alike. Stage 11 lives at that
exit: it captures the response body once as a string, stores it as an idempotency
record when a first request claimed the key, and emits the log record. Each
pipeline stage moves out of `handler.ts` into a named factory colocated with the
module that owns it, so `handler.ts` only orders them.

**Tech Stack:** TypeScript (erasable syntax only, run directly by Node ≥ 24), ESM,
`node:test`, `zod` as the only hard runtime dependency.

## Source documents

- `docs/superpowers/specs/2026-08-11-mockingham-design.md` - the master contract.
  §10 Store, §11 Idempotency, §12 Logging, §16 config surface, §17 testing,
  §18 phases 7 and 9.
- `docs/superpowers/specs/2026-08-12-mockingham-phases-7-9-design.md` - the delta
  design for this plan. **Where the two disagree, the delta wins.** Its §1 (the
  prerequisite refactor) and §2.1–2.5 (five amendments) are the contract for
  Tasks 1–8.
- `docs/superpowers/deferred-items.md` - items 1, 2, 3, 4, 5, and 9 are settled by
  this plan. Items 6, 8, 10–14 stay deferred.

## Global Constraints

Every task's requirements implicitly include these. Breaking one is a defect even
if the task's own tests pass.

- **Node ≥ 24, ESM, `"type": "module"`.** Types are stripped natively - no build
  step, no transpiler.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
  Use `const X = {...} as const`.
- **One schema interpretation.** `schema/walk.ts` is shared by value generation
  and zod compilation. Never add a second traversal.
- **Determinism.** The same request must produce byte-identical output across
  processes. No `Math.random()`, no `Date.now()`, no iteration over an unordered
  `Set`/object in a generation path. Randomness comes from `generate/rng.ts`; time
  comes from an injected clock. **Log records are exempt** - see delta §2.1 - but
  only because a log record never enters a response.
- **The core is pure.** `server/handler.ts` and everything it imports must not
  touch Node APIs. Node-only code lives in `server/node.ts` and `server/cli.ts`.
  `TextEncoder`/`TextDecoder`/`URL`/`Request`/`Response` are web globals and are
  fine.
- **A fixture or LLM miss is never an error.** It falls through to seeded
  generation.
- **Errors stay on-contract.** Emit the operation's declared error schema when one
  exists (`buildError` already does this); only fall back to the built-in envelope
  when it does not. Both idempotency 409s go through `buildError`.
- **`zod` is the only hard runtime dependency.** `@anthropic-ai/sdk` and
  `@modelcontextprotocol/sdk` stay optional and lazily imported. This plan adds no
  dependency at all.
- **US English spelling** everywhere - identifiers, test names, comments, docs.
  `honor`, `behavior`, `serialize`, `normalize`, `canceled`.
- **Tests live in `test/` mirroring `src/`**, written in TypeScript, run by
  `node:test`. Write the test first, watch it fail, then implement.
- **Shell: one plain command per Bash call, with literal arguments.** No `&&`, no
  pipes, no `$(...)`, no redirects, no heredocs, no `cd`. Multi-paragraph commits
  use repeated `-m` flags. `git push`, `npm publish`, `rm -rf`, and `sudo` are
  denied by policy.

## Verification commands

```sh
npm test                          # whole suite
node --test test/runtime/         # one directory
node --test test/server/cli.test.ts
npx tsc --noEmit                  # typecheck
```

`npm test` must stay green at the end of every task, and `npx tsc --noEmit` must
report nothing. The suite stands at **408 tests** at the start of this plan.

## Rulings made before writing this plan

Three questions the design documents left open were settled with the user. They
are binding for the tasks below and are folded back into the design spec in
Task 11.

1. **A 5xx is never stored as an idempotency record.** §11 does not say. Storing a
   chaos-injected 503 would make every retry replay that 503 until the TTL
   expired, which defeats the retry the idempotency key exists to make safe. Stage
   11 stores a response only when `status < 500`; on a 5xx or a throw it *deletes*
   the in-flight marker so the retry re-runs the operation. Task 7.
2. **`reset()` clears the store on both surfaces.** `Handler.reset()` gains
   `await store.clear()` and becomes `Promise<void>`, matching `Mock.reset()`. The
   documented contract is "reset() clears the store it was given" - do not share
   one store with your application. Task 2.
3. **Deferred items 4 and 5 (circuit decay, per-policy circuit keys) join this
   plan.** Item 6 (`Mock.override()`) stays deferred to plan 6. Task 9.

## A contradiction in §11, found while writing this plan

§11 gives `scope: ['key', 'route', 'bodyHash']` as the default **and** specifies
`409 MOCK_IDEMPOTENCY_MISMATCH` for "same key, different body fingerprint". Those
two sentences cannot both hold. If `bodyHash` is part of the storage key, a
different body computes a *different* key, the lookup misses, the request is
treated as a first request - and the mismatch branch is unreachable dead code
under the very default that is supposed to exercise it.

**The resolution: `bodyHash` in `scope` means "compare the fingerprint", not
"put the fingerprint in the key".** The storage key is composed from the `key` and
`route` parts only; the fingerprint is stored alongside the record and compared on
lookup. Every §11 sentence is then live at once:

| `scope` | Storage key | Different body → |
|---|---|---|
| `['key','route','bodyHash']` (default) | key + route | **409 mismatch** |
| `['key','route']` | key + route | replays regardless of body |
| `['key']` | key | replays across routes too |

This is the same class of defect the phases 4–6 and 7–9 design documents each
caught: the master spec is detailed but internally inconsistent in specific
places. It is recorded as amendment §2.7 in Task 11.

## The test-quality bar

Four tests reached plans 2 and 3 that **could not fail**. Every one was caught by
review, never by the plan author. Before accepting any test in this plan that
claims to prove a mechanism, **observe it fail by mutation**: revert the
implementation line, run the test, report the exact failure message. Two traps are
live in this plan specifically:

- **The replay test.** Generation is deterministic, so a second real request
  already returns byte-identical output. A replay test that only compares two
  bodies passes with idempotency entirely removed. Task 6 defeats this by making
  the operation's response *change* per execution (a `ctx.seq()` counter in a
  `respond` callback) and asserting both that the bodies match **and** that the
  callback ran exactly once.
- **The single-exit test.** "A log record was emitted" is only meaningful for a
  response that never reached the renderer. Task 8's load-bearing test asserts a
  record for a **401 short-circuit**, not for a 200.

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/runtime/idempotency.ts` | Config resolution, enablement, fingerprint, record key, the entry type, and stage 5's factory. Everything idempotency knows lives here; the handler only wires it. |
| `src/runtime/logging.ts` | `requestIdFor`, the `LogRecord` shape, and `emitLog`'s error isolation. No Node APIs. |
| `src/server/cli.ts` | Argument parsing, file reading, `--watch`, process wiring. The only module besides `node.ts` allowed to touch Node APIs, and the only one allowed to read `process.argv`. |
| `test/helpers/ctx.ts` | Builds a `Ctx` for unit-testing a stage in isolation. Not a `.test.ts` file, so the runner ignores it. |
| `test/runtime/stages.test.ts` | Unit tests for the extracted stage factories. |
| `test/runtime/idempotency.test.ts` | Unit tests for the idempotency module. |
| `test/runtime/logging.test.ts` | Unit tests for `requestIdFor` and `emitLog`. |
| `test/server/idempotency.test.ts` | End-to-end idempotency through `handler.fetch`. |
| `test/server/logging.test.ts` | End-to-end logging through `handler.fetch`. |
| `test/server/cli.test.ts` | CLI argument parsing plus one real port round-trip. |

**Modified files**

| File | Change |
|---|---|
| `src/server/handler.ts` | Split into `produce` + a single exit in `handle`. Stage list becomes named factories. New options: `now`, `idempotency`, `onLog`, `onError`. `reset()` becomes async. |
| `src/runtime/types.ts` | `Fail`, `Decisions`; `Ctx` gains `requestId` and `decisions`. |
| `src/runtime/context.ts` | `createContext` takes and sets `requestId`; initializes `decisions`. |
| `src/runtime/auth.ts` | `createAuthStage`. |
| `src/runtime/validate.ts` | `createValidationStage`. |
| `src/runtime/failure.ts` | `createFailureStage`; circuit window and per-policy circuit keys. |
| `src/generate/rng.ts` | `fnv1aBytes`. |
| `src/index.ts` | `Mock.reset()` delegates wholly to `Handler.reset()`. |
| `package.json` | `bin` entry for the CLI. |
| `docs/superpowers/specs/2026-08-12-mockingham-phases-7-9-design.md` | Amendments from the rulings; status to approved. |
| `docs/superpowers/deferred-items.md` | Rulings recorded, settled items marked done. |

---

## Task 1: Single exit and named stage factories

Deferred items 1, 2, and 9. This is a **refactor with no behavior change** - the
408 existing tests are the safety net and every one of them must still pass
unchanged. Nothing in this task adds a feature; it builds the seam the rest of the
plan hangs on.

**Why a producer plus an exit, rather than literally one `return`.** The deferred
item asks for "one exit point". What phase 9 actually needs is one *observation*
point: somewhere every response passes on its way out, including the ones built
before `ctx` exists. Collapsing `produce`'s branches into a single `return`
statement through nested conditionals would buy nothing and cost readability. So
`produce` keeps its branches, `handle` becomes the sole exit, and a mutable
`Trace` carries what the early-exit paths know down to it. Delta design §2.3's
amendment says exactly this: "the loop must produce a single exit point through
which every response passes."

**Files:**
- Modify: `src/runtime/types.ts` (add `Fail`)
- Modify: `src/runtime/auth.ts` (add `createAuthStage`)
- Modify: `src/runtime/validate.ts` (add `createValidationStage`)
- Modify: `src/runtime/failure.ts` (add `createFailureStage`)
- Modify: `src/server/handler.ts:111-333` (the restructure)
- Create: `test/helpers/ctx.ts`
- Create: `test/runtime/stages.test.ts`

**Interfaces:**
- Consumes: `checkAuth` / `AuthInput` (`src/runtime/auth.ts`), `validateRequest`
  (`src/runtime/validate.ts`), `checkFailure` / `FailureInput`
  (`src/runtime/failure.ts`), `Stage` and `Ctx` (`src/runtime/types.ts`),
  `createContext` / `createCounters` (`src/runtime/context.ts`).
- Produces:
  - `type Fail = (status: number, code: string, message: string, ctx?: Ctx, errors?: Array<{ path: string; message: string }>) => Promise<Response>`
  - `createAuthStage(input: AuthStageInput): Stage` - returns a function named `authStage`
  - `createValidationStage(input: ValidationStageInput): Stage` - returns `validationStage`
  - `createFailureStage(input: FailureStageInput): Stage` - returns `failureStage`
  - `buildCtx(...)` test helper in `test/helpers/ctx.ts`
  - Inside `handler.ts` (not exported): `interface Trace`, `produce(request, trace)`,
    and the exit block in `handle`.

- [ ] **Step 1: Write the test helper**

Create `test/helpers/ctx.ts`. Stages take only a `Ctx`, so a stage can now be
tested without a server - that is the point of the refactor and this helper is
what makes it cheap.

```ts
import { createContext, createCounters } from '../../src/runtime/context.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Operation } from '../../src/spec/types.ts'
import type { Ctx, Fail } from '../../src/runtime/types.ts'

export interface BuildCtxInput {
  request: Request
  operation: Operation
  params?: Record<string, string>
  body?: unknown
  mediaType?: string
  requestKey?: string
}

/** A Ctx with no server behind it, for unit-testing one stage in isolation. */
export function buildCtx(input: BuildCtxInput): Ctx {
  return createContext({
    request: input.request,
    url: new URL(input.request.url),
    operation: input.operation,
    params: input.params ?? {},
    body: input.body,
    mediaType: input.mediaType,
    rng: createRng('test'),
    requestKey: input.requestKey ?? 'test-key',
    counters: createCounters(),
    generate: () => undefined,
    example: () => undefined
  })
}

/**
 * A `Fail` that records what it was asked for. The real one generates an
 * on-contract body; a stage's own test only cares which error it chose.
 */
export function recordingFail(): { fail: Fail; calls: Array<{ status: number; code: string }> } {
  const calls: Array<{ status: number; code: string }> = []
  const fail: Fail = async (status, code, message) => {
    calls.push({ status, code })
    return Response.json({ error: { code, message } }, { status })
  }
  return { fail, calls }
}
```

- [ ] **Step 2: Write the failing stage-factory tests**

Create `test/runtime/stages.test.ts`.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createAuthStage } from '../../src/runtime/auth.ts'
import { createValidationStage } from '../../src/runtime/validate.ts'
import { createFailureStage } from '../../src/runtime/failure.ts'
import { compilePolicies } from '../../src/runtime/failure.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { buildCtx, recordingFail } from '../helpers/ctx.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }
        ],
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
})

const operation = api.operations[0]!

test('every stage factory returns a named function', () => {
  // The stated benefit of a factory over an anonymous closure: a stack trace
  // names the stage that responded. An anonymous arrow reports "".
  const { fail } = recordingFail()
  assert.equal(
    createAuthStage({ security: operation.security, schemes: api.securitySchemes, config: {}, fail }).name,
    'authStage'
  )
  assert.equal(createValidationStage({ operation, fail }).name, 'validationStage')
  assert.equal(
    createFailureStage({
      operation, policies: [], store: createMemoryStore(), chaosSeed: 's',
      requestKey: 'k', counter: () => 1, sleep: async () => {}, fail
    }).name,
    'failureStage'
  )
})

test('authStage denies a request with no credential', async () => {
  const { fail, calls } = recordingFail()
  const stage = createAuthStage({
    security: operation.security, schemes: api.securitySchemes, config: {}, fail
  })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  const response = await stage(ctx)

  assert.equal(response?.status, 401)
  assert.deepEqual(calls, [{ status: 401, code: 'MOCK_UNAUTHORIZED' }])
})

test('authStage continues and sets ctx.auth when credentialed', async () => {
  const { fail } = recordingFail()
  const stage = createAuthStage({
    security: operation.security, schemes: api.securitySchemes, config: {}, fail
  })
  const ctx = buildCtx({
    request: new Request('http://mock/pets/1', { headers: { authorization: 'Bearer t' } }),
    operation,
    params: { id: '1' }
  })

  assert.equal(await stage(ctx), undefined)
  assert.ok(ctx.auth)
})

test('validationStage reports the failing path', async () => {
  const { fail, calls } = recordingFail()
  const stage = createValidationStage({ operation, fail })
  const ctx = buildCtx({ request: new Request('http://mock/pets/abc'), operation, params: { id: 'abc' } })

  const response = await stage(ctx)

  assert.equal(response?.status, 400)
  assert.deepEqual(calls, [{ status: 400, code: 'MOCK_REQUEST_INVALID' }])
})

test('validationStage continues on a valid request', async () => {
  const { fail } = recordingFail()
  const stage = createValidationStage({ operation, fail })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  assert.equal(await stage(ctx), undefined)
})

test('failureStage answers when decide() returns a directive', async () => {
  const { fail, calls } = recordingFail()
  const stage = createFailureStage({
    operation,
    policies: compilePolicies([], api.operations),
    decide: () => ({ status: 502, code: 'MOCK_DOWN' }),
    store: createMemoryStore(),
    chaosSeed: 'chaos',
    requestKey: 'k',
    counter: () => 1,
    sleep: async () => {},
    fail
  })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  const response = await stage(ctx)

  assert.equal(response?.status, 502)
  assert.deepEqual(calls, [{ status: 502, code: 'MOCK_DOWN' }])
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/runtime/stages.test.ts`

Expected: FAIL - `createAuthStage is not a function` (and the same for the other
two factories).

- [ ] **Step 4: Add the `Fail` type**

In `src/runtime/types.ts`, after the `Stage` type:

```ts
/**
 * Builds an on-contract error response. Bound by the handler to one operation
 * and one request key, so a stage supplies only what it actually decided.
 * Keeping the binding out here is what lets a stage factory live beside the
 * module it belongs to instead of inside `handler.ts`.
 */
export type Fail = (
  status: number,
  code: string,
  message: string,
  ctx?: Ctx,
  errors?: Array<{ path: string; message: string }>
) => Promise<Response>
```

- [ ] **Step 5: Add `createAuthStage`**

At the end of `src/runtime/auth.ts`:

```ts
export interface AuthStageInput {
  security: SecurityRequirement[] | undefined
  schemes: Record<string, SecurityScheme>
  config: AuthConfig
  fail: Fail
}

/** Pipeline stage 3. */
export function createAuthStage(input: AuthStageInput): Stage {
  return async function authStage(ctx) {
    const outcome = await checkAuth({
      security: input.security,
      schemes: input.schemes,
      config: input.config,
      ctx
    })
    if (outcome.ok) {
      ctx.auth = outcome.principal
      return undefined
    }
    // A scheme may hand back a fully formed response (a WWW-Authenticate
    // challenge, say); that wins over the generic on-contract error.
    if (outcome.response) return outcome.response
    return await input.fail(outcome.status, outcome.code, outcome.message, ctx)
  }
}
```

Add `Fail` and `Stage` to the existing type import from `./types.ts`.

- [ ] **Step 6: Add `createValidationStage`**

At the end of `src/runtime/validate.ts`:

```ts
export interface ValidationStageInput {
  operation: Operation
  fail: Fail
}

/** Pipeline stage 4. */
export function createValidationStage(input: ValidationStageInput): Stage {
  return async function validationStage(ctx) {
    const result = validateRequest(ctx, input.operation)
    if (result.ok) return undefined
    return await input.fail(
      400,
      'MOCK_REQUEST_INVALID',
      'Request does not match the declared schema',
      ctx,
      result.errors
    )
  }
}
```

- [ ] **Step 7: Add `createFailureStage`**

At the end of `src/runtime/failure.ts`:

```ts
export interface FailureStageInput {
  operation: Operation
  policies: Array<{ matches(operation: Operation): boolean; policy: FailurePolicy }>
  decide?: (ctx: Ctx) => Directive | undefined
  store: Store
  chaosSeed: string
  requestKey: string
  counter: () => number
  sleep: (ms: number) => Promise<void>
  fail: Fail
}

/** Pipeline stage 6. */
export function createFailureStage(input: FailureStageInput): Stage {
  return async function failureStage(ctx) {
    const outcome = await checkFailure({
      operation: input.operation,
      ctx,
      policies: input.policies,
      decide: input.decide,
      store: input.store,
      chaosSeed: input.chaosSeed,
      requestKey: input.requestKey,
      counter: input.counter,
      sleep: input.sleep
    })
    if (outcome.ok) return undefined
    return await input.fail(outcome.status, outcome.code, outcome.message, ctx)
  }
}
```

- [ ] **Step 8: Run the stage tests to verify they pass**

Run: `node --test test/runtime/stages.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 9: Restructure `handler.ts`**

Replace the body of `createHandler` from the `fail` helper through the end of
`handle` (`src/server/handler.ts:84-319`). Keep everything above it as is.

```ts
  /**
   * The error builder, bound to one operation and one request key. Binding here
   * rather than passing five arguments at each call site is what lets each stage
   * live in its own module. The rng seed string is unchanged from plan 4, so
   * generated error bodies stay byte-identical.
   */
  const failWith = (operation: Operation | undefined, key: string): Fail =>
    (status, code, message, ctx, errors) =>
      buildError({
        operation,
        status,
        code,
        message,
        errors,
        mode,
        ctx,
        rng: createRng(`${key}|error|${status}`),
        generateOptions: {
          maxDepth: options.maxDepth,
          preferExamples: options.preferExamples,
          resolvers,
          schemaNames: api.schemaNames
        },
        debugHeaders: options.debugHeaders
      })

  /**
   * What the single exit needs to know about a request, filled in by `produce`
   * as it learns it. A mutable record rather than a return value because the
   * boundary catch has to observe a request that threw before producing
   * anything - and that is precisely the request an operator most wants logged.
   */
  interface Trace {
    operation?: Operation
    params: Record<string, string>
    requestKey: string
    bytesIn: number
    ctx?: Ctx
    error?: unknown
  }

  async function produce(request: Request, trace: Trace): Promise<Response> {
    // Stage 1 - route match.
    const url = new URL(request.url)
    const matched = router.match(request.method, url.pathname)

    if (!matched) {
      // The body is never read on this path, so `content-length` is the only
      // honest byte count available.
      trace.bytesIn = Number(request.headers.get('content-length') ?? 0) || 0
      const fail = failWith(undefined, seed)
      const allowed = router.allowedMethods(url.pathname)
      if (allowed.length > 0) {
        const response = await fail(
          405,
          'MOCK_METHOD_NOT_ALLOWED',
          `Allowed methods: ${allowed.join(', ')}`
        )
        response.headers.set('allow', allowed.join(', '))
        return response
      }
      return await fail(404, 'MOCK_NOT_FOUND', `No operation for ${url.pathname}`)
    }

    const { operation, params } = matched
    const config = resolveConfigs(operation, compiled)
    // Computed once - it was built twice per request before this refactor.
    const key = requestKey(operation, params, seed)
    const fail = failWith(operation, key)

    trace.operation = operation
    trace.params = params
    trace.requestKey = key

    // Stage 2 - body parse and content negotiation.
    const parsed = await parseBody(request, operation)
    if (!parsed.ok) {
      return await fail(parsed.status, parsed.code, parsed.message)
    }
    trace.bytesIn = parsed.body.raw.length

    const exampleName = preferred(request, 'example')

    const responders = createResponders({
      operation,
      request,
      staticStatus: config.status,
      key,
      generateOptions: {
        maxDepth: options.maxDepth,
        preferExamples: options.preferExamples,
        resolvers,
        schemaNames: api.schemaNames
      },
      // ctx is declared just below; this getter is only invoked later (inside
      // generateValue, at generation time), by which point the assignment has
      // already run - the same deferral the old inline closure relied on.
      ctx: () => ctx
    })

    const ctx: Ctx = createContext({
      request,
      url,
      operation,
      params,
      body: parsed.body.value,
      mediaType: parsed.body.mediaType,
      rng: responders.rngFor('ctx'),
      requestKey: key,
      counters,
      generate: responders.generate,
      example: responders.example
    })
    trace.ctx = ctx

    // Stages 3 through 6, in the master spec's order. Auth runs before
    // validation so an unauthenticated caller cannot learn whether their body
    // was well-formed. Stage 5 (idempotency) arrives in Task 6.
    const stages: Stage[] = [
      createAuthStage({
        security: operation.security,
        schemes: api.securitySchemes,
        config: options.auth ?? {},
        fail
      })
    ]

    if (options.validateRequests !== false) {
      stages.push(createValidationStage({ operation, fail }))
    }

    // Pushed after validation so a malformed request is still rejected on its
    // merits rather than by chaos.
    stages.push(
      createFailureStage({
        operation,
        policies,
        decide: options.decide,
        store,
        chaosSeed,
        requestKey: key,
        counter: () => {
          const next = (chaosCounts.get(key) ?? 0) + 1
          chaosCounts.set(key, next)
          return next
        },
        sleep,
        fail
      })
    )

    for (const stage of stages) {
      const short = await stage(ctx)
      if (short) return short
    }

    // Stage 10 - the full response callback replaces stages 7 through 10,
    // status selection included, so it runs BEFORE the selection check: an
    // operation declaring no responses has nothing to select, yet the callback
    // must still answer.
    if (config.respond) {
      try {
        return await config.respond(ctx)
      } catch (error) {
        throw markCallback(error)
      }
    }

    // Stage 7 - status selection, now that every short-circuiting stage has run
    // and no callback has taken over.
    const selected = responders.selection()
    if (!selected) {
      return await fail(
        501,
        'MOCK_NO_RESPONSE',
        `Operation ${operation.method} ${operation.path} declares no responses`,
        ctx
      )
    }
    const chosen = selected.spec

    return await renderResponse({
      ctx,
      chosen,
      bodyOverrides: config.bodies(chosen.status),
      headerOverrides: config.headers(chosen.status),
      globals: options.headers,
      resolvers,
      rngFor: responders.rngFor,
      generateOptions: responders.generateOptions,
      exampleName,
      generate: responders.generate,
      example: responders.example,
      debug: options.debugHeaders
        ? {
            seed: String(fnv1a(key)),
            source: selected.source,
            operationId: operation.operationId
          }
        : undefined
    })
  }

  /**
   * The boundary 500. Every user callback - resolvers, override functions,
   * header overrides, response callbacks - runs somewhere inside `produce`, and
   * invariant 4 says the mock keeps serving whatever they do. One catch rather
   * than one per leaf: a per-leaf catch would let a half-built body reach the
   * client as if it were real.
   */
  function internalError(error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error)
    const headers = new Headers()
    if (options.debugHeaders) {
      // Header values cannot carry line breaks, and a thrown message might.
      headers.set('x-mock-error', message.replace(/[\r\n]+/g, ' '))
    }
    const code = isCallbackError(error) ? 'MOCK_CALLBACK_FAILED' : 'MOCK_INTERNAL'
    return Response.json(envelope(code, message), { status: 500, headers })
  }

  /**
   * THE SINGLE EXIT. Every response leaves through here - a 404 built before any
   * operation was known, a body-parse 400, a stage short-circuit, a rendered
   * body, and the boundary 500 alike. Stage 11 (idempotency capture, then the
   * log record) hangs off this one point; that is the whole reason `produce` was
   * split out. See the phases 7-9 design §1.
   */
  async function handle(request: Request): Promise<Response> {
    const trace: Trace = { params: {}, requestKey: seed, bytesIn: 0 }

    let response: Response
    try {
      response = await produce(request, trace)
    } catch (error) {
      trace.error = error
      response = internalError(error)
    }

    // Stage 11 lands here in Tasks 7 and 8.
    return response
  }
```

Update the imports at the top of the file: add `createAuthStage` to the auth
import, `createValidationStage` to the validate import, `createFailureStage` to
the failure import, and `Fail` to the type import from `../runtime/types.ts`.
`checkAuth`, `validateRequest`, and `checkFailure` are no longer referenced by
`handler.ts` - remove those three imports.

- [ ] **Step 10: Run the whole suite**

Run: `npm test`

Expected: PASS - 414 tests (408 existing plus the 6 new stage tests). **Any
existing test that fails is a behavior change, and this task must not change
behavior.** If one fails, fix the refactor, not the test.

- [ ] **Step 11: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 12: Commit**

```sh
git add -A
```

```sh
git commit -m 'refactor: give the pipeline one exit and name every stage' -m 'produce() builds a response; handle() is the single point every response passes through, including the boundary 500. Stage 11 hangs off it in later tasks.' -m 'Each stage moves to a named factory beside the module that owns it, so a stack trace names the stage that responded. requestKey is computed once rather than twice. Settles deferred items 1, 2, and 9.'
```

---

## Task 2: Settle `reset()` ownership

Deferred item 3. Must land before idempotency records start living in the Store.

**The ruling:** both surfaces clear the store. `Handler.reset()` gains
`await store.clear()` and returns `Promise<void>`; `Mock.reset()` delegates to it
rather than calling `store.clear()` itself. The documented contract is **"reset()
clears the store it was given"** - a caller who shares a store with their
application should supply a dedicated one instead. §10 already says the Store
holds mock state only (idempotency records, chaos state, `ctx.seq()` counters) and
that there is no entity persistence, so a shared store was never an intended use.

**Files:**
- Modify: `src/server/handler.ts` (the `Handler` interface and `reset`)
- Modify: `src/index.ts:77-80` (`Mock.reset`)
- Test: `test/server/handler.test.ts` (add), `test/control-plane.test.ts` (existing, verify)

**Interfaces:**
- Consumes: `Store.clear()` from Task 0 state (`src/runtime/store.ts`, unchanged).
- Produces: `Handler.reset(): Promise<void>` - was `void`. `Mock.reset()` keeps
  its existing `Promise<void>` signature, so `index.ts`'s public surface does not
  change.

- [ ] **Step 1: Write the failing test**

Append to `test/server/handler.test.ts`:

```ts
test('reset clears a caller-supplied store', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { seed: 'reset', store })
  await store.set('left-behind', 1)

  await handler.reset()

  assert.equal(await store.get('left-behind'), undefined)
})

test('reset is awaitable', async () => {
  const handler = createHandler(api, { seed: 'reset' })
  assert.ok(handler.reset() instanceof Promise)
})
```

Add `import { createMemoryStore } from '../../src/runtime/store.ts'` to that
file's imports. `api` is already `loadApi(petstore)` at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server/handler.test.ts`

Expected: FAIL - `left-behind` is still `1`, and `handler.reset()` returns
`undefined` rather than a Promise.

- [ ] **Step 3: Make `Handler.reset` async and store-clearing**

In `src/server/handler.ts`, change the interface:

```ts
export interface Handler {
  fetch(request: Request): Promise<Response>
  store: Store
  setSeed(next: string): void
  /**
   * Clears the store it was given - not only the store it created. The two
   * surfaces disagreed until plan 5: `Mock.reset()` wiped a caller-supplied
   * store while `Handler.reset()` left it untouched. Agreeing on "reset clears
   * the store it was given" is the honest contract now that idempotency records
   * live there too; supply a dedicated Store rather than sharing your
   * application's.
   */
  reset(): Promise<void>
}
```

and the implementation:

```ts
    async reset() {
      seed = options.seed ?? 'mockingham'
      counters.reset()
      chaosCounts.clear()
      await store.clear()
    }
```

- [ ] **Step 4: Delegate from `Mock.reset`**

In `src/index.ts`:

```ts
    async reset() {
      // Delegates wholly: the handler owns the store's lifecycle, and two
      // surfaces each deciding what reset means is what deferred item 3 was.
      await handler.reset()
    },
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`

Expected: PASS. `test/control-plane.test.ts:73` already asserts
`instance.reset() instanceof Promise` and its other two call sites already await,
so nothing there should need editing. If a test calls `handler.reset()` without
awaiting, add the `await`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add -A
```

```sh
git commit -m 'fix: make both reset surfaces clear the store' -m 'Handler.reset() now awaits store.clear() and returns a promise, matching Mock.reset(); Mock.reset() delegates rather than clearing the store itself. The contract is reset() clears the store it was given. Settles deferred item 3, which blocked idempotency records living in the Store.'
```

---

## Task 3: Injected clock and a derived `requestId`

Delta design §2.1 and §2.2. A log record needs `ts` and `durationMs`, which need a
wall clock; `requestId` needs to be stable across processes because it is the
natural value to echo for correlation.

**Files:**
- Create: `src/runtime/logging.ts`
- Create: `test/runtime/logging.test.ts`
- Modify: `src/runtime/types.ts` (`Ctx.requestId`)
- Modify: `src/runtime/context.ts` (`ContextInput.requestId`)
- Modify: `src/server/handler.ts` (`options.now`, the ordinal counter, wiring)
- Test: `test/server/handler.test.ts` (add)

**Interfaces:**
- Consumes: `fnv1a` (`src/generate/rng.ts`), `createMemoryStore(now)`
  (`src/runtime/store.ts`).
- Produces:
  - `requestIdFor(requestKey: string, ordinal: number): string` - 16 lowercase hex characters
  - `Ctx.requestId: string`
  - `ContextInput.requestId: string` (required - every caller of `createContext` must supply it)
  - `HandlerOptions.now?: () => number`

- [ ] **Step 1: Write the failing unit test**

Create `test/runtime/logging.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestIdFor } from '../../src/runtime/logging.ts'

test('requestIdFor is stable for the same key and ordinal', () => {
  assert.equal(requestIdFor('k', 1), requestIdFor('k', 1))
})

test('requestIdFor differs across ordinals', () => {
  assert.notEqual(requestIdFor('k', 1), requestIdFor('k', 2))
})

test('requestIdFor differs across keys', () => {
  assert.notEqual(requestIdFor('a', 1), requestIdFor('b', 1))
})

test('requestIdFor is 16 lowercase hex characters', () => {
  assert.match(requestIdFor('k', 1), /^[0-9a-f]{16}$/)
  // A short hash left-pads rather than truncating; assert a key whose hash has
  // a leading zero still fills the width.
  for (let n = 1; n < 200; n++) {
    assert.match(requestIdFor(`key-${n}`, n), /^[0-9a-f]{16}$/)
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/runtime/logging.test.ts`

Expected: FAIL - cannot find module `src/runtime/logging.ts`.

- [ ] **Step 3: Create `src/runtime/logging.ts`**

```ts
import { fnv1a } from '../generate/rng.ts'

/**
 * `hash(requestKey, ordinal)` rather than a random id.
 *
 * A random id would be the obvious choice and is wrong here: `requestId` is the
 * natural value to echo on a response header for correlation, and the moment it
 * does, a random id breaks the determinism invariant. Hashing request identity
 * plus an ordinal gives an id that is stable across processes and still distinct
 * across repeated identical calls.
 *
 * The ordinal MUST come from its own counter, not the chaos counter - the
 * failure stage increments that one per policy evaluation, and sharing it would
 * shift every subsequent chaos roll the moment logging was switched on. See the
 * phases 7-9 design §2.2.
 *
 * Two hashes, because one fnv1a is 32 bits and 8 hex characters collide often
 * enough to be annoying in a log search.
 */
export function requestIdFor(requestKey: string, ordinal: number): string {
  const head = fnv1a(`${requestKey}|${ordinal}`).toString(16).padStart(8, '0')
  const tail = fnv1a(`${requestKey}|${ordinal}|mockingham`).toString(16).padStart(8, '0')
  return `${head}${tail}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/runtime/logging.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing handler tests**

Append to `test/server/handler.test.ts`:

```ts
test('requestId is deterministic across handlers and distinct across calls', async () => {
  const echo = {
    seed: 'ids',
    operations: {
      // Reading ctx.requestId through a response callback is the only way to
      // observe it; nothing echoes it on a header by default.
      showPetById: { respond: (ctx: Ctx) => ctx.respond(200, { id: ctx.requestId }) }
    }
  }
  const idFrom = async (handle: (r: Request) => Promise<Response>) =>
    ((await (await handle(new Request('http://x/pets/42'))).json()) as { id: string }).id

  const first = createHandler(api, echo).fetch
  const one = await idFrom(first)
  const two = await idFrom(first)

  // A fresh handler with the same seed replays the same sequence - that is what
  // "stable across processes" means for a correlation id.
  const replay = await idFrom(createHandler(api, echo).fetch)

  assert.notEqual(one, two)
  assert.equal(replay, one)
})

test('an inbound X-Request-Id wins', async () => {
  const handle = createHandler(api, {
    seed: 'ids',
    operations: { showPetById: { respond: (ctx: Ctx) => ctx.respond(200, { id: ctx.requestId }) } }
  }).fetch

  const response = await handle(
    new Request('http://x/pets/42', { headers: { 'x-request-id': 'caller-42' } })
  )

  assert.equal(((await response.json()) as { id: string }).id, 'caller-42')
})

test('the injected clock drives the default store', async () => {
  // Proves `now` actually reaches createMemoryStore rather than only the log
  // record: an outage armed with a TTL must expire when the clock advances.
  // The outage key is `outage|<operationId>` - see outageKey and targetKey in
  // src/runtime/failure.ts. No `failure` policy is needed: checkFailure reads
  // the outage key unconditionally, before it looks at any policy.
  let value = 1_000
  const handler = createHandler(api, { seed: 'clock', now: () => value })
  await handler.store.set('outage|showPetById', { status: 503 }, 5_000)

  assert.equal((await handler.fetch(new Request('http://x/pets/42'))).status, 503)
  value += 6_000
  assert.equal((await handler.fetch(new Request('http://x/pets/42'))).status, 200)
})
```

Add `import type { Ctx } from '../../src/runtime/types.ts'` to the file. The
fixture is `test/fixtures/petstore.ts`: the route is `/pets/{petId}`, the
operationId is `showPetById`, and it declares no security.

- [ ] **Step 6: Run to verify they fail**

Run: `node --test test/server/handler.test.ts`

Expected: FAIL - `ctx.requestId` is `undefined`, and `now` is not a known option.

- [ ] **Step 7: Add `requestId` to the context**

In `src/runtime/types.ts`, inside `Ctx`, after `requestKey`:

```ts
  /**
   * A correlation id: an inbound `X-Request-Id` when the caller sent one,
   * otherwise `hash(requestKey, ordinal)`. Derived rather than random so a
   * replayed run correlates across processes - see the phases 7-9 design §2.2.
   */
  requestId: string
```

In `src/runtime/context.ts`, add `requestId: string` to `ContextInput` and
`requestId: input.requestId,` to the `ctx` literal, next to `requestKey`.

- [ ] **Step 8: Wire the clock and the ordinal into the handler**

In `src/server/handler.ts`, add to `HandlerOptions`:

```ts
  /**
   * The wall clock, injected. Log timestamps and Store TTLs are the only two
   * consumers; neither can reach a response body, so neither violates the
   * determinism invariant. Defaults to `Date.now` at this boundary and nowhere
   * else.
   */
  now?: () => number
```

In `createHandler`, replace the store construction and add the ordinal counter:

```ts
  const now = options.now ?? (() => Date.now())
  // One clock for the store and the log, so a fake clock in a test drives both.
  const store = options.store ?? createMemoryStore(now)
  // Its OWN counter. Sharing the chaos counter would shift every chaos roll the
  // moment logging was enabled - phases 7-9 design §2.2.
  const requestOrdinals = new Map<string, number>()
```

In `produce`, immediately before `createContext`:

```ts
    const ordinal = (requestOrdinals.get(key) ?? 0) + 1
    requestOrdinals.set(key, ordinal)
    // The caller's id wins: correlating with whatever they already log matters
    // more than an id we made up.
    const inbound = request.headers.get('x-request-id')
    const requestId = inbound ?? requestIdFor(key, ordinal)
```

and pass `requestId` into the `createContext` call.

In `reset()`, add `requestOrdinals.clear()` beside `chaosCounts.clear()`.

Import `requestIdFor` from `../runtime/logging.ts`.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`

Expected: PASS. `test/runtime/context.test.ts` constructs a `Ctx` directly and
will need `requestId` added to its input - that is the one legitimate edit to an
existing test in this task. `test/helpers/ctx.ts` needs `requestId: 'test-id'`
added to its `createContext` call too.

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 11: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: add an injected clock and a derived requestId' -m 'options.now defaults to Date.now at the construction boundary and feeds both the default MemoryStore and, shortly, log timestamps. ctx.requestId is hash(requestKey, ordinal) from its own counter, or the inbound X-Request-Id when the caller sent one.'
```

---

## Task 4: `ctx.decisions`

Delta design §2.5. §12's record carries
`decisions: { auth?, validation?, failure?, idempotency?, fixture? }`, and a stage
currently has nowhere to record what it decided. A plain object stages write into
mirrors the existing `ctx.log`, needs no change to the `Stage` signature, and -
the point - records a decision even when the stage does **not** short-circuit. A
validation that passed is as loggable as one that failed.

Values are short lowercase strings, not booleans or objects: §12 separates
low-cardinality fields for tagging, and `auth: "denied"` is a usable tag while
`auth: { ok: false, code: "MOCK_UNAUTHORIZED" }` is not.

**Files:**
- Modify: `src/runtime/types.ts` (`Decisions`, `Ctx.decisions`)
- Modify: `src/runtime/context.ts` (initialize `decisions`)
- Modify: `src/runtime/auth.ts`, `src/runtime/validate.ts`, `src/runtime/failure.ts` (write into it)
- Test: `test/runtime/stages.test.ts` (extend), `test/server/handler.test.ts` (add)

**Interfaces:**
- Consumes: the three stage factories from Task 1.
- Produces:
  - `interface Decisions { auth?: string; validation?: string; failure?: string; idempotency?: string; fixture?: string }`
  - `Ctx.decisions: Decisions`
  - Values written by this task: `auth` ∈ `'ok' | 'anonymous' | 'denied'`;
    `validation` ∈ `'ok' | 'failed'`; `failure` ∈ `'ok' | 'injected'`.
    `idempotency` is written in Task 6; `fixture` stays unwritten until phase 11.

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime/stages.test.ts`:

```ts
test('authStage records a denial even though it short-circuits', async () => {
  const { fail } = recordingFail()
  const stage = createAuthStage({
    security: operation.security, schemes: api.securitySchemes, config: {}, fail
  })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  await stage(ctx)

  assert.equal(ctx.decisions.auth, 'denied')
})

test('authStage records success', async () => {
  const { fail } = recordingFail()
  const stage = createAuthStage({
    security: operation.security, schemes: api.securitySchemes, config: {}, fail
  })
  const ctx = buildCtx({
    request: new Request('http://mock/pets/1', { headers: { authorization: 'Bearer t' } }),
    operation,
    params: { id: '1' }
  })

  await stage(ctx)

  assert.equal(ctx.decisions.auth, 'ok')
})

test('validationStage records a pass, not only a failure', async () => {
  // The reason decisions live on ctx rather than being derived from the
  // response: a stage that did not short-circuit still made a decision.
  const { fail } = recordingFail()
  const stage = createValidationStage({ operation, fail })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  await stage(ctx)

  assert.equal(ctx.decisions.validation, 'ok')
})

test('validationStage records a failure', async () => {
  const { fail } = recordingFail()
  const stage = createValidationStage({ operation, fail })
  const ctx = buildCtx({ request: new Request('http://mock/pets/abc'), operation, params: { id: 'abc' } })

  await stage(ctx)

  assert.equal(ctx.decisions.validation, 'failed')
})

test('failureStage records both outcomes', async () => {
  const { fail } = recordingFail()
  const base = {
    operation,
    policies: compilePolicies([], api.operations),
    store: createMemoryStore(),
    chaosSeed: 's',
    requestKey: 'k',
    counter: () => 1,
    sleep: async () => {},
    fail
  }
  const clean = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })
  await createFailureStage(base)(clean)
  assert.equal(clean.decisions.failure, 'ok')

  const injected = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })
  await createFailureStage({ ...base, decide: () => ({ status: 503 }) })(injected)
  assert.equal(injected.decisions.failure, 'injected')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/runtime/stages.test.ts`

Expected: FAIL - `ctx.decisions` is `undefined`.

- [ ] **Step 3: Add the `Decisions` type**

In `src/runtime/types.ts`:

```ts
/**
 * What each stage decided, for the log record's `decisions` field (master spec
 * §12). Short lowercase strings rather than booleans or objects, because §12
 * separates low-cardinality fields precisely so they can be used as metric tags
 * - `auth: "denied"` tags cleanly, a nested object does not.
 *
 * A stage writes here whether or not it short-circuits: a validation that passed
 * is as loggable as one that failed.
 */
export interface Decisions {
  /** 'ok' | 'anonymous' | 'denied' */
  auth?: string
  /** 'ok' | 'failed' - absent when validateRequests is false */
  validation?: string
  /** 'ok' | 'injected' */
  failure?: string
  /** 'first' | 'replayed' | 'mismatch' | 'in-flight' - absent when not idempotent */
  idempotency?: string
  /** Reserved for phase 11's fixture path. */
  fixture?: string
}
```

Add `decisions: Decisions` to `Ctx`, next to `log`.

In `src/runtime/context.ts`, add `decisions: {},` to the `ctx` literal beside
`log: {},`.

- [ ] **Step 4: Write decisions from the stages**

`createAuthStage`:

```ts
    if (outcome.ok) {
      ctx.auth = outcome.principal
      // 'anonymous' is a real outcome, not a missing one: the operation declared
      // no security, or declared it optional and the caller sent nothing.
      ctx.decisions.auth = outcome.principal ? 'ok' : 'anonymous'
      return undefined
    }
    ctx.decisions.auth = 'denied'
```

`createValidationStage`:

```ts
    const result = validateRequest(ctx, input.operation)
    if (result.ok) {
      ctx.decisions.validation = 'ok'
      return undefined
    }
    ctx.decisions.validation = 'failed'
```

`createFailureStage`:

```ts
    if (outcome.ok) {
      ctx.decisions.failure = 'ok'
      return undefined
    }
    ctx.decisions.failure = 'injected'
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/runtime/stages.test.ts`

Expected: PASS.

- [ ] **Step 6: Prove decisions survive to a response callback**

Append to `test/server/handler.test.ts`:

```ts
test('decisions are populated by the time a response callback runs', async () => {
  const handle = createHandler(api, {
    seed: 'decisions',
    operations: { showPetById: { respond: (ctx: Ctx) => ctx.respond(200, ctx.decisions) } }
  }).fetch

  const body = await (await handle(new Request('http://x/pets/42'))).json()

  // petstore declares no security, so auth is 'anonymous' rather than 'ok' -
  // a real outcome, not a missing one.
  assert.deepEqual(body, { auth: 'anonymous', validation: 'ok', failure: 'ok' })
})
```

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS. `test/runtime/context.test.ts` may assert the exact shape of a
fresh `Ctx`; if it does, add `decisions: {}` to its expectation.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 8: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: record each stage decision on ctx.decisions' -m 'A plain object stages write into, mirroring ctx.log. Recorded whether or not the stage short-circuits, because a validation that passed is as loggable as one that failed. Values are short strings so they tag cleanly per master spec section 12.'
```

---

## Task 5: The idempotency module

Phase 7, master spec §11, delta design §2.3 and §2.4. This task builds the pure
parts - enablement, fingerprint, key composition, the stored entry shape - with no
pipeline wiring at all. Task 6 adds the stage.

**Files:**
- Create: `src/runtime/idempotency.ts`
- Create: `test/runtime/idempotency.test.ts`
- Modify: `src/generate/rng.ts` (add `fnv1aBytes`)
- Test: `test/generate/rng.test.ts` (add)

**Interfaces:**
- Consumes: `Operation`, `Parameter` (`src/spec/types.ts`).
- Produces:
  - `fnv1aBytes(bytes: Uint8Array): number` in `src/generate/rng.ts`
  - `interface IdempotencyConfig` - the user-facing option
  - `interface ResolvedIdempotency` - every field filled
  - `resolveIdempotency(config?: IdempotencyConfig): ResolvedIdempotency`
  - `isIdempotent(operation: Operation, config: ResolvedIdempotency): boolean`
  - `fingerprint(raw: Uint8Array): string`
  - `recordKey(input: { key: string; operation: Operation; scope: ScopePart[] }): string`
  - `comparesBody(config: ResolvedIdempotency): boolean`
  - `type ScopePart = 'key' | 'route' | 'bodyHash'`
  - `type IdempotencyEntry`

- [ ] **Step 1: Write the failing `fnv1aBytes` test**

Append to `test/generate/rng.test.ts`:

```ts
test('fnv1aBytes hashes raw bytes', () => {
  const bytes = new TextEncoder().encode('abc')
  assert.equal(fnv1aBytes(bytes), fnv1aBytes(new TextEncoder().encode('abc')))
  assert.notEqual(fnv1aBytes(bytes), fnv1aBytes(new TextEncoder().encode('abd')))
})

test('fnv1aBytes matches fnv1a for ASCII', () => {
  // fnv1a walks charCodeAt; for ASCII those are the same numbers as the bytes,
  // so the two must agree. They diverge above U+007F, which is exactly why the
  // byte version exists - a body is bytes, not a string.
  assert.equal(fnv1aBytes(new TextEncoder().encode('hello')), fnv1a('hello'))
})
```

Add `fnv1aBytes` to that file's import.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/generate/rng.test.ts`

Expected: FAIL - `fnv1aBytes is not a function`.

- [ ] **Step 3: Add `fnv1aBytes`**

In `src/generate/rng.ts`, immediately after `fnv1a`:

```ts
/**
 * fnv1a over raw bytes. The idempotency fingerprint hashes the request body as
 * it arrived rather than a re-serialization of the parsed value: re-serializing
 * depends on key insertion order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` would
 * differ anyway - but only by accident, and a future canonicalization would
 * silently change which requests conflict. Hashing bytes makes the rule
 * explicit: byte-identical bodies replay, anything else conflicts.
 */
export function fnv1aBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/generate/rng.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing idempotency-module tests**

Create `test/runtime/idempotency.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import {
  fingerprint,
  isIdempotent,
  recordKey,
  resolveIdempotency
} from '../../src/runtime/idempotency.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }
        ],
        responses: { '201': { description: 'created' } }
      },
      get: { operationId: 'listOrders', responses: { '200': { description: 'ok' } } }
    },
    '/carts': {
      patch: { operationId: 'patchCart', responses: { '200': { description: 'ok' } } }
    }
  }
})

const find = (id: string) => api.operations.find((op) => op.operationId === id)!
const bytes = (text: string) => new TextEncoder().encode(text)

test('resolveIdempotency fills the master spec defaults', () => {
  assert.deepEqual(resolveIdempotency(), {
    header: 'Idempotency-Key',
    methods: [],
    ttlMs: 86_400_000,
    inFlightTtlMs: 30_000,
    scope: ['key', 'route', 'bodyHash'],
    conflictStatus: 409
  })
})

test('resolveIdempotency uppercases configured methods', () => {
  assert.deepEqual(resolveIdempotency({ methods: ['post', 'Patch'] }).methods, ['POST', 'PATCH'])
})

test('a declared Idempotency-Key header parameter enables an operation', () => {
  assert.equal(isIdempotent(find('createOrder'), resolveIdempotency()), true)
})

test('header matching is case-insensitive', () => {
  const config = resolveIdempotency({ header: 'idempotency-KEY' })
  assert.equal(isIdempotent(find('createOrder'), config), true)
})

test('an operation with no such parameter is not enabled by default', () => {
  assert.equal(isIdempotent(find('patchCart'), resolveIdempotency()), false)
})

test('config.methods enables an operation that declares nothing', () => {
  const config = resolveIdempotency({ methods: ['PATCH'] })
  assert.equal(isIdempotent(find('patchCart'), config), true)
  assert.equal(isIdempotent(find('listOrders'), config), false)
})

test('fingerprint is stable and byte-sensitive', () => {
  assert.equal(fingerprint(bytes('{"a":1}')), fingerprint(bytes('{"a":1}')))
  assert.notEqual(fingerprint(bytes('{"a":1}')), fingerprint(bytes('{"a":2}')))
})

test('fingerprint treats reordered keys as different bodies', () => {
  // Deliberate: hashing raw bytes errs toward a false conflict rather than a
  // false replay. A spurious 409 is visible and recoverable; a wrong replay
  // silently returns someone else's response.
  assert.notEqual(fingerprint(bytes('{"a":1,"b":2}')), fingerprint(bytes('{"b":2,"a":1}')))
})

test('an empty body has a fingerprint', () => {
  assert.match(fingerprint(new Uint8Array()), /^[0-9a-f]{8}$/)
})

test('recordKey composes the scope parts in order', () => {
  const operation = find('createOrder')
  assert.equal(
    recordKey({ key: 'abc', operation, scope: ['key', 'route', 'bodyHash'] }),
    'idem|key=abc|route=post /orders'
  )
})

test('recordKey leaves bodyHash out of the key', () => {
  // If the fingerprint were part of the key, a different body would compute a
  // different key, the lookup would miss, and §11's own mismatch rule would be
  // unreachable. `bodyHash` in the scope means "compare it" - see §2.7.
  const operation = find('createOrder')
  assert.equal(
    recordKey({ key: 'abc', operation, scope: ['key', 'route', 'bodyHash'] }),
    recordKey({ key: 'abc', operation, scope: ['key', 'route'] })
  )
})

test('recordKey honors a narrowed scope', () => {
  const operation = find('createOrder')
  assert.equal(recordKey({ key: 'abc', operation, scope: ['key'] }), 'idem|key=abc')
})

test('recordKey honors scope order', () => {
  const operation = find('createOrder')
  assert.notEqual(
    recordKey({ key: 'abc', operation, scope: ['key', 'route'] }),
    recordKey({ key: 'abc', operation, scope: ['route', 'key'] })
  )
})

test('recordKey uses the templated route, not a resolved path', () => {
  // Two calls to /pets/1 and /pets/2 differ only through params, which are in
  // neither the key nor the route. That is the point: an idempotency key is
  // meant to be unique per logical operation.
  const operation = find('createOrder')
  assert.match(recordKey({ key: 'k', operation, scope: ['route'] }), /\/orders$/)
})

test('comparesBody follows the scope', () => {
  assert.equal(comparesBody(resolveIdempotency()), true)
  assert.equal(comparesBody(resolveIdempotency({ scope: ['key', 'route'] })), false)
})

test('a scope with neither key nor route is rejected', () => {
  // Every request would then share one record. A typo throws at construction
  // rather than silently collapsing every caller onto one another's responses.
  assert.throws(() => resolveIdempotency({ scope: ['bodyHash'] }), /scope/)
})
```

Add `comparesBody` to the import at the top of the file.

- [ ] **Step 6: Run to verify they fail**

Run: `node --test test/runtime/idempotency.test.ts`

Expected: FAIL - cannot find module `src/runtime/idempotency.ts`.

- [ ] **Step 7: Create `src/runtime/idempotency.ts`**

```ts
import type { Operation } from '../spec/types.ts'
import { fnv1aBytes } from '../generate/rng.ts'

export type ScopePart = 'key' | 'route' | 'bodyHash'

/** The `idempotency` option, master spec §11. */
export interface IdempotencyConfig {
  header?: string
  /** Methods to enable even when the document declares no key parameter. */
  methods?: string[]
  ttlMs?: number
  /**
   * How long an in-flight marker survives. §11 does not say what happens when a
   * request never completes; without an answer the key wedges permanently and
   * every retry sees a marker that will never resolve. Two mechanisms cover it:
   * this TTL for a process that dies mid-request, and the handler's boundary
   * catch for a throw.
   */
  inFlightTtlMs?: number
  /**
   * `key` and `route` compose the storage key, in the order given. `bodyHash`
   * does NOT go in the key - it means "a different body under this key is a
   * conflict". Putting the fingerprint in the key would make a different body
   * compute a different key, miss the lookup, and leave §11's own
   * MOCK_IDEMPOTENCY_MISMATCH rule unreachable. See the phases 7-9 design §2.7.
   */
  scope?: ScopePart[]
  conflictStatus?: number
}

export interface ResolvedIdempotency {
  header: string
  methods: string[]
  ttlMs: number
  inFlightTtlMs: number
  scope: ScopePart[]
  conflictStatus: number
}

/**
 * What lives in the Store under a record key.
 *
 * The in-flight marker carries the fingerprint too, so a second request with a
 * DIFFERENT body conflicts on its merits rather than being reported as merely
 * concurrent.
 */
export type IdempotencyEntry =
  | { state: 'in-flight'; fingerprint: string }
  | {
      state: 'done'
      fingerprint: string
      status: number
      headers: Record<string, string>
      body: string | null
    }

export function resolveIdempotency(config: IdempotencyConfig = {}): ResolvedIdempotency {
  const scope = config.scope ?? ['key', 'route', 'bodyHash']
  // A scope of `['bodyHash']` alone would key every request in the document
  // under one record. Throw at construction rather than silently collapsing
  // every caller onto one another's responses.
  if (!scope.includes('key') && !scope.includes('route')) {
    throw new Error(
      'mockingham: idempotency scope must include "key" or "route"; ' +
        `got [${scope.join(', ')}].`
    )
  }
  return {
    header: config.header ?? 'Idempotency-Key',
    methods: (config.methods ?? []).map((method) => method.toUpperCase()),
    ttlMs: config.ttlMs ?? 86_400_000,
    inFlightTtlMs: config.inFlightTtlMs ?? 30_000,
    scope,
    conflictStatus: config.conflictStatus ?? 409
  }
}

/**
 * Per §11, an operation is idempotent when the document declares the key as a
 * header parameter, or when config names its method. The document wins nothing
 * and loses nothing - either route is sufficient.
 */
export function isIdempotent(operation: Operation, config: ResolvedIdempotency): boolean {
  const wanted = config.header.toLowerCase()
  const declared = operation.parameters.some(
    (parameter) =>
      parameter.location === 'header' && parameter.name.toLowerCase() === wanted
  )
  return declared || config.methods.includes(operation.method.toUpperCase())
}

/** fnv1a over the raw request bytes - see `fnv1aBytes` for why not the parsed body. */
export function fingerprint(raw: Uint8Array): string {
  return fnv1aBytes(raw).toString(16).padStart(8, '0')
}

export interface RecordKeyInput {
  key: string
  operation: Operation
  scope: ScopePart[]
}

/**
 * Composes the storage key from the scope's `key` and `route` parts, in the
 * configured order. The route part is the TEMPLATED path, so `/pets/1` and
 * `/pets/2` share a route and differ only through params, which belong to
 * neither part - deliberate, since a key is supposed to be unique per logical
 * operation.
 *
 * `bodyHash` contributes nothing here on purpose; see `comparesBody`.
 */
export function recordKey(input: RecordKeyInput): string {
  const parts: string[] = []
  for (const part of input.scope) {
    if (part === 'key') parts.push(`key=${input.key}`)
    else if (part === 'route') {
      parts.push(`route=${input.operation.method} ${input.operation.path}`)
    }
  }
  return `idem|${parts.join('|')}`
}

/**
 * Whether a stored fingerprint that differs from this request's is a conflict.
 *
 * This is what `bodyHash` in the scope actually controls. With it, the default
 * scope gives §11's stated behavior - same key, different body, 409. Without it,
 * any body replays the first response, which is what a caller asking for
 * `scope: ['key', 'route']` is asking for.
 */
export function comparesBody(config: ResolvedIdempotency): boolean {
  return config.scope.includes('bodyHash')
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `node --test test/runtime/idempotency.test.ts`

Expected: PASS, 16 tests.

- [ ] **Step 9: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 10: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: add the idempotency module' -m 'Config resolution, enablement by declared header parameter or configured method, a fingerprint over raw request bytes, and scope-ordered record keys. No pipeline wiring yet.' -m 'The fingerprint hashes bytes rather than a re-serialized body so the rule is explicit: byte-identical bodies replay, anything else conflicts. That errs toward a visible 409 rather than a silent wrong replay.'
```

---

## Task 6: Stage 5 - idempotency lookup

The read half. A stored response replays, a fingerprint mismatch conflicts, an
in-flight marker conflicts, and a first request claims the key.

**Files:**
- Modify: `src/runtime/idempotency.ts` (add `createIdempotencyStage`)
- Modify: `src/server/handler.ts` (`options.idempotency`, wire stage 5, `Trace.claimed`)
- Test: `test/runtime/idempotency.test.ts` (extend)
- Create: `test/server/idempotency.test.ts`

**Interfaces:**
- Consumes: `Fail`, `Stage`, `Ctx` (`src/runtime/types.ts`), `Store`
  (`src/runtime/store.ts`), everything from Task 5.
- Produces:
  - `createIdempotencyStage(input: IdempotencyStageInput): Stage` - returns `idempotencyStage`
  - `interface IdempotencyStageInput { operation, config, store, raw, fail, claim }`
    where `claim: (key: string, fingerprint: string) => void`
  - `HandlerOptions.idempotency?: IdempotencyConfig`
  - In `handler.ts`: `Trace.claimed?: { key: string; fingerprint: string }`

- [ ] **Step 1: Write the failing stage unit tests**

Append to `test/runtime/idempotency.test.ts`:

```ts
import { createIdempotencyStage } from '../../src/runtime/idempotency.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { buildCtx, recordingFail } from '../helpers/ctx.ts'

const post = () => find('createOrder')

function stageFor(
  store = createMemoryStore(),
  raw = new TextEncoder().encode('{"a":1}'),
  config = resolveIdempotency()
) {
  const { fail, calls } = recordingFail()
  const claimed: Array<{ key: string; fingerprint: string }> = []
  const stage = createIdempotencyStage({
    operation: post(),
    config,
    store,
    raw,
    fail,
    claim: (key, print) => claimed.push({ key, fingerprint: print })
  })
  return { stage, store, calls, claimed, raw }
}

const keyed = (value?: string) =>
  new Request('http://mock/orders', {
    method: 'POST',
    headers: value === undefined ? {} : { 'idempotency-key': value }
  })

test('a request with no key header passes straight through', async () => {
  const { stage, claimed } = stageFor()
  const ctx = buildCtx({ request: keyed(), operation: post() })

  assert.equal(await stage(ctx), undefined)
  assert.deepEqual(claimed, [])
  assert.equal(ctx.decisions.idempotency, undefined)
})

test('a first request claims the key and writes an in-flight marker', async () => {
  const { stage, store, claimed, raw } = stageFor()
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })

  assert.equal(await stage(ctx), undefined)
  assert.equal(claimed.length, 1)
  assert.equal(ctx.decisions.idempotency, 'first')
  assert.deepEqual(await store.get(claimed[0]!.key), {
    state: 'in-flight',
    fingerprint: fingerprint(raw)
  })
})

test('a stored response replays with the Idempotent-Replay header', async () => {
  const { stage, store, raw } = stageFor()
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const key = recordKey({ key: 'k1', operation: post(), scope: ['key', 'route', 'bodyHash'] })
  await store.set(key, {
    state: 'done',
    fingerprint: fingerprint(raw),
    status: 201,
    headers: { 'content-type': 'application/json' },
    body: '{"id":7}'
  })

  const response = await stage(ctx)

  assert.equal(response?.status, 201)
  assert.equal(response?.headers.get('idempotent-replay'), 'true')
  assert.equal(response?.headers.get('content-type'), 'application/json')
  assert.equal(await response?.text(), '{"id":7}')
  assert.equal(ctx.decisions.idempotency, 'replayed')
})

test('a different body under the same key conflicts', async () => {
  const store = createMemoryStore()
  const first = stageFor(store, new TextEncoder().encode('{"a":1}'))
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  const second = stageFor(store, new TextEncoder().encode('{"a":2}'))
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const response = await second.stage(ctx)

  // Reachable under the DEFAULT scope because the fingerprint is compared
  // rather than keyed (§2.7). The in-flight marker carries a fingerprint too,
  // so a mismatch is reported as a mismatch rather than as mere concurrency -
  // and asserting the code, not just the 409, is what distinguishes them.
  assert.equal(response?.status, 409)
  assert.deepEqual(second.calls, [{ status: 409, code: 'MOCK_IDEMPOTENCY_MISMATCH' }])
  assert.equal(ctx.decisions.idempotency, 'mismatch')
})

test('a different body replays when the scope does not compare bodies', async () => {
  const store = createMemoryStore()
  const loose = resolveIdempotency({ scope: ['key', 'route'] })
  const first = stageFor(store, new TextEncoder().encode('{"a":1}'), loose)
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  const second = stageFor(store, new TextEncoder().encode('{"a":2}'), loose)
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const response = await second.stage(ctx)

  // Not a mismatch: the caller opted out of comparing bodies, so this is simply
  // a second request against a key still in flight.
  assert.deepEqual(second.calls, [{ status: 409, code: 'MOCK_IDEMPOTENCY_IN_FLIGHT' }])
  assert.equal(response?.status, 409)
  assert.equal(ctx.decisions.idempotency, 'in-flight')
})

test('a matching body against an unresolved marker is in-flight', async () => {
  const store = createMemoryStore()
  const first = stageFor(store)
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  const second = stageFor(store)
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })
  const response = await second.stage(ctx)

  assert.equal(response?.status, 409)
  assert.deepEqual(second.calls, [{ status: 409, code: 'MOCK_IDEMPOTENCY_IN_FLIGHT' }])
  assert.equal(ctx.decisions.idempotency, 'in-flight')
})

test('conflictStatus is configurable', async () => {
  const store = createMemoryStore()
  const { fail } = recordingFail()
  const build = (raw: Uint8Array) =>
    createIdempotencyStage({
      operation: post(),
      config: resolveIdempotency({ conflictStatus: 422 }),
      store,
      raw,
      fail,
      claim: () => {}
    })
  await build(new TextEncoder().encode('a'))(buildCtx({ request: keyed('k'), operation: post() }))
  const response = await build(new TextEncoder().encode('b'))(
    buildCtx({ request: keyed('k'), operation: post() })
  )

  assert.equal(response?.status, 422)
})

test('the in-flight marker expires', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const first = stageFor(store)
  await first.stage(buildCtx({ request: keyed('k1'), operation: post() }))

  value += 31_000
  const second = stageFor(store)
  const ctx = buildCtx({ request: keyed('k1'), operation: post() })

  // Not a 409: the marker aged out, so the retry is a fresh first request.
  assert.equal(await second.stage(ctx), undefined)
  assert.equal(ctx.decisions.idempotency, 'first')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/runtime/idempotency.test.ts`

Expected: FAIL - `createIdempotencyStage is not a function`.

- [ ] **Step 3: Add `createIdempotencyStage`**

At the end of `src/runtime/idempotency.ts`:

```ts
export interface IdempotencyStageInput {
  operation: Operation
  config: ResolvedIdempotency
  store: Store
  /** The raw request bytes, from stage 2's parse. */
  raw: Uint8Array
  fail: Fail
  /**
   * Called when this request claims the key. The single exit uses it to know
   * what to store, and the boundary catch uses it to know what to clear.
   */
  claim: (key: string, fingerprint: string) => void
}

/**
 * Pipeline stage 5 - the read half. Stage 11, at the single exit, is the write
 * half. Idempotency spans two stages, which is why it is more invasive than its
 * size suggests.
 */
export function createIdempotencyStage(input: IdempotencyStageInput): Stage {
  return async function idempotencyStage(ctx) {
    if (!isIdempotent(input.operation, input.config)) return undefined

    const supplied = ctx.headers[input.config.header.toLowerCase()]
    // No key, nothing to key on. A document that wants the header mandatory
    // declares it `required`, and stage 4 has already rejected its absence.
    if (supplied === undefined) return undefined

    const bodyHash = fingerprint(input.raw)
    const key = recordKey({
      key: supplied,
      operation: input.operation,
      scope: input.config.scope
    })

    const entry = (await input.store.get(key)) as IdempotencyEntry | undefined

    if (entry === undefined) {
      ctx.decisions.idempotency = 'first'
      await input.store.set(
        key,
        { state: 'in-flight', fingerprint: bodyHash },
        input.config.inFlightTtlMs
      )
      input.claim(key, bodyHash)
      return undefined
    }

    // Mismatch before in-flight: a different body is a conflict on its merits,
    // whether or not the first request has finished.
    if (comparesBody(input.config) && entry.fingerprint !== bodyHash) {
      ctx.decisions.idempotency = 'mismatch'
      return await input.fail(
        input.config.conflictStatus,
        'MOCK_IDEMPOTENCY_MISMATCH',
        `Idempotency key "${supplied}" was already used with a different request body.`,
        ctx
      )
    }

    if (entry.state === 'in-flight') {
      ctx.decisions.idempotency = 'in-flight'
      return await input.fail(
        input.config.conflictStatus,
        'MOCK_IDEMPOTENCY_IN_FLIGHT',
        `Idempotency key "${supplied}" is still in flight.`,
        ctx
      )
    }

    ctx.decisions.idempotency = 'replayed'
    const headers = new Headers(entry.headers)
    headers.set('idempotent-replay', 'true')
    return new Response(entry.body, { status: entry.status, headers })
  }
}
```

Add the imports this needs at the top of the file: `Ctx`, `Fail`, `Stage` from
`./types.ts` and `Store` from `./store.ts`.

Both 409s reach the same status through different branches, which is exactly the
"assert the specific error path" lesson from `deferred-items.md`: a 409 that
arrives for the wrong reason still passes a status assertion. Every conflict test
above asserts the **code** as well, and the pair of tests around `comparesBody`
pins which branch each configuration takes.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/runtime/idempotency.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

Create `test/server/idempotency.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { Ctx } from '../../src/runtime/types.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }
        ],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          '201': {
            description: 'created',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    },
    '/plain': {
      post: {
        operationId: 'plain',
        responses: { '200': { description: 'ok' } }
      }
    }
  }
})

export const order = (key: string, body = '{"item":"a"}') =>
  new Request('http://mock/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body
  })

test('the same key with a different body conflicts', async () => {
  // Default scope. This is the case §11 describes and §2.7 makes reachable.
  const handle = createHandler(api, { seed: 'idem' }).fetch

  await handle(order('k2', '{"item":"a"}'))
  const response = await handle(order('k2', '{"item":"b"}'))

  assert.equal(response.status, 409)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'MOCK_IDEMPOTENCY_MISMATCH')
})

test('an operation with no key parameter is untouched', async () => {
  const handle = createHandler(api, { seed: 'idem' }).fetch
  const request = () =>
    new Request('http://mock/plain', { method: 'POST', headers: { 'idempotency-key': 'k' } })

  assert.equal((await handle(request())).status, 200)
  assert.equal((await handle(request())).status, 200)
})

test('a second request against an unresolved key is in flight', async () => {
  // Stage 11 does not store anything yet, so the first request's claim is still
  // outstanding when the second arrives. This is the honest end state of the
  // read half on its own - Task 7 turns this pair into a replay.
  const handle = createHandler(api, { seed: 'idem' }).fetch

  await handle(order('k1'))
  const second = await handle(order('k1'))

  assert.equal(second.status, 409)
  assert.equal(
    ((await second.json()) as { error: { code: string } }).error.code,
    'MOCK_IDEMPOTENCY_IN_FLIGHT'
  )
})
```

Every test here passes on this task's code alone. The replay tests belong to
Task 7, which is where the storage half that makes them pass is written.

- [ ] **Step 6: Run to verify they fail**

Run: `node --test test/server/idempotency.test.ts`

Expected: FAIL - nothing is wired into the pipeline yet, so the requests are
served normally and no 409 appears.

- [ ] **Step 7: Wire stage 5 into the handler**

In `src/server/handler.ts`, add to `HandlerOptions`:

```ts
  idempotency?: IdempotencyConfig
```

In `createHandler`, beside the other compiled options:

```ts
  const idempotency = resolveIdempotency(options.idempotency)
```

Add to `Trace`:

```ts
    /** Set by stage 5 when this request claimed a key; read by the single exit. */
    claimed?: { key: string; fingerprint: string }
```

In `produce`, insert stage 5 between validation and failure - after the
`validateRequests` block, before the `createFailureStage` push:

```ts
    // Stage 5 - idempotency lookup. After validation so a malformed request
    // never claims a key it will not be able to honor.
    stages.push(
      createIdempotencyStage({
        operation,
        config: idempotency,
        store,
        raw: parsed.body.raw,
        fail,
        claim: (claimedKey, claimedFingerprint) => {
          trace.claimed = { key: claimedKey, fingerprint: claimedFingerprint }
        }
      })
    )
```

Import `createIdempotencyStage` and `resolveIdempotency`, plus the
`IdempotencyConfig` type, from `../runtime/idempotency.ts`.

- [ ] **Step 8: Run to verify they pass**

Run: `node --test test/server/idempotency.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 9: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS. Confirm no pre-existing test broke.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 10: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: add the idempotency lookup stage' -m 'Stage 5 replays a stored response with Idempotent-Replay, conflicts on a fingerprint mismatch or an unresolved in-flight marker, and otherwise claims the key with a short-TTL marker. Both conflicts go through buildError so they stay on-contract.' -m 'Nothing stores a response yet, so a second request against a live claim is reported in flight. Stage 11 turns that pair into a replay in the next task.'
```

---

## Task 7: Stage 11 - capture and store

The write half, at the single exit, plus the boundary clearing from delta design
§2.4 and the 5xx ruling.

**Files:**
- Modify: `src/server/handler.ts` (the exit block)
- Test: `test/server/idempotency.test.ts` (extend)

**Interfaces:**
- Consumes: `Trace.claimed` from Task 6, `IdempotencyEntry` from Task 5.
- Produces: in `handler.ts`, `captureBody(response): Promise<string | null>` and
  the stage-11 block inside `handle`. Nothing new is exported.

- [ ] **Step 1: Write the failing tests**

Append to `test/server/idempotency.test.ts`. The first test is the load-bearing
one - Step 5 proves it can fail.

```ts
/**
 * A counter in the response is what makes the replay test able to fail.
 * Generation is deterministic, so two real executions already return identical
 * bytes - a replay test that only compares bodies passes with idempotency
 * removed entirely. Counting executions is the mechanism under test.
 */
function counting() {
  let runs = 0
  return {
    runs: () => runs,
    operations: {
      createOrder: {
        respond: (ctx: Ctx) => {
          runs += 1
          return ctx.respond(201, { run: runs })
        }
      }
    }
  }
}

test('a replay returns the first response byte-for-byte and does not re-execute', async () => {
  const spy = counting()
  const handle = createHandler(api, { seed: 'idem', operations: spy.operations }).fetch

  const first = await handle(order('k1'))
  const firstBody = await first.text()
  const second = await handle(order('k1'))
  const secondBody = await second.text()

  assert.equal(secondBody, firstBody)
  assert.equal(secondBody, '{"run":1}')
  assert.equal(spy.runs(), 1)
  assert.equal(first.headers.get('idempotent-replay'), null)
  assert.equal(second.headers.get('idempotent-replay'), 'true')
})

test('config.methods enables an operation the document did not mark', async () => {
  const handle = createHandler(api, {
    seed: 'idem',
    idempotency: { methods: ['POST'] }
  }).fetch
  const request = () =>
    new Request('http://mock/plain', { method: 'POST', headers: { 'idempotency-key': 'k9' } })

  await handle(request())
  assert.equal((await handle(request())).headers.get('idempotent-replay'), 'true')
})

test('a claimed key is released when the request throws', async () => {
  // The wedge case: without this, every retry sees a marker that never resolves.
  let attempts = 0
  const handle = createHandler(api, {
    seed: 'idem',
    operations: {
      createOrder: {
        respond: (ctx) => {
          attempts += 1
          if (attempts === 1) throw new Error('boom')
          return ctx.respond(201, { ok: true })
        }
      }
    }
  }).fetch

  assert.equal((await handle(order('k3'))).status, 500)
  const retry = await handle(order('k3'))

  assert.equal(retry.status, 201)
  assert.equal(attempts, 2)
})

test('a 5xx is not stored, so a retry re-runs', async () => {
  let attempts = 0
  const handle = createHandler(api, {
    seed: 'idem',
    decide: () => (attempts === 0 ? { status: 503 } : undefined),
    operations: {
      createOrder: {
        respond: (ctx) => {
          attempts += 1
          return ctx.respond(201, { ok: true })
        }
      }
    }
  }).fetch

  assert.equal((await handle(order('k4'))).status, 503)
  assert.equal((await handle(order('k4'))).status, 503)
})

test('a 4xx IS stored and replays', async () => {
  // A client error is a real answer to the key. Only 5xx is excluded, because a
  // 5xx is precisely what the caller retries the key to survive.
  const handle = createHandler(api, {
    seed: 'idem',
    operations: { createOrder: { respond: (ctx) => ctx.respond(422, { bad: true }) } }
  }).fetch

  assert.equal((await handle(order('k5'))).status, 422)
  const replay = await handle(order('k5'))

  assert.equal(replay.status, 422)
  assert.equal(replay.headers.get('idempotent-replay'), 'true')
})

test('a stored record expires', async () => {
  let value = 0
  let runs = 0
  const handle = createHandler(api, {
    seed: 'idem',
    now: () => value,
    idempotency: { ttlMs: 1_000 },
    operations: {
      createOrder: {
        respond: (ctx) => {
          runs += 1
          return ctx.respond(201, { run: runs })
        }
      }
    }
  }).fetch

  await handle(order('k6'))
  value += 2_000
  await handle(order('k6'))

  assert.equal(runs, 2)
})
```

**Delete Task 6's `'a second request against an unresolved key is in flight'`
test in the same commit.** It asserted the honest end state of the read half
alone; storage is exactly what changes that pair into a replay, so leaving it
would be asserting the bug. In-flight is still covered - by the unit test in
`test/runtime/idempotency.test.ts` that drives the marker directly, which is what
the design §5 asks for rather than racing two real requests.

The `decide` in the 5xx test fires on the first call only because `attempts` is
still 0 then; the second call sees `attempts === 0` as well, since the first
request never reached the callback. That is the intended assertion - both calls
return 503 and neither is replayed. If the closure reads awkwardly during
implementation, use a separate counter incremented inside `decide` and assert the
second 503 carries no `Idempotent-Replay` header instead.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server/idempotency.test.ts`

Expected: FAIL - the replay test's second request returns
`409 MOCK_IDEMPOTENCY_IN_FLIGHT` instead of the stored response, the throw test's
retry hits the same wedged marker, and the 4xx test does not replay.

- [ ] **Step 3: Implement stage 11's storage half**

In `src/server/handler.ts`, add the capture helper above `handle`:

```ts
  /**
   * The response body as a string, read from a clone. A `Response` body is
   * one-shot: reading the original to store it would consume it before the
   * caller ever saw it. A null body (a 204, say) stays null rather than becoming
   * an empty string, so a replay reproduces "no body" rather than "empty body".
   */
  async function captureBody(response: Response): Promise<string | null> {
    if (response.body === null) return null
    return await response.clone().text()
  }

  function headersOf(response: Response): Record<string, string> {
    const out: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      out[name] = value
    })
    return out
  }
```

Then fill in the exit block in `handle`:

```ts
    // ── Stage 11 ──
    const claimed = trace.claimed
    if (claimed !== undefined) {
      // A 5xx is never stored. Storing a chaos-injected 503 would make every
      // retry replay that 503 until the TTL expired, defeating the retry the
      // idempotency key exists to make safe. Releasing the key on a throw is the
      // other half of the wedge fix from the phases 7-9 design §2.4 - the TTL
      // covers a process that dies, this covers a callback that threw.
      if (trace.error !== undefined || response.status >= 500) {
        await store.delete(claimed.key)
      } else {
        await store.set(
          claimed.key,
          {
            state: 'done',
            fingerprint: claimed.fingerprint,
            status: response.status,
            headers: headersOf(response),
            body: await captureBody(response)
          },
          idempotency.ttlMs
        )
      }
    }

    return response
```

- [ ] **Step 4: Run the idempotency tests**

Run: `node --test test/server/idempotency.test.ts`

Expected: PASS, all 8 tests.

- [ ] **Step 5: Prove the replay test can fail**

Comment out the `await store.set(...)` call in the block above, run
`node --test test/server/idempotency.test.ts`, and confirm the replay test fails
with `spy.runs()` equal to 2 rather than 1. Restore the line. **Report the exact
failure message** - this is the mutation observation the test-quality bar
requires, and the replay test is precisely the shape that has slipped through
before.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: store idempotency records at the single exit' -m 'Stage 11 captures the body from a clone before the response is returned, then stores status, headers, body, and fingerprint under the claimed key. A 5xx or a throw deletes the marker instead, so the retry re-runs rather than replaying a failure.' -m 'Phase 7 is complete.'
```

---

## Task 8: Logging

Phase 9's first half. Master spec §12, delta design §4.

**Files:**
- Modify: `src/runtime/logging.ts` (`LogRecord`, `emitLog`)
- Modify: `src/server/handler.ts` (`onLog`, `onError`, the exit block)
- Test: `test/runtime/logging.test.ts` (extend)
- Create: `test/server/logging.test.ts`

**Interfaces:**
- Consumes: `Decisions` (Task 4), `Trace` (Task 1), `requestIdFor` (Task 3).
- Produces:
  - `interface LogRecord` - the §12 shape
  - `type LogSink = (record: LogRecord) => void | Promise<void>`
  - `type ErrorSink = (error: unknown, ctx?: Ctx) => void`
  - `emitLog(sink: LogSink | undefined, record: LogRecord, onError?: ErrorSink): void`
  - `reportError(sink: ErrorSink | undefined, error: unknown, ctx?: Ctx): void`
  - `HandlerOptions.onLog?: LogSink`, `HandlerOptions.onError?: ErrorSink`

- [ ] **Step 1: Write the failing unit tests**

Append to `test/runtime/logging.test.ts`:

```ts
import { emitLog, reportError } from '../../src/runtime/logging.ts'
import type { LogRecord } from '../../src/runtime/logging.ts'

const record = (): LogRecord => ({
  ts: 0, durationMs: 0, requestId: 'r', method: 'GET', route: '/x', path: '/x',
  status: 200, bytesIn: 0, bytesOut: 0, params: {}, query: {}, seed: 's',
  decisions: {}, custom: {}
})

test('emitLog does nothing without a sink', () => {
  assert.doesNotThrow(() => emitLog(undefined, record()))
})

test('emitLog isolates a throwing sink', () => {
  const seen: unknown[] = []
  assert.doesNotThrow(() =>
    emitLog(() => { throw new Error('sink exploded') }, record(), (error) => seen.push(error))
  )
  assert.equal((seen[0] as Error).message, 'sink exploded')
})

test('emitLog isolates a rejecting sink', async () => {
  // An explicit .catch(), not a floating promise: an unhandled rejection can
  // take the process down, which is the opposite of error isolation.
  const seen: unknown[] = []
  emitLog(async () => { throw new Error('async explosion') }, record(), (error) => seen.push(error))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((seen[0] as Error).message, 'async explosion')
})

test('emitLog survives a throwing error sink', () => {
  assert.doesNotThrow(() =>
    emitLog(() => { throw new Error('a') }, record(), () => { throw new Error('b') })
  )
})

test('emitLog does not await the sink', () => {
  // Fire-and-forget: a slow logger must not delay the response.
  let settled = false
  emitLog(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    settled = true
  }, record())
  assert.equal(settled, false)
})

test('reportError isolates a throwing handler', () => {
  assert.doesNotThrow(() => reportError(() => { throw new Error('x') }, new Error('y')))
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/runtime/logging.test.ts`

Expected: FAIL - `emitLog is not a function`.

- [ ] **Step 3: Add the record and the sinks**

Append to `src/runtime/logging.ts`:

```ts
import type { Ctx, Decisions } from './types.ts'

/**
 * Master spec §12, shaped for direct mapping onto Datadog/OTel-style sinks:
 * low-cardinality fields (`route`, `status`, `operationId`) are safe as tags,
 * high-cardinality ones (`path`, `params`, `query`, `requestId`) are not.
 *
 * `ts` and `durationMs` come from the injected clock. They sit outside the
 * determinism invariant because a log record is an observational side channel
 * that never enters a response - see the phases 7-9 design §2.1.
 */
export interface LogRecord {
  ts: number
  durationMs: number
  requestId: string
  method: string
  /** The TEMPLATED path - a bounded tag. `'<unmatched>'` when no route matched. */
  route: string
  /** The resolved path - high cardinality, never a tag. */
  path: string
  status: number
  bytesIn: number
  /** The serialized body length. Headers are not counted. */
  bytesOut: number
  params: Record<string, string>
  query: Record<string, string | string[]>
  seed: string
  operationId?: string
  decisions: Decisions
  error?: string
  /** `ctx.log` contributions. */
  custom: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void | Promise<void>
export type ErrorSink = (error: unknown, ctx?: Ctx) => void

/** An error sink that itself throws must not become the failure it reports. */
export function reportError(sink: ErrorSink | undefined, error: unknown, ctx?: Ctx): void {
  if (sink === undefined) return
  try {
    sink(error, ctx)
  } catch {
    // Nowhere left to report to.
  }
}

/**
 * Fire-and-forget with error isolation: a throwing or rejecting logger must
 * never affect the response. The explicit `.catch()` matters - a bare floating
 * promise turns a logger's rejection into an unhandled rejection, which can take
 * the process down.
 */
export function emitLog(sink: LogSink | undefined, record: LogRecord, onError?: ErrorSink): void {
  if (sink === undefined) return
  try {
    const result = sink(record)
    if (result !== undefined && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch((error) => reportError(onError, error))
    }
  } catch (error) {
    reportError(onError, error)
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/runtime/logging.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing integration tests**

Create `test/server/logging.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { LogRecord } from '../../src/runtime/logging.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    },
    '/notes': {
      post: {
        operationId: 'createNote',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'created' } }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
})

function collector() {
  const records: LogRecord[] = []
  return { records, onLog: (record: LogRecord) => { records.push(record) } }
}

test('a short-circuited response is logged', async () => {
  // THE test this whole refactor exists for. A 401 never reaches the renderer,
  // so before the single exit there was nowhere to observe it - and a 401 is
  // exactly the record an operator most wants.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/pets/7'))

  assert.equal(sink.records.length, 1)
  const record = sink.records[0]!
  assert.equal(record.status, 401)
  assert.equal(record.route, '/pets/{id}')
  assert.equal(record.path, '/pets/7')
  assert.equal(record.operationId, 'getPet')
  assert.deepEqual(record.params, { id: '7' })
  assert.equal(record.decisions.auth, 'denied')
  // Auth answered first, so validation never ran and records nothing.
  assert.equal(record.decisions.validation, undefined)
})

test('an unmatched route is logged too', async () => {
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/nope'))

  const record = sink.records[0]!
  assert.equal(record.status, 404)
  assert.equal(record.route, '<unmatched>')
  assert.equal(record.path, '/nope')
  assert.equal(record.operationId, undefined)
})

test('a rendered response carries byte counts and ctx.log contributions', async () => {
  const sink = collector()
  const handle = createHandler(api, {
    seed: 'log',
    onLog: sink.onLog,
    operations: {
      getPet: {
        respond: (ctx) => {
          ctx.log['tenant'] = 'acme'
          return ctx.respond(200, { ok: true })
        }
      }
    }
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7?limit=2', { headers: { authorization: 'Bearer t' } })
  )
  const body = await response.text()

  const record = sink.records[0]!
  assert.equal(record.status, 200)
  assert.equal(record.bytesOut, new TextEncoder().encode(body).length)
  assert.deepEqual(record.query, { limit: '2' })
  assert.deepEqual(record.custom, { tenant: 'acme' })
  assert.equal(record.seed, 'log')
  assert.equal(record.requestId.length, 16)
})

test('durationMs is measured exactly under an injected clock', async () => {
  // The failure stage's `sleep` is injectable, so advancing the fake clock from
  // inside it produces an exact duration rather than a tolerance window.
  let value = 5_000
  const sink = collector()
  const handle = createHandler(api, {
    seed: 'log',
    now: () => value,
    sleep: async (ms) => { value += ms },
    failure: [{ match: '*', latency: 42 }],
    onLog: sink.onLog
  }).fetch

  await handle(new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } }))

  const record = sink.records[0]!
  assert.equal(record.ts, 5_000)
  assert.equal(record.durationMs, 42)
})

test('a throwing logger does not affect the response', async () => {
  const seen: unknown[] = []
  const handle = createHandler(api, {
    seed: 'log',
    onLog: () => { throw new Error('logger down') },
    onError: (error) => seen.push(error)
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } })
  )

  assert.equal(response.status, 200)
  assert.equal((seen[0] as Error).message, 'logger down')
})

test('an internal fault reaches onError and is still logged', async () => {
  const sink = collector()
  const seen: unknown[] = []
  const handle = createHandler(api, {
    seed: 'log',
    onLog: sink.onLog,
    onError: (error) => seen.push(error),
    operations: { getPet: { respond: () => { throw new Error('callback boom') } } }
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } })
  )

  assert.equal(response.status, 500)
  assert.equal((seen[0] as Error).message, 'callback boom')
  assert.equal(sink.records[0]!.status, 500)
  assert.equal(sink.records[0]!.error, 'callback boom')
})

test('bytesIn counts the raw request bytes, not its characters', async () => {
  // A multi-byte body is what separates a byte count from a string length. A
  // test with an ASCII body passes either way, and a bodyless GET passes with
  // bytesIn hardcoded to 0.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch
  const body = '{"note":"café"}'

  await handle(
    new Request('http://mock/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    })
  )

  assert.equal(new TextEncoder().encode(body).length, 16)
  assert.equal(body.length, 15)
  assert.equal(sink.records[0]!.bytesIn, 16)
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `node --test test/server/logging.test.ts`

Expected: FAIL - `onLog` is not a known option and no record is ever emitted.

- [ ] **Step 7: Wire logging into the single exit**

In `src/server/handler.ts`, add to `HandlerOptions`:

```ts
  onLog?: LogSink
  onError?: ErrorSink
```

Extend `handle`:

```ts
  async function handle(request: Request): Promise<Response> {
    const startedAt = now()
    const trace: Trace = { params: {}, requestKey: seed, bytesIn: 0 }

    let response: Response
    try {
      response = await produce(request, trace)
    } catch (error) {
      trace.error = error
      reportError(options.onError, error, trace.ctx)
      response = internalError(error)
    }

    // ── Stage 11 ──
    // The body is read at most once, from a clone, and only when something needs
    // it: an idempotency record to store, or a `bytesOut` to report.
    const claimed = trace.claimed
    const needsBody = claimed !== undefined || options.onLog !== undefined
    const captured = needsBody ? await captureBody(response) : null

    if (claimed !== undefined) {
      if (trace.error !== undefined || response.status >= 500) {
        await store.delete(claimed.key)
      } else {
        await store.set(
          claimed.key,
          {
            state: 'done',
            fingerprint: claimed.fingerprint,
            status: response.status,
            headers: headersOf(response),
            body: captured
          },
          idempotency.ttlMs
        )
      }
    }

    if (options.onLog !== undefined) {
      const url = new URL(request.url)
      emitLog(
        options.onLog,
        {
          ts: startedAt,
          durationMs: now() - startedAt,
          requestId: trace.ctx?.requestId ?? requestIdFor(trace.requestKey, 0),
          method: request.method,
          // A bounded value rather than the raw path: an unmatched path is
          // unbounded, and this field is meant to be safe as a metric tag.
          route: trace.operation?.path ?? '<unmatched>',
          path: url.pathname,
          status: response.status,
          bytesIn: trace.bytesIn,
          bytesOut: captured === null ? 0 : new TextEncoder().encode(captured).length,
          params: trace.params,
          query: trace.ctx?.query ?? {},
          seed,
          operationId: trace.operation?.operationId,
          decisions: trace.ctx?.decisions ?? {},
          error:
            trace.error === undefined
              ? undefined
              : trace.error instanceof Error
                ? trace.error.message
                : String(trace.error),
          custom: trace.ctx?.log ?? {}
        },
        options.onError
      )
    }

    return response
  }
```

Delete the now-duplicated storage block from Task 7 - it moves inside this one so
the body is captured exactly once. Import `emitLog`, `reportError`, `requestIdFor`
and the `LogSink` / `ErrorSink` types from `../runtime/logging.ts`.

- [ ] **Step 8: Run the logging tests**

Run: `node --test test/server/logging.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 9: Prove the short-circuit test can fail**

Move the `emitLog` call from `handle` into `produce`'s final `return` path (so
only rendered responses log), run `node --test test/server/logging.test.ts`, and
confirm the 401 and 404 tests fail with `sink.records.length` equal to 0. Restore
it. **Report the exact failure message** - this is the observation that proves the
single exit is load-bearing rather than decorative.

- [ ] **Step 10: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 11: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: emit a log record for every response' -m 'onLog fires at the single exit, so a 401 from auth, a 503 from chaos, a 404 with no operation, and the boundary 500 are all recorded - not only rendered responses. onError stays separate so an operator can route internal faults differently.' -m 'The sink is fire-and-forget with an explicit catch: a floating promise would turn a rejecting logger into an unhandled rejection. The response body is read once from a clone and shared between the log record and the idempotency record.'
```

---

## Task 9: Circuit decay and per-policy circuit keys

Deferred items 4 and 5, pulled into this plan by the user's ruling. Neither is in
the phases 7–9 design; both are in `docs/superpowers/deferred-items.md`.

**Item 4:** `circuit-count` has no TTL, so it never decays - a policy with
`after: 5` eventually trips from failures accumulated across the whole process
lifetime rather than within any window. **Item 5:** circuit keys are scoped by
operation, so two policies each carrying a `circuit` block and matching the same
operation share one counter and one open-state.

**The design:** `CircuitPolicy` gains `within?: number`, the window in
milliseconds over which failures accumulate, defaulting to `openFor` - with no
explicit window the natural scale is the same as how long the circuit stays open.
The counter is armed with that TTL on the **first** failure and left alone
afterward, giving a fixed window from the first failure rather than a sliding one
that never expires under sustained load. `Store.incr` preserves an existing
deadline and cannot arm one (see the comment in `store.ts`), which is exactly the
behavior this needs.

Policy identity is the compiled index plus the target string. Policies are
anonymous object literals with no natural id, and the index is stable for the
lifetime of a handler because `compilePolicies` runs once at construction.

**Files:**
- Modify: `src/runtime/failure.ts`
- Test: `test/runtime/failure.test.ts` (extend)

**Interfaces:**
- Consumes: `Store` (`src/runtime/store.ts`).
- Produces:
  - `CircuitPolicy.within?: number`
  - `compilePolicies` entries gain `id: string` (`${index}|${policy.match}`)
  - Store keys become `circuit-open|${id}|${targetKey}` and `circuit-count|${id}|${targetKey}`

These keys are read and written only inside `failure.ts` - confirmed by grep, no
other module or test references them.

- [ ] **Step 1: Write the failing tests**

`test/runtime/failure.test.ts` already has a local `compile()` helper that
deliberately skips `compilePolicies`' construction-time check, and an `input()`
factory. `compile()` must gain the id alongside the production change:

```ts
function compile(policies: FailurePolicy[]) {
  return policies.map((policy, index) => ({
    id: `${index}|${policy.match}`,
    matches: compileTarget(policy.match).matches,
    policy
  }))
}
```

The file's fixture operation has `operationId: 'x'`, so `targetKey(operation)` is
`'x'` and the namespaced keys read `circuit-open|0|x`. Append:

```ts
test('the circuit counter decays after its window', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 503, within: 500 } }
  ]

  const { args } = input({ policies, store, counter: () => 1 })
  await checkFailure(args)
  value += 600
  // The first failure aged out of the window, so this one starts a new count
  // and the circuit does not open.
  await checkFailure(input({ policies, store, counter: () => 2 }).args)

  assert.equal(await store.get('circuit-open|0|x'), undefined)
  assert.equal(await store.get('circuit-count|0|x'), 1)
})

test('the circuit opens inside its window', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 503, within: 500 } }
  ]

  await checkFailure(input({ policies, store, counter: () => 1 }).args)
  value += 100
  await checkFailure(input({ policies, store, counter: () => 2 }).args)

  assert.equal(await store.get('circuit-open|0|x'), true)
})

test('within defaults to openFor', async () => {
  let value = 0
  const store = createMemoryStore(() => value)
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 400, then: 503 } }
  ]

  await checkFailure(input({ policies, store, counter: () => 1 }).args)
  value += 500
  await checkFailure(input({ policies, store, counter: () => 2 }).args)

  assert.equal(await store.get('circuit-open|0|x'), undefined)
})

test('two policies matching one operation keep separate circuits', async () => {
  const store = createMemoryStore()
  // NOTE the second target's spelling. A bare '*' has no space in it, so
  // `compileTarget` reads it as an operationId and it matches NOTHING - which
  // would make the second assertion below pass for entirely the wrong reason.
  // '* /x' is the match-any-method form. See src/resolve/target.ts.
  const policies: FailurePolicy[] = [
    { match: 'x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 503 } },
    { match: '* /x', rate: 1, circuit: { after: 2, openFor: 1_000, then: 504 } }
  ]

  await checkFailure(input({ policies, store, counter: () => 1 }).args)

  // Both policies match this operation, but the first one fired and returned,
  // so only its counter moved - and it moved under its OWN key. Sharing one key
  // per operation is the bug: the second policy's failures would land on the
  // first policy's counter and open a circuit neither policy asked for.
  assert.equal(await store.get('circuit-count|0|x'), 1)
  assert.equal(await store.get('circuit-count|1|* /x'), undefined)
})

test('a bare star target matches nothing, so the fixture above is honest', () => {
  // Guards the note above: if compileTarget ever started treating a bare '*' as
  // a wildcard, the previous test would still pass but would stop proving what
  // it claims. This is the canary for that.
  assert.equal(compileTarget('*').matches(operation), false)
  assert.equal(compileTarget('* /x').matches(operation), true)
})
```

`input()` takes `store` and `counter` overrides through its `...rest` spread, so
no change to that helper is needed.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/runtime/failure.test.ts`

Expected: FAIL - the keys are `circuit-open|getPet` with no policy id, so every
`store.get('circuit-open|0|getPet')` returns `undefined`, and the decay test fails
because the counter never expires (the circuit opens when it should not).

- [ ] **Step 3: Add `within` and the policy id**

In `src/runtime/failure.ts`:

```ts
export interface CircuitPolicy {
  after: number
  openFor: number
  then: number
  /**
   * The window over which failures accumulate, in milliseconds. Without one the
   * counter never decays and `after: 5` eventually trips from failures spread
   * across the whole process lifetime rather than within any window. Defaults to
   * `openFor`: with no explicit window, the natural scale is how long the
   * circuit stays open once it trips.
   */
  within?: number
}
```

Change `compilePolicies` to attach an id:

```ts
export function compilePolicies(
  policies: FailurePolicy[] | undefined,
  known: Operation[]
): Array<{ id: string; matches(operation: Operation): boolean; policy: FailurePolicy }> {
  return (policies ?? []).map((policy, index) => {
    const matcher = compileTarget(policy.match)
    if (!known.some((operation) => matcher.matches(operation))) {
      throw new Error(
        `mockingham: failure policy target "${policy.match}" matches no operation ` +
          'in the document.'
      )
    }
    // Policies are anonymous literals with no natural identity. The compiled
    // index is stable for a handler's lifetime, and pairing it with the target
    // keeps a store key readable when you are staring at one in Redis.
    return { id: `${index}|${policy.match}`, matches: matcher.matches, policy }
  })
}
```

Update `FailureInput['policies']` to match.

Add the counter helper above `checkFailure`:

```ts
/**
 * A fixed window from the first failure: arm the TTL on the first increment and
 * leave it alone afterward. `Store.incr` preserves an existing deadline and
 * cannot arm one, which is exactly right here - re-arming on every failure would
 * give a sliding window that never expires under sustained load.
 */
async function bumpCircuit(store: Store, key: string, within: number): Promise<number> {
  const current = await store.get(key)
  if (typeof current !== 'number') {
    await store.set(key, 1, within)
    return 1
  }
  return await store.incr(key)
}
```

Then in `checkFailure`, replace the loop body's circuit handling. The loop must
iterate the compiled entries rather than the bare policies, so change:

```ts
  const matching = input.policies.filter((entry) => entry.matches(input.operation))
```

and inside the loop use `entry.policy` and `entry.id`:

```ts
  for (const entry of matching) {
    const policy = entry.policy
    const openKey = `circuit-open|${entry.id}|${key}`
    const countKey = `circuit-count|${entry.id}|${key}`

    // 4. Circuit state, before rolling - an open circuit answers immediately.
    if (policy.circuit) {
      const open = await input.store.get(openKey)
      if (open !== undefined) {
        return failure(policy.circuit.then, 'Circuit is open')
      }
    }

    // 5. Rate.
    if (policy.rate !== undefined && policy.rate > 0) {
      const seed = fnv1a(`${input.chaosSeed}|${input.requestKey}|${input.counter()}`)
      if (createRng(seed).next() < policy.rate) {
        if (policy.circuit) {
          const window = policy.circuit.within ?? policy.circuit.openFor
          const failures = await bumpCircuit(input.store, countKey, window)
          if (failures >= policy.circuit.after) {
            await input.store.set(openKey, true, policy.circuit.openFor)
            await input.store.delete(countKey)
          }
        }
        return failure(policy.respond ?? DEFAULT_STATUS, 'Failure injected by rate')
      }
    }
  }
```

The latency loop below it also iterates `matching`; update it to read
`entry.policy` too.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/runtime/failure.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS. Any existing failure test that reached into the store for a
circuit key must be updated to the namespaced spelling - that is a legitimate
edit, since the key convention is what changed.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit**

```sh
git add -A
```

```sh
git commit -m 'fix: give the circuit breaker a window and per-policy keys' -m 'CircuitPolicy.within bounds how long failures accumulate, defaulting to openFor; the counter is armed with that TTL on the first failure, so the window is fixed rather than sliding. Without it, after: 5 tripped from failures spread across the whole process lifetime.' -m 'Circuit keys now carry the compiled policy id, so two policies matching the same operation no longer share one counter and one open-state. Settles deferred items 4 and 5.'
```

---

## Task 10: The CLI

Phase 9's second half, delta design §4. `src/server/cli.ts` wraps `listen`. It is
the first module allowed to read `process.argv` and the filesystem, and it stays
out of the pure core.

**Files:**
- Create: `src/server/cli.ts`
- Create: `test/server/cli.test.ts`
- Modify: `package.json` (`bin`)

**Interfaces:**
- Consumes: `loadApi` (`src/spec/load.ts`), `createHandler`
  (`src/server/handler.ts`), `createNodeServer` (`src/server/node.ts`).
- Produces:
  - `parseArgs(argv: string[]): CliArgs` where
    `interface CliArgs { document?: string; port: number; seed?: string; watch: boolean; help: boolean }`
  - `startCli(argv: string[], deps?: Partial<CliDeps>): Promise<CliHandle>` where
    `interface CliDeps { readFile: (path: string) => Promise<string>; log: (message: string) => void }`
    and `interface CliHandle { url: string; port: number; watching: boolean; reload(): Promise<void>; close(): Promise<void> }`
  - `USAGE: string`

**Why `reload()` is on the handle:** testing `--watch` by editing a file and
racing an `fs.watch` callback is flaky by construction. The watcher's only job is
to call `reload()`, so the test calls `reload()` directly and asserts the served
response changed, plus a separate assertion that `--watch` installed a watcher at
all. Deterministic, no timers.

- [ ] **Step 1: Write the failing tests**

Create `test/server/cli.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, startCli, USAGE } from '../../src/server/cli.ts'

const doc = (title: string) => JSON.stringify({
  openapi: '3.1.0',
  info: { title, version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string', const: title } }, required: ['title'] } } }
          }
        }
      }
    }
  }
})

test('parseArgs reads a document path and defaults', () => {
  assert.deepEqual(parseArgs(['api.json']), {
    document: 'api.json', port: 0, seed: undefined, watch: false, help: false
  })
})

test('parseArgs reads every flag', () => {
  assert.deepEqual(parseArgs(['api.json', '--port', '4000', '--seed', 's', '--watch']), {
    document: 'api.json', port: 4000, seed: 's', watch: true, help: false
  })
})

test('parseArgs accepts --flag=value', () => {
  assert.equal(parseArgs(['api.json', '--port=4000']).port, 4000)
})

test('parseArgs recognizes help', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

test('parseArgs rejects a non-numeric port', () => {
  assert.throws(() => parseArgs(['api.json', '--port', 'soon']), /--port/)
})

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['api.json', '--colour']), /--colour/)
})

test('startCli refuses a YAML document with a useful message', async () => {
  await assert.rejects(
    startCli(['api.yaml'], { readFile: async () => '', log: () => {} }),
    /YAML/
  )
})

test('startCli refuses a missing document argument', async () => {
  await assert.rejects(startCli([], { log: () => {} }), /document/)
})

test('startCli serves the document over a real port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-cli-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('first'))

  const lines: string[] = []
  const handle = await startCli([path, '--seed', 'cli'], { log: (line) => lines.push(line) })

  const response = await fetch(`${handle.url}/ping`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { title: 'first' })
  assert.ok(lines.some((line) => line.includes(handle.url)))
  assert.equal(handle.watching, false)

  await handle.close()
})

test('reload picks up an edited document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-cli-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('first'))

  const handle = await startCli([path, '--watch'], { log: () => {} })
  assert.equal(handle.watching, true)

  await writeFile(path, doc('second'))
  await handle.reload()

  assert.deepEqual(await (await fetch(`${handle.url}/ping`)).json(), { title: 'second' })
  await handle.close()
})

test('a broken edit leaves the previous document serving', async () => {
  // Invariant 4's spirit: the mock keeps serving. A half-saved file must not
  // take the server down.
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-cli-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('first'))

  const errors: string[] = []
  const handle = await startCli([path, '--watch'], { log: (line) => errors.push(line) })

  await writeFile(path, '{ not json')
  await handle.reload()

  assert.deepEqual(await (await fetch(`${handle.url}/ping`)).json(), { title: 'first' })
  assert.ok(errors.some((line) => line.toLowerCase().includes('reload')))
  await handle.close()
})

test('USAGE names every flag', () => {
  for (const flag of ['--port', '--seed', '--watch', '--help']) {
    assert.ok(USAGE.includes(flag), `USAGE is missing ${flag}`)
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server/cli.test.ts`

Expected: FAIL - cannot find module `src/server/cli.ts`.

- [ ] **Step 3: Create `src/server/cli.ts`**

```ts
#!/usr/bin/env node
import { readFile as readFileFromDisk } from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { loadApi } from '../spec/load.ts'
import { createHandler } from './handler.ts'
import type { Handler } from './handler.ts'
import { createNodeServer } from './node.ts'

export const USAGE = `mockingham - OpenAPI driven HTTP mock server

  mockingham <document.json> [options]

  --port <n>    Port to listen on (default: an ephemeral port)
  --seed <s>    Generation seed (default: mockingham)
  --watch       Reload the document when it changes on disk
  --help, -h    Show this message

YAML is not parsed. Convert the document to JSON first, or use createMock()
from a script and pass the parsed object in.
`

export interface CliArgs {
  document?: string
  port: number
  seed?: string
  watch: boolean
  help: boolean
}

const NEEDS_VALUE = new Set(['--port', '--seed'])

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { document: undefined, port: 0, seed: undefined, watch: false, help: false }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (token === '--watch') {
      args.watch = true
      continue
    }

    if (token.startsWith('--')) {
      // `--flag=value` and `--flag value` are both common enough that supporting
      // only one guarantees someone hits the other first.
      const split = token.indexOf('=')
      const name = split === -1 ? token : token.slice(0, split)
      if (!NEEDS_VALUE.has(name)) {
        throw new Error(`mockingham: unknown option ${name}\n\n${USAGE}`)
      }
      const value = split === -1 ? argv[++i] : token.slice(split + 1)
      if (value === undefined) {
        throw new Error(`mockingham: ${name} needs a value`)
      }
      if (name === '--port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`mockingham: --port must be a port number, got "${value}"`)
        }
        args.port = port
      } else {
        args.seed = value
      }
      continue
    }

    if (args.document !== undefined) {
      throw new Error(`mockingham: unexpected argument "${token}"`)
    }
    args.document = token
  }

  return args
}

export interface CliDeps {
  readFile: (path: string) => Promise<string>
  log: (message: string) => void
}

export interface CliHandle {
  url: string
  port: number
  watching: boolean
  /** Re-reads the document and swaps the handler. The watcher's only job. */
  reload(): Promise<void>
  close(): Promise<void>
}

export async function startCli(
  argv: string[],
  deps: Partial<CliDeps> = {}
): Promise<CliHandle> {
  const readFile = deps.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  const log = deps.log ?? ((message: string) => console.log(message))

  const args = parseArgs(argv)
  if (args.help) {
    log(USAGE)
    throw new Error('mockingham: nothing to serve')
  }
  if (args.document === undefined) {
    throw new Error(`mockingham: a document path is required\n\n${USAGE}`)
  }
  if (args.document.endsWith('.yaml') || args.document.endsWith('.yml')) {
    throw new Error(
      'mockingham: YAML documents are not parsed. Convert to JSON, or call ' +
        'createMock() from a script with the document already parsed.'
    )
  }

  const path = args.document

  const build = async (): Promise<Handler> => {
    const text = await readFile(path)
    return createHandler(loadApi(JSON.parse(text) as Record<string, unknown>), {
      seed: args.seed
    })
  }

  let current = await build()
  // The dispatcher closes over `current` rather than over its `fetch`, so a
  // reload swaps the handler without touching the listening socket.
  const server = createNodeServer((request) => current.fetch(request))
  const address = await server.listen(args.port)

  let watcher: FSWatcher | undefined

  const handle: CliHandle = {
    url: address.url,
    port: address.port,
    watching: args.watch,
    async reload() {
      try {
        current = await build()
        log(`mockingham: reloaded ${path}`)
      } catch (error) {
        // A half-saved file must not take the server down. Keep serving the
        // last document that loaded and say why.
        const message = error instanceof Error ? error.message : String(error)
        log(`mockingham: reload failed, still serving the previous document - ${message}`)
      }
    },
    async close() {
      watcher?.close()
      await server.close()
    }
  }

  if (args.watch) {
    watcher = watch(path, () => {
      void handle.reload()
    })
  }

  log(`mockingham: serving ${path} at ${address.url}`)
  return handle
}

if (import.meta.main) {
  try {
    await startCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
```

`import.meta.main` is available in Node 24 (verified on v24.18.0), which is the
engine floor.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/server/cli.test.ts`

Expected: PASS, 12 tests.

- [ ] **Step 5: Add the `bin` entry**

In `package.json`, after `"main"`:

```json
  "bin": {
    "mockingham": "src/server/cli.ts"
  },
```

- [ ] **Step 6: Smoke-test the binary**

Run: `node src/server/cli.ts --help`

Expected: the usage text, exit code 1 (there is nothing to serve). Node strips the
types and honors the shebang.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 8: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: add the CLI' -m 'mockingham <document.json> with --port, --seed, and --watch. The dispatcher closes over the handler rather than its fetch, so --watch swaps the document without touching the listening socket, and a malformed edit keeps the previous document serving.' -m 'YAML stays a non-goal: the CLI says so and tells the caller what to do instead. Phase 9 is complete.'
```

---

## Task 11: Record the rulings

Documentation is not optional here. `docs/superpowers/deferred-items.md` exists
because the SDD ledgers live in gitignored worktree scratch, and every ruling this
plan made needs to outlive the worktree.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-mockingham-phases-7-9-design.md`
- Modify: `docs/superpowers/deferred-items.md`
- Modify: `CLAUDE.md` (one line, if the CLI changes the operating manual)

- [ ] **Step 1: Amend the design spec**

Change the header from `**Status:** draft, awaiting approval.` to
`**Status:** approved; implemented by plan 5 (2026-08-12-mockingham-idempotency-logging.md).`

Add two subsections to §2:

```markdown
### 2.6 A 5xx is never stored as an idempotency record

§11 does not say whether a failed response becomes the record. Storing a
chaos-injected 503 would make every retry replay that 503 until the TTL expired,
which defeats the retry the idempotency key exists to make safe.

**Stage 11 stores a response only when `status < 500`.** On a 5xx, or on a throw,
it deletes the in-flight marker instead, so the retry re-runs the operation. A
4xx IS stored: a client error is a real answer to the key, and the caller
resending the same key deserves the same answer.

### 2.7 `bodyHash` is compared, not keyed

§11 gives `scope: ['key', 'route', 'bodyHash']` as the default **and** specifies a
409 for "same key, different body fingerprint". Both cannot hold: with the
fingerprint in the storage key, a different body computes a different key, the
lookup misses, the request is treated as a first request, and
`MOCK_IDEMPOTENCY_MISMATCH` is unreachable under its own default.

**The storage key is composed from `key` and `route` only. `bodyHash` in the
scope means the stored fingerprint is compared on lookup**, and a difference is
the 409. Dropping `bodyHash` from the scope then means "replay regardless of
body", which is a coherent thing for a caller to ask for. All of §11 is live at
once under this reading.

`resolveIdempotency` throws when the scope contains neither `key` nor `route`,
since every request in the document would otherwise share one record.

### 2.8 The single exit is `handle()`, not a single `return`

Deferred item 1 asked for one exit point. What phase 9 needs is one *observation*
point - somewhere every response passes, including the ones built before `ctx`
exists. `produce()` keeps its branches; `handle()` is the sole exit, and a mutable
`Trace` carries what the early paths know down to it. Collapsing `produce` into a
single `return` through nested conditionals would buy nothing and cost
readability.
```

Update §6 "Known limitations" to add:

```markdown
4. `circuit.within` defaults to `openFor`, so a policy that wants a long open
   period but a short accumulation window must say both.
5. `requestId` is available as `ctx.requestId` and in the log record, but is not
   echoed on a response header. Nothing in §12 asks for it, and adding a header
   by default would change every existing response.
```

- [ ] **Step 2: Rewrite `deferred-items.md`**

Update the status line to reflect the merged plan and the new test count, then:

- Move items 1, 2, and 3 out of "Must be done first in plan 5" into a new
  **"Settled"** section, each with the ruling: item 1 by Task 1 (single exit is
  `handle()`, see §2.8), item 2 by Task 1 (named factories colocated with their
  modules), item 3 by Task 2 (both surfaces clear the store; the contract is
  "reset() clears the store it was given").
- Move items 4 and 5 into "Settled", noting `circuit.within` and the policy-id
  namespacing from Task 9.
- Move item 9 into "Settled" - `requestKey` is computed once as of Task 1.
- Keep items 6, 8, and 10–14 deferred, and add a line to item 6 that plan 5
  deliberately did not take `Mock.override()` on: the user ruled it into plan 6
  when the scope question was put to them, so it is now a *decided* deferral
  rather than an oversight.
- Add to "Process lessons worth keeping":

```markdown
**A deterministic system makes replay tests toothless by default.** Generation is
seeded, so two real executions of the same request already return byte-identical
bytes - an idempotency replay test that only compares bodies passes with
idempotency removed entirely. Plan 5's replay test counts executions through a
`ctx.seq()`-backed callback so the two paths genuinely differ. Whenever a test
asserts "the same output", ask what else could produce that same output.
```

- [ ] **Step 3: Add the CLI to `CLAUDE.md`**

Under `## Commands`, add:

```sh
node src/server/cli.ts docs/example.json --port 4000   # run the mock from a document
```

The commands block is the operating manual for someone working on the project, and
"how do I actually run this thing" now has an answer that is not "write a script".

- [ ] **Step 4: Verify the docs match the code**

Run: `npm test`

Expected: PASS. Then re-read the three claims most likely to have drifted:
the default `inFlightTtlMs`, the default `within`, and the exact conflict codes.
Grep the source for each rather than trusting the plan.

- [ ] **Step 5: Commit**

```sh
git add -A
```

```sh
git commit -m 'docs: record plan 5 rulings and settled deferrals' -m 'The phases 7-9 design gains the 5xx-storage amendment and the note that the single exit is handle() rather than a single return. deferred-items.md moves items 1, 2, 3, 4, 5, and 9 to settled, and records that Mock.override() is now a decided deferral to plan 6 rather than an oversight.'
```

---

## Definition of done

- [ ] `npm test` is green, and the count has grown by roughly 60 tests.
- [ ] `npx tsc --noEmit` reports nothing.
- [ ] Every response - 404, 405, malformed body, 401, 400, 409, 503, 200, 500 -
      passes through `handle`'s single exit, proven by the 401 and 404 logging
      tests.
- [ ] The replay test was observed failing with the storage line commented out,
      and the exact message reported.
- [ ] The short-circuit logging test was observed failing with `emitLog` moved
      into the rendered-response path, and the exact message reported.
- [ ] `node src/server/cli.ts <document>.json` serves the document.
- [ ] `docs/superpowers/deferred-items.md` records every ruling this plan made.

# mockingham Validation and Auth Implementation Plan (Phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate incoming requests and enforce spec-driven auth, with every
error mockingham emits shaped by the operation's own declared error schema.

**Architecture:** Tasks 1–3 first pay down architectural debt that plan 2's final
review identified: `src/server/handler.ts` absorbed config resolution, status
selection, and response rendering as inline blocks instead of the modules the
design specifies. Those come out first, because phase 5 adds two more pipeline
stages and phase 6 adds three more on top. Tasks 4–8 then add the zod compiler,
on-contract errors, request validation, and auth.

**Tech Stack:** TypeScript (types stripped natively by Node, never compiled),
Node >= 24, `node:test`, `zod` 4.

**Design document:** `docs/superpowers/specs/2026-08-12-mockingham-phases-4-6-design.md`.
Read §1 (amendments) and §6 before starting. **Master spec:**
`docs/superpowers/specs/2026-08-11-mockingham-design.md` §§2, 6, 7, 8.

## Global Constraints

Copied verbatim from the design document and `CLAUDE.md`. Every task's
requirements implicitly include this section.

- **Node floor is >= 24.** Types are stripped natively; there is no build step.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
  Use `const X = {...} as const`. Ordinary `class` declarations are fine.
- **Relative imports MUST carry the `.ts` extension** (`import { x } from './types.ts'`).
- **`zod` is the only permitted hard runtime dependency.** Add no other.
- **One schema interpretation.** `src/schema/walk.ts` is shared by value
  generation and zod compilation. Never add a second traversal. The zod compiler
  in Task 5 exists to consume `classify()`, not to re-read schemas its own way -
  if generation and validation disagree about a schema, that is the worst bug
  class in this project.
- **Determinism:** no `Math.random()`, no `Date.now()`, and no iteration over an
  unordered `Set` in a generation path. `node scripts/determinism.ts` must keep
  printing `/pets/7 200 {"id":843,"name":"cedar","email":"neil.quinn@fjord.io","tag":"gale-marsh"}`.
- **The core is pure.** Nothing reachable from `server/handler.ts` may import a
  `node:` module.
- **A fixture or LLM miss is never an error**, and the mock keeps serving when a
  user callback throws.
- **Errors stay on-contract.** Emit the operation's declared error schema when
  one exists; fall back to the built-in envelope only when it does not.
- **US English spelling** everywhere - `honor`, `behavior`, `serialize`,
  `normalize`, `canceled`.
- **Shell:** one plain command per Bash call, single-quoted arguments, no `&&`
  chains, no pipes, no `$(...)`, no heredocs, no redirects, never `cd`.
  Multi-paragraph commits use repeated `-m` flags. `git push` and `rm -rf` are
  denied by policy.

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/config.ts` | **New** - target compilation and per-operation config resolution |
| `src/runtime/select.ts` | **New** - status selection, `Prefer` parsing, `default` response lookup |
| `src/runtime/render.ts` | **New** - generate, overlay, header assembly, transport headers |
| `src/runtime/errors.ts` | **New** - error envelope, callback tagging, on-contract error bodies |
| `src/schema/compile.ts` | **New** - OpenAPI schema → zod, memoized on schema identity |
| `src/runtime/validate.ts` | **New** - pipeline stage 4 |
| `src/runtime/auth.ts` | **New** - pipeline stage 3 |
| `src/runtime/types.ts` | **Modified** - gains `Stage`, `Principal`, `ctx.auth`, `ctx.deny` |
| `src/runtime/headers.ts` | **Modified** - settles through `resolve/layer.ts` |
| `src/resolve/layer.ts` | **Modified** - tags user-callback failures |
| `src/spec/types.ts` | **Modified** - security schemes and requirements |
| `src/spec/load.ts` | **Modified** - parses `securitySchemes` and `security` |
| `src/server/handler.ts` | **Modified** - becomes a thin orchestrator |

## Task Dependency Graph

```
Task 1 (config + select) ─ Task 2 (render) ─ Task 3 (errors + Stage + orchestrator) ─┬─ Task 6 (on-contract errors) ─┬─ Task 7 (validate)
                                                                                     │                               │
Task 4 (security in the Api model) ──────────────────────────────────────────────────┼───────────────────────────────┴─ Task 8 (auth)
Task 5 (zod compiler) ───────────────────────────────────────────────────────────────┘
```

**Parallel batch A:** Tasks 1, 4, 5 - no shared files.
**Serial spine:** Task 1 → 2 → 3 (all touch `handler.ts`; never run in parallel).
**Then:** Task 6, then Tasks 7 and 8 in parallel.

---

### Task 1: Extract config resolution and status selection

Plan 2's final review found that `handler.ts` never became the orchestrator the
design specifies. This is the first of three tasks pulling it apart. It also
fixes a pre-existing defect: an operation declaring only a `default` response
returns 501, because status selection never consults `Operation.defaultResponse`.

**Files:**
- Create: `src/runtime/config.ts`
- Create: `src/runtime/select.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/config.test.ts`
- Test: `test/runtime/select.test.ts`

**Interfaces:**
- Consumes: `Operation`, `ResponseSpec` from `src/spec/types.ts`; `compileTarget`,
  `resolveTarget` from `src/resolve/target.ts`; `Ctx`, `OverrideNode` from
  `src/runtime/types.ts`.
- Produces: from `config.ts` - `StatusConfig`, `OperationConfig`, `CompiledConfig`,
  `compileConfigs(operations, known): CompiledConfig[]`,
  `resolveConfigs(operation, compiled): ResolvedConfig`.
  From `select.ts` - `StatusSource`, `Selection`,
  `preferred(request, key): string | undefined`,
  `selectResponse(operation, request, staticStatus): Selection | undefined`,
  `responseForStatus(operation, status): ResponseSpec | undefined`.
  `StatusConfig` and `OperationConfig` MOVE out of `handler.ts`; it re-exports
  them so `src/index.ts` and existing imports keep working.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileConfigs, resolveConfigs } from '../../src/runtime/config.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(method: Operation['method'], path: string, id: string): Operation {
  return { method, path, operationId: id, parameters: [], responses: [] }
}

const known = [op('get', '/pets/{petId}', 'showPet'), op('get', '/pets', 'listPets')]

test('an unmatched target throws at compile time', () => {
  assert.throws(
    () => compileConfigs({ 'GET /nope': { 200: { body: {} } } }, known),
    /matches no operation/
  )
})

test('no configuration compiles to an empty list', () => {
  assert.deepEqual(compileConfigs(undefined, known), [])
})

test('the last matching config wins for scalar settings', () => {
  const compiled = compileConfigs(
    { '* /pets/**': { status: 500 }, 'GET /pets/{petId}': { status: 404 } },
    known
  )
  assert.equal(resolveConfigs(known[0] as Operation, compiled).status, 404)
})

test('body overrides from every matching config are returned in order', () => {
  const compiled = compileConfigs(
    {
      '* /pets/**': { 200: { body: { a: 1 } } },
      'GET /pets/{petId}': { 200: { body: { b: 2 } } }
    },
    known
  )
  const bodies = resolveConfigs(known[0] as Operation, compiled).bodies(200)
  // Order matters: broad first so the specific one refines it.
  assert.deepEqual(bodies, [{ a: 1 }, { b: 2 }])
})

test('bodies for an unconfigured status are empty', () => {
  const compiled = compileConfigs({ 'GET /pets/{petId}': { 200: { body: {} } } }, known)
  assert.deepEqual(resolveConfigs(known[0] as Operation, compiled).bodies(404), [])
})

test('header overrides merge shallowly in declaration order', () => {
  const compiled = compileConfigs(
    {
      '* /pets/**': { 200: { headers: { 'x-a': '1', 'x-b': '1' } } },
      'GET /pets/{petId}': { 200: { headers: { 'x-b': '2' } } }
    },
    known
  )
  assert.deepEqual(resolveConfigs(known[0] as Operation, compiled).headers(200), {
    'x-a': '1',
    'x-b': '2'
  })
})

test('a config matching no operation in this request is ignored', () => {
  const compiled = compileConfigs({ 'GET /pets': { status: 201 } }, known)
  assert.equal(resolveConfigs(known[0] as Operation, compiled).status, undefined)
})
```

Create `test/runtime/select.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preferred, responseForStatus, selectResponse } from '../../src/runtime/select.ts'
import type { Operation, ResponseSpec } from '../../src/spec/types.ts'

function res(status: number): ResponseSpec {
  return { status, headers: {}, content: {} }
}

function op(responses: ResponseSpec[], defaultResponse?: ResponseSpec): Operation {
  return {
    method: 'get', path: '/x', parameters: [], responses, defaultResponse
  }
}

function req(prefer?: string): Request {
  return new Request('http://mock/x', prefer ? { headers: { prefer } } : undefined)
}

test('preferred reads a status directive', () => {
  assert.equal(preferred(req('status=201'), 'status'), '201')
  assert.equal(preferred(req('example=empty'), 'example'), 'empty')
  assert.equal(preferred(req(), 'status'), undefined)
})

test('preferred reads one directive from several', () => {
  assert.equal(preferred(req('status=201, example=empty'), 'example'), 'empty')
})

test('the lowest declared 2xx is the default choice', () => {
  const found = selectResponse(op([res(404), res(200), res(201)]), req(), undefined)
  assert.equal(found?.spec.status, 200)
  assert.equal(found?.source, 'default')
})

test('Prefer beats the default', () => {
  const found = selectResponse(op([res(200), res(404)]), req('status=404'), undefined)
  assert.equal(found?.spec.status, 404)
  assert.equal(found?.source, 'prefer')
})

test('a configured status beats the default but loses to Prefer', () => {
  const responses = [res(200), res(404), res(500)]
  assert.equal(selectResponse(op(responses), req(), 500)?.spec.status, 500)
  assert.equal(selectResponse(op(responses), req(), 500)?.source, 'config')
  assert.equal(selectResponse(op(responses), req('status=404'), 500)?.spec.status, 404)
})

test('an undeclared Prefer status falls through rather than 404ing the mock', () => {
  const found = selectResponse(op([res(200)]), req('status=418'), undefined)
  assert.equal(found?.spec.status, 200)
  assert.equal(found?.source, 'default')
})

test('with no 2xx the first declared response is used', () => {
  assert.equal(selectResponse(op([res(404), res(500)]), req(), undefined)?.spec.status, 404)
})

test('an operation declaring only default is served as 200', () => {
  // `default` carries a schema but no status of its own, so the mock has to
  // choose one. Previously this returned 501 MOCK_NO_RESPONSE.
  const found = selectResponse(op([], res(0)), req(), undefined)
  assert.equal(found?.spec.status, 200)
})

test('an operation declaring nothing at all selects nothing', () => {
  assert.equal(selectResponse(op([]), req(), undefined), undefined)
})

test('responseForStatus prefers a declared response', () => {
  assert.equal(responseForStatus(op([res(200), res(401)]), 401)?.status, 401)
})

test('responseForStatus falls back to default, restamped with the status', () => {
  const found = responseForStatus(op([res(200)], res(0)), 401)
  assert.equal(found?.status, 401)
})

test('responseForStatus returns undefined when neither exists', () => {
  assert.equal(responseForStatus(op([res(200)]), 401), undefined)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/config.test.ts test/runtime/select.test.ts`
Expected: FAIL - neither module exists.

- [ ] **Step 3: Create `src/runtime/config.ts`**

```ts
import type { Operation } from '../spec/types.ts'
import { compileTarget, resolveTarget } from '../resolve/target.ts'
import type { Ctx, OverrideNode } from './types.ts'

export interface StatusConfig {
  body?: OverrideNode
  headers?: Record<string, OverrideNode>
}

export type OperationConfig = {
  status?: number
  respond?: (ctx: Ctx) => Response | Promise<Response>
} & { [status: number]: StatusConfig }

export interface CompiledConfig {
  matches(operation: Operation): boolean
  config: OperationConfig
}

/**
 * Targets are resolved here, at construction, so a typo throws immediately
 * rather than silently never firing on any request.
 */
export function compileConfigs(
  operations: Record<string, OperationConfig> | undefined,
  known: Operation[]
): CompiledConfig[] {
  return Object.entries(operations ?? {}).map(([target, config]) => {
    resolveTarget(target, known)
    return { matches: compileTarget(target).matches, config }
  })
}

export interface ResolvedConfig {
  status?: number
  respond?: OperationConfig['respond']
  /** Every matching config's body override for a status, in declaration order. */
  bodies(status: number): OverrideNode[]
  headers(status: number): Record<string, OverrideNode>
}

/**
 * Matching configs are deliberately NOT merged into one object. A broad target
 * and a specific one both setting `200.body` must layer - the specific refining
 * the broad one's result - so bodies stay a list applied in sequence. Headers
 * are flat, so a shallow merge in declaration order is already right.
 */
export function resolveConfigs(
  operation: Operation,
  compiled: CompiledConfig[]
): ResolvedConfig {
  const matching = compiled
    .filter((entry) => entry.matches(operation))
    .map((entry) => entry.config)

  let status: number | undefined
  let respond: OperationConfig['respond']
  for (const entry of matching) {
    if (entry.status !== undefined) status = entry.status
    if (entry.respond !== undefined) respond = entry.respond
  }

  return {
    status,
    respond,
    bodies(forStatus) {
      const out: OverrideNode[] = []
      for (const entry of matching) {
        const scoped = entry[forStatus]
        if (scoped !== undefined && scoped.body !== undefined) out.push(scoped.body)
      }
      return out
    },
    headers(forStatus) {
      let out: Record<string, OverrideNode> = {}
      for (const entry of matching) {
        const scoped = entry[forStatus]
        if (scoped !== undefined && scoped.headers) {
          out = { ...out, ...scoped.headers }
        }
      }
      return out
    }
  }
}
```

- [ ] **Step 4: Create `src/runtime/select.ts`**

```ts
import type { Operation, ResponseSpec } from '../spec/types.ts'

export type StatusSource = 'prefer' | 'config' | 'default'

export interface Selection {
  spec: ResponseSpec
  source: StatusSource
}

/**
 * A `default` response carries a schema but no status of its own - in OpenAPI it
 * means "any status not otherwise declared". When it is all an operation has,
 * the mock must still choose something, and 200 is the only sensible success.
 */
const DEFAULT_STATUS = 200

/** Reads one `Prefer` directive, e.g. `status=201` or `example=empty-list`. */
export function preferred(request: Request, key: string): string | undefined {
  const header = request.headers.get('prefer')
  if (header === null) return undefined
  const matched = new RegExp(`${key}=([^;,\\s]+)`).exec(header)
  return matched?.[1]
}

export function selectResponse(
  operation: Operation,
  request: Request,
  staticStatus: number | undefined
): Selection | undefined {
  const wanted = preferred(request, 'status')
  if (wanted !== undefined) {
    const found = operation.responses.find(
      (response) => response.status === Number.parseInt(wanted, 10)
    )
    // An undeclared Prefer status falls through to the normal choice rather
    // than failing: the client asked for something this operation cannot do.
    if (found) return { spec: found, source: 'prefer' }
  }

  if (staticStatus !== undefined) {
    const found = operation.responses.find(
      (response) => response.status === staticStatus
    )
    if (found) return { spec: found, source: 'config' }
  }

  const success = operation.responses.find(
    (response) => response.status >= 200 && response.status < 300
  )
  if (success) return { spec: success, source: 'default' }

  const first = operation.responses[0]
  if (first) return { spec: first, source: 'default' }

  if (operation.defaultResponse) {
    return {
      spec: { ...operation.defaultResponse, status: DEFAULT_STATUS },
      source: 'default'
    }
  }

  return undefined
}

/**
 * The response an operation declares for one specific status, falling back to
 * its `default` restamped with that status. This is what on-contract error
 * construction needs: a 401 body should come from the operation's own 401
 * schema, or from its `default` schema, before any built-in envelope.
 */
export function responseForStatus(
  operation: Operation,
  status: number
): ResponseSpec | undefined {
  const declared = operation.responses.find(
    (response) => response.status === status
  )
  if (declared) return declared
  if (operation.defaultResponse) {
    return { ...operation.defaultResponse, status }
  }
  return undefined
}
```

- [ ] **Step 5: Rewire `src/server/handler.ts` to use both**

Delete from `handler.ts`: the `StatusConfig` and `OperationConfig` declarations,
the `preferred` function, and the `matchingConfigs` function. Replace the imports
of `compileTarget`/`resolveTarget` with:

```ts
import { compileConfigs, resolveConfigs } from '../runtime/config.ts'
import type { OperationConfig, StatusConfig } from '../runtime/config.ts'
import { preferred, selectResponse } from '../runtime/select.ts'
```

Re-export the moved types so existing importers keep working:

```ts
export type { OperationConfig, StatusConfig } from '../runtime/config.ts'
```

Replace the target-compilation block in `createHandler` with:

```ts
  const compiled = compileConfigs(options.operations, api.operations)
```

Replace the config/scalar block inside `run` with:

```ts
    const config = resolveConfigs(operation, compiled)
```

Replace the whole status-selection block (from `let source = 'default'` through
the `MOCK_NO_RESPONSE` return) with:

```ts
    const key = requestKey(operation, params, seed)
    const exampleName = preferred(request, 'example')
    const selected = selectResponse(operation, request, config.status)

    if (!selected) {
      return Response.json(
        {
          error: {
            code: 'MOCK_NO_RESPONSE',
            message: `Operation ${operation.method} ${operation.path} declares no responses`
          }
        },
        { status: 501 }
      )
    }

    const chosen = selected.spec
    const source = selected.source
```

Replace the override-collection block with:

```ts
    const bodyOverrides = config.bodies(chosen.status)
    const headerOverrides = config.headers(chosen.status)
```

and change `if (respond)` to `if (config.respond)` and the call to
`await config.respond(ctx)`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/runtime/config.test.ts test/runtime/select.test.ts`
Expected: PASS, 7 config tests and 12 select tests.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test`
Expected: PASS. All 210 pre-existing tests must pass **without modification** -
this is a pure refactor plus one bug fix, and no existing behavior changes.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged, including
`/pets/7 200 {"id":843,"name":"cedar","email":"neil.quinn@fjord.io","tag":"gale-marsh"}`.

- [ ] **Step 8: Commit**

```sh
git add src/runtime/config.ts src/runtime/select.ts src/server/handler.ts test/runtime/config.test.ts test/runtime/select.test.ts
```

```sh
git commit -m 'refactor: extract config resolution and status selection' -m 'handler.ts absorbed both as inline blocks during phase 4. Pulling them out is the first of three steps toward the stage orchestrator the design specifies, before phase 5 adds two more stages and phase 6 adds three.' -m 'Also fixes a pre-existing defect: an operation declaring only a default response returned 501, because selection never consulted Operation.defaultResponse.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 2: Extract response rendering

The second refactor step. Also unifies async settling: `headers.ts` currently
keeps its own one-level `Promise.all`, so a nested promise settles in bodies but
not in headers.

**Files:**
- Create: `src/runtime/render.ts`
- Modify: `src/runtime/headers.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/render.test.ts`
- Test: `test/runtime/headers.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 1 produced, plus `applyOverrides` from
  `src/resolve/layer.ts`, `buildHeaders` from `src/runtime/headers.ts`,
  `generateValue`/`GenerateOptions` from `src/generate/generate.ts`.
- Produces: `renderResponse(input: RenderInput): Promise<Response>`.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/render.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderResponse } from '../../src/runtime/render.ts'
import { compileResolvers } from '../../src/resolve/resolvers.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { ResponseSpec } from '../../src/spec/types.ts'

const ctx = {} as Ctx

function spec(status: number): ResponseSpec {
  return {
    status,
    headers: {},
    content: {
      'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } }
    }
  }
}

function render(overrides: Partial<Parameters<typeof renderResponse>[0]> = {}) {
  return renderResponse({
    ctx,
    chosen: spec(200),
    bodyOverrides: [],
    headerOverrides: {},
    resolvers: compileResolvers(),
    rngFor: (label) => createRng(`r|${label}`),
    generateOptions: {},
    generate: () => ({ a: 'generated' }),
    example: () => undefined,
    ...overrides
  })
}

test('serializes the generated body as JSON', async () => {
  const response = await render()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { a: 'generated' })
})

test('applies body overrides in order', async () => {
  const response = await render({
    bodyOverrides: [{ a: 'first', b: 'first' }, { a: 'second' }]
  })
  assert.deepEqual(await response.json(), { a: 'second', b: 'first' })
})

test('a named example beats generation', async () => {
  const response = await render({
    exampleName: 'empty',
    example: (_status, name) => (name === 'empty' ? { a: 'from-example' } : undefined)
  })
  assert.deepEqual(await response.json(), { a: 'from-example' })
})

test('an absent body yields a bodiless response with no content type', async () => {
  const response = await render({
    chosen: { status: 204, headers: {}, content: {} },
    generate: () => undefined
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('content-type'), null)
})

test('content-type is applied last and cannot be overridden', async () => {
  const response = await render({ headerOverrides: { 'content-type': 'text/plain' } })
  assert.equal(response.headers.get('content-type'), 'application/json')
})

test('debug headers are added when requested', async () => {
  const response = await render({
    debug: { seed: '123', source: 'prefer', operationId: 'showPet' }
  })
  assert.equal(response.headers.get('x-mock-seed'), '123')
  assert.equal(response.headers.get('x-mock-status-source'), 'prefer')
  assert.equal(response.headers.get('x-mock-operation'), 'showPet')
})

test('debug headers are absent by default', async () => {
  const response = await render()
  assert.equal(response.headers.get('x-mock-seed'), null)
})

test('a promise left in the generated tree is settled', async () => {
  const response = await render({ generate: () => ({ a: Promise.resolve('settled') }) })
  assert.deepEqual(await response.json(), { a: 'settled' })
})
```

Append to `test/runtime/headers.test.ts`:

```ts
test('a pending value inside a header array is settled', async () => {
  // The distinguishing case for settling through resolve/layer.ts: a one-level
  // Promise.all leaves the inner promise untouched inside the array, which
  // stringifies to 'a,[object Promise]'. Do NOT weaken this to
  // `async () => Promise.resolve(x)` - JS auto-flattens that, and the test then
  // passes against the very implementation it exists to rule out.
  const headers = await build({ 'x-list': ['a', Promise.resolve('b')] })
  assert.equal(headers.get('x-list'), 'a,b')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/render.test.ts test/runtime/headers.test.ts`
Expected: FAIL - `render.ts` does not exist.

- [ ] **Step 3: Create `src/runtime/render.ts`**

```ts
import type { ResponseSpec } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { applyOverrides } from '../resolve/layer.ts'
import type { ResolverLookup } from '../resolve/resolvers.ts'
import { buildHeaders } from './headers.ts'
import type { Ctx, OverrideNode } from './types.ts'

const JSON_TYPE = 'application/json'

export interface RenderDebug {
  seed: string
  source: string
  operationId?: string
}

export interface RenderInput {
  ctx: Ctx
  chosen: ResponseSpec
  bodyOverrides: OverrideNode[]
  headerOverrides: Record<string, OverrideNode>
  globals?: Record<string, OverrideNode>
  resolvers: ResolverLookup
  rngFor(label: string): Rng
  generateOptions: GenerateOptions
  exampleName?: string
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
  debug?: RenderDebug
}

/**
 * Pipeline stages 8 and 9: generate the body, overlay the override layers, build
 * the headers, then stamp the transport headers.
 *
 * Transport headers are set here, AFTER `buildHeaders` returns, which is what
 * makes them non-overridable rather than merely last. `Content-Length` is left
 * to `Response`, per design amendment 1.4.
 */
export async function renderResponse(input: RenderInput): Promise<Response> {
  const { chosen } = input

  const headers = await buildHeaders({
    spec: chosen,
    globals: input.globals,
    resolvers: input.resolvers,
    overrides: input.headerOverrides,
    ctx: input.ctx,
    rngFor: (name) => input.rngFor(`header|${name}`),
    generateOptions: { ...input.generateOptions, ctx: input.ctx }
  })

  if (input.debug) {
    headers.set('x-mock-seed', input.debug.seed)
    headers.set('x-mock-status-source', input.debug.source)
    if (input.debug.operationId) {
      headers.set('x-mock-operation', input.debug.operationId)
    }
  }

  let body: unknown
  if (input.exampleName !== undefined) {
    body = input.example(chosen.status, input.exampleName)
  }
  // The same call ctx.generate(status) makes, not a second copy - a response
  // callback and the pipeline must never produce different bodies.
  if (body === undefined) body = input.generate(chosen.status)

  if (input.bodyOverrides.length === 0) {
    // Still one pass: resolvers may have left promises in the tree.
    if (body !== undefined) body = await applyOverrides(body, undefined, input.ctx)
  } else {
    for (const override of input.bodyOverrides) {
      body = await applyOverrides(body, override, input.ctx)
    }
  }

  if (body === undefined) {
    return new Response(null, { status: chosen.status, headers })
  }

  headers.set('content-type', JSON_TYPE)
  return new Response(JSON.stringify(body), { status: chosen.status, headers })
}
```

- [ ] **Step 4: Settle headers through `resolve/layer.ts`**

In `src/runtime/headers.ts`, add the import:

```ts
import { applyOverrides } from '../resolve/layer.ts'
```

Replace the final settle-and-build block (the `Promise.all` over `names` and the
loop that follows) with:

```ts
  // Settled through the same pass bodies use, so a header override returning a
  // promise-of-a-promise behaves identically to a body override that does.
  const settled = (await applyOverrides(values, undefined, input.ctx)) as Record<
    string,
    unknown
  >

  const headers = new Headers()
  for (const name of Object.keys(settled)) {
    const value = settled[name]
    if (value !== null && value !== undefined) headers.set(name, String(value))
  }
  return headers
```

`applyOverrides` with an `undefined` override is exactly the settle pass, and it
batches every pending leaf into one `Promise.all` per nesting level, so this
keeps the single-batch property the previous code had.

- [ ] **Step 5: Rewire `src/server/handler.ts`**

Delete from `handler.ts`: the `buildHeaders` and `applyOverrides` imports, the header-building block, the debug-header block, the
body-generation block, the override-application block, and both `Response`
returns at the end of `run`. Add:

```ts
import { renderResponse } from '../runtime/render.ts'
```

**Keep the `JSON_TYPE` constant.** The `mediaFor` helper still reads
`.content[JSON_TYPE]` and is not part of the moved rendering, so removing the
constant would not compile.

Replace all of it with:

```ts
    return await renderResponse({
      ctx,
      chosen,
      bodyOverrides: config.bodies(chosen.status),
      headerOverrides: config.headers(chosen.status),
      globals: options.headers,
      resolvers,
      rngFor,
      generateOptions,
      exampleName,
      generate: generateFor,
      example: exampleFor,
      debug: options.debugHeaders
        ? {
            seed: String(fnv1a(key)),
            source,
            operationId: operation.operationId
          }
        : undefined
    })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/runtime/render.test.ts test/runtime/headers.test.ts`
Expected: PASS, 8 render tests and 11 header tests.

- [ ] **Step 7: Run the whole suite, typecheck, determinism**

Run: `npm test`
Expected: PASS, all pre-existing tests unmodified.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

- [ ] **Step 8: Commit**

```sh
git add src/runtime/render.ts src/runtime/headers.ts src/server/handler.ts test/runtime/render.test.ts test/runtime/headers.test.ts
```

```sh
git commit -m 'refactor: extract response rendering' -m 'Generation, override application, header assembly, and transport headers move out of handler.ts into runtime/render.ts.' -m 'headers.ts now settles through resolve/layer.ts rather than its own one-level Promise.all, so a nested pending value behaves the same in a header as in a body.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 3: The stage orchestrator and the error envelope

The third refactor step. Introduces the `Stage` signature the design specifies,
turns `handler.ts` into an orchestrator, and splits a genuine internal failure
from a user-callback failure - plan 2's boundary catch reports both as
`MOCK_CALLBACK_FAILED`.

**Files:**
- Create: `src/runtime/errors.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/resolve/layer.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/errors.test.ts`
- Test: `test/server/robustness.test.ts` (append)

**Interfaces:**
- Produces: from `errors.ts` - `envelope(code, message): { error: { code, message } }`,
  `markCallback(error): unknown`, `isCallbackError(error): boolean`.
  From `types.ts` - `Stage = (ctx: Ctx) => Promise<Response | undefined>`.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/errors.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelope, isCallbackError, markCallback } from '../../src/runtime/errors.ts'

test('envelope has the project error shape', () => {
  assert.deepEqual(envelope('MOCK_X', 'boom'), {
    error: { code: 'MOCK_X', message: 'boom' }
  })
})

test('an unmarked error is not a callback error', () => {
  assert.equal(isCallbackError(new Error('boom')), false)
})

test('a marked error is a callback error', () => {
  assert.equal(isCallbackError(markCallback(new Error('boom'))), true)
})

test('marking returns the same error object', () => {
  const error = new Error('boom')
  assert.strictEqual(markCallback(error), error)
})

test('marking a non-object is safe and stays unmarked', () => {
  assert.equal(markCallback('boom'), 'boom')
  assert.equal(isCallbackError('boom'), false)
  assert.equal(isCallbackError(null), false)
  assert.equal(isCallbackError(undefined), false)
})
```

Append to `test/server/robustness.test.ts`:

```ts
test('an internal failure is not reported as a callback failure', async () => {
  // A generate hook that throws is mockingham's own code path, not a user
  // callback, so it must not be labeled MOCK_CALLBACK_FAILED.
  const broken = loadApi(petstore)
  const target = broken.operations.find((o) => o.operationId === 'showPetById')
  // A schema whose `properties` is a primitive makes classify/generate throw.
  ;(target as any).responses[0].content['application/json'].schema = {
    get type(): string { throw new Error('internal boom') }
  }
  const handle = createHandler(broken, { seed: 'internal' })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 500)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_INTERNAL')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/errors.test.ts test/server/robustness.test.ts`
Expected: FAIL - `errors.ts` does not exist; the internal failure reports
`MOCK_CALLBACK_FAILED`.

- [ ] **Step 3: Create `src/runtime/errors.ts`**

```ts
export interface ErrorEnvelope {
  error: { code: string; message: string }
}

export function envelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
}

/**
 * Distinguishes a failure inside a user-supplied callback from a genuine bug in
 * mockingham. Both reach the same boundary catch, but reporting an internal
 * defect as `MOCK_CALLBACK_FAILED` sends whoever is debugging in exactly the
 * wrong direction.
 *
 * A symbol keyed on the error object rather than a subclass: user callbacks
 * throw whatever they like, including non-Errors, and a wrapper would hide the
 * original stack.
 */
const CALLBACK = Symbol.for('mockingham.callback-error')

export function markCallback(error: unknown): unknown {
  if (error !== null && typeof error === 'object') {
    ;(error as Record<symbol, unknown>)[CALLBACK] = true
  }
  return error
}

export function isCallbackError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[CALLBACK] === true
  )
}
```

- [ ] **Step 4: Mark callback failures at their call sites**

In `src/resolve/layer.ts`, add the import:

```ts
import { markCallback } from '../runtime/errors.ts'
```

and replace the function-node branch of `overlay` with:

```ts
  if (typeof node === 'function') {
    try {
      return (node as (context: unknown) => unknown)(ctx)
    } catch (error) {
      // Tagged so the boundary catch can tell a user's throw from our own bug.
      throw markCallback(error)
    }
  }
```

A rejected promise from an async override is settled in `settle`, not here, so
also wrap the `Promise.all` in `settle`:

```ts
    let settled: unknown[]
    try {
      settled = await Promise.all(slots.map((slot) => slot.promise))
    } catch (error) {
      throw markCallback(error)
    }
```

In `src/runtime/headers.ts`, wrap the `evaluate` helper's call the same way:

```ts
function evaluate(node: OverrideNode, ctx: unknown): unknown {
  if (typeof node !== 'function') return node
  try {
    return (node as (context: unknown) => unknown)(ctx)
  } catch (error) {
    throw markCallback(error)
  }
}
```

**Resolvers are user callbacks too**, and this is the site most easily missed.
In `src/resolve/resolvers.ts`, import `markCallback` from `../runtime/errors.ts`
and route all FOUR user-function invocations through one helper - the `bySchema`,
`byName`, and `byFormat` branches of `resolve()`, plus the one in
`resolveHeader()`:

```ts
function callResolver(fn: Resolver, request: Ctx): unknown {
  try {
    return fn(request)
  } catch (error) {
    // A resolver is a user callback like any override, so the boundary must be
    // able to tell its failure from a defect in mockingham's own code.
    throw markCallback(error)
  }
}
```

Note the asymmetry that hides this: an ASYNC resolver that rejects is already
covered, because its promise lands in the generated tree and is settled by
`settle`'s tagged `Promise.all`. Only the synchronous throw is mislabeled.

The import chain `resolvers.ts` → `errors.ts` does not cycle: `generate.ts`
imports `ResolverLookup` from `resolvers.ts` type-only, which is erased.

- [ ] **Step 5: Add the `Stage` type**

Append to `src/runtime/types.ts`:

```ts
/**
 * One pipeline stage. Returning a `Response` short-circuits the pipeline;
 * returning `undefined` continues to the next stage.
 */
export type Stage = (ctx: Ctx) => Promise<Response | undefined>
```

- [ ] **Step 6: Turn `handler.ts` into an orchestrator**

Add the imports:

```ts
import { envelope, isCallbackError, markCallback } from '../runtime/errors.ts'
import type { Stage } from '../runtime/types.ts'
```

Replace every inline `Response.json({ error: { code: …, message: … } }, …)` in
`handler.ts` with `Response.json(envelope(code, message), { status })`.

Immediately after `ctx` is constructed, insert the stage list and its loop. The
list is built per request, not at construction, because Tasks 7 and 8 push
stages that close over `operation` and the request key. It is empty in this task:

```ts
    // Stages 3 through 6. Auth and validation arrive in this plan; idempotency
    // and failure policy in plan 4. Each returns a Response to short-circuit.
    const stages: Stage[] = []

    for (const stage of stages) {
      const short = await stage(ctx)
      if (short) return short
    }
```

Wrap the `config.respond` call so a throwing response callback is tagged:

```ts
    if (config.respond) {
      try {
        return await config.respond(ctx)
      } catch (error) {
        throw markCallback(error)
      }
    }
```

Finally, split the boundary catch's code:

```ts
      const code = isCallbackError(error) ? 'MOCK_CALLBACK_FAILED' : 'MOCK_INTERNAL'
      return Response.json(envelope(code, message), { status: 500, headers })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/runtime/errors.test.ts test/server/robustness.test.ts`
Expected: PASS, 5 error tests and the existing robustness tests plus the new one.

- [ ] **Step 8: Run the whole suite, typecheck, determinism**

Run: `npm test`
Expected: PASS. The pre-existing robustness tests asserting
`MOCK_CALLBACK_FAILED` for a throwing user override must still pass unmodified -
those throws are now tagged, so the code is unchanged for them.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

- [ ] **Step 9: Commit**

```sh
git add src/runtime/errors.ts src/runtime/types.ts src/resolve/layer.ts src/runtime/headers.ts src/server/handler.ts test/runtime/errors.test.ts test/server/robustness.test.ts
```

```sh
git commit -m 'refactor: add the stage orchestrator and split internal from callback errors' -m 'handler.ts is now a thin orchestrator with an explicit stage list that auth and validation push into. The Stage signature is the one the design specifies.' -m 'Plan 2 reported every failure as MOCK_CALLBACK_FAILED, including genuine internal bugs. User callback sites now tag what they throw, so the boundary can tell the two apart and MOCK_INTERNAL means what it says.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 4: Security schemes in the `Api` model

Auth has nothing to enforce until the loader keeps `securitySchemes` and
`security`, both of which it currently discards.

**Files:**
- Modify: `src/spec/types.ts`
- Modify: `src/spec/load.ts`
- Test: `test/spec/load.test.ts` (append)

**Do NOT add security to `test/fixtures/petstore.ts`.** Ten or more existing
tests request `/pets/7`, and once Task 8 enforces auth every one of them would
start failing on 401 - a large, noisy diff that buries any real regression.
Auth tests build their own small documents instead.

**Interfaces:**
- Produces: `SecurityScheme` and `SecurityRequirement` in `src/spec/types.ts`;
  `Operation.security?: SecurityRequirement[]`;
  `Api.securitySchemes: Record<string, SecurityScheme>`.
  `SecurityRequirement` is `Record<string, string[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/spec/load.test.ts`:

```ts
const secured = {
  openapi: '3.1.0',
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'showPetById',
        security: [{ bearerAuth: ['pets:read'] }],
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    }
  }
}

test('loads security schemes', () => {
  const api = loadApi(secured)
  assert.equal(api.securitySchemes['bearerAuth']?.type, 'http')
  assert.equal(api.securitySchemes['bearerAuth']?.scheme, 'bearer')
  assert.equal(api.securitySchemes['apiKey']?.location, 'header')
  assert.equal(api.securitySchemes['apiKey']?.name, 'x-api-key')
})

test('loads per-operation security requirements', () => {
  const api = loadApi(secured)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.deepEqual(op?.security, [{ bearerAuth: ['pets:read'] }])
})

test('a document with no security schemes yields an empty record', () => {
  assert.deepEqual(loadApi(petstore).securitySchemes, {})
})

test('an operation without security inherits the document default', () => {
  const doc = {
    openapi: '3.1.0',
    security: [{ apiKey: [] }],
    paths: { '/a': { get: { operationId: 'a', responses: { '200': {} } } } }
  }
  const api = loadApi(doc)
  assert.deepEqual(api.operations[0]?.security, [{ apiKey: [] }])
})

test('an explicit empty security array means no auth and is not overwritten', () => {
  // `security: []` is meaningfully different from an absent security field:
  // it opts the operation out of a document-level default.
  const doc = {
    openapi: '3.1.0',
    security: [{ apiKey: [] }],
    paths: {
      '/a': { get: { operationId: 'a', security: [], responses: { '200': {} } } }
    }
  }
  assert.deepEqual(loadApi(doc).operations[0]?.security, [])
})

test('an absent security field stays undefined when the document declares none', () => {
  const doc = {
    openapi: '3.1.0',
    paths: { '/a': { get: { operationId: 'a', responses: { '200': {} } } } }
  }
  assert.equal(loadApi(doc).operations[0]?.security, undefined)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/spec/load.test.ts`
Expected: FAIL - `securitySchemes` and `security` are undefined.

- [ ] **Step 3: Extend `src/spec/types.ts`**

Add these declarations, and the two fields:

```ts
export interface SecurityScheme {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect'
  /** For `http`: `bearer`, `basic`, and so on. */
  scheme?: string
  /** For `apiKey`: where the credential travels. */
  location?: 'header' | 'query' | 'cookie'
  /** For `apiKey`: the header, query parameter, or cookie name. */
  name?: string
}

/**
 * One requirement object. Every scheme named inside it must be satisfied
 * together; a list of them is satisfied when ANY one object is.
 */
export type SecurityRequirement = Record<string, string[]>
```

Add to `Operation`:

```ts
  security?: SecurityRequirement[]
```

Add to `Api`:

```ts
  securitySchemes: Record<string, SecurityScheme>
```

- [ ] **Step 4: Parse both in `src/spec/load.ts`**

Add this helper beside the other `to*` functions:

```ts
function toSecuritySchemes(raw: unknown): Record<string, SecurityScheme> {
  const out: Record<string, SecurityScheme> = {}
  for (const [name, value] of Object.entries(asRecord(raw))) {
    const record = asRecord(value)
    out[name] = {
      type: record['type'] as SecurityScheme['type'],
      scheme: record['scheme'] as string | undefined,
      location: record['in'] as SecurityScheme['location'],
      name: record['name'] as string | undefined
    }
  }
  return out
}

function toSecurity(raw: unknown): SecurityRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map((entry) => {
    const out: SecurityRequirement = {}
    for (const [scheme, scopes] of Object.entries(asRecord(entry))) {
      out[scheme] = Array.isArray(scopes) ? (scopes as string[]) : []
    }
    return out
  })
}
```

Import `SecurityRequirement` and `SecurityScheme` in the type import list.

Inside `loadApi`, after `const { document: resolved, schemaNames } = resolveDocument(doc)`:

```ts
  const securitySchemes = toSecuritySchemes(
    asRecord(resolved['components'])['securitySchemes']
  )
  // A document-level `security` is the default for operations that declare
  // none. An operation's own `security: []` must survive as an empty array -
  // it opts out of that default - so the fallback tests for `undefined`, not
  // for emptiness.
  const documentSecurity = toSecurity(resolved['security'])
```

Inside the per-operation loop, add to the pushed object:

```ts
        security: toSecurity(op['security']) ?? documentSecurity,
```

and change the final return to:

```ts
  return { version, operations, schemaNames, securitySchemes }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/spec/load.test.ts`
Expected: PASS, all existing load tests plus 6 new ones.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test`
Expected: PASS. This task only adds fields to the `Api` model; nothing reads them
yet, so no behavior changes.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

- [ ] **Step 7: Commit**

```sh
git add src/spec/types.ts src/spec/load.ts test/spec/load.test.ts
```

```sh
git commit -m 'feat: carry security schemes and requirements into the Api model' -m 'The loader discarded both, so auth had nothing to enforce. A document-level security block becomes the default for operations that declare none, while an explicit empty array survives as an opt-out rather than being replaced by the default.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 5: The OpenAPI-to-zod compiler

**Files:**
- Create: `src/schema/compile.ts`
- Test: `test/schema/compile.test.ts`

**Interfaces:**
- Consumes: `classify`, `isNullable` from `src/schema/walk.ts`; `Schema` from
  `src/spec/types.ts`.
- Produces: `compileSchema(schema: Schema): ZodType` and
  `createCompiler(): { compile(schema: Schema): ZodType }`. The module-level
  `compileSchema` uses a shared `WeakMap`; `createCompiler` gives an isolated one
  for tests.

**This must consume `classify()`.** Reading schemas its own way would create the
second interpretation invariant 1 forbids, and generation and validation would
drift.

- [ ] **Step 1: Write the failing test**

Create `test/schema/compile.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import type { Schema } from '../../src/spec/types.ts'

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

test('compiles primitives', () => {
  assert.equal(parse({ type: 'string' }, 'x').success, true)
  assert.equal(parse({ type: 'string' }, 1).success, false)
  assert.equal(parse({ type: 'integer' }, 1).success, true)
  assert.equal(parse({ type: 'integer' }, 1.5).success, false)
  assert.equal(parse({ type: 'number' }, 1.5).success, true)
  assert.equal(parse({ type: 'boolean' }, true).success, true)
  assert.equal(parse({ type: 'null' }, null).success, true)
})

test('honors string length and pattern', () => {
  assert.equal(parse({ type: 'string', minLength: 2 }, 'a').success, false)
  assert.equal(parse({ type: 'string', maxLength: 2 }, 'abc').success, false)
  assert.equal(parse({ type: 'string', pattern: '^a+$' }, 'aaa').success, true)
  assert.equal(parse({ type: 'string', pattern: '^a+$' }, 'b').success, false)
})

test('honors numeric bounds and multipleOf', () => {
  assert.equal(parse({ type: 'integer', minimum: 5 }, 4).success, false)
  assert.equal(parse({ type: 'integer', maximum: 5 }, 6).success, false)
  assert.equal(parse({ type: 'integer', exclusiveMinimum: 5 }, 5).success, false)
  assert.equal(parse({ type: 'integer', exclusiveMaximum: 5 }, 5).success, false)
  assert.equal(parse({ type: 'integer', multipleOf: 3 }, 9).success, true)
  assert.equal(parse({ type: 'integer', multipleOf: 3 }, 8).success, false)
})

test('compiles objects with required and optional properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } }
  }
  assert.equal(parse(schema, { a: 'x' }).success, true)
  assert.equal(parse(schema, { b: 1 }).success, false)
  assert.equal(parse(schema, { a: 'x', b: 'no' }).success, false)
})

test('additionalProperties false rejects unknown keys', () => {
  const schema: Schema = {
    type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false
  }
  assert.equal(parse(schema, { a: 'x', extra: 1 }).success, false)
})

test('an unconstrained object accepts unknown keys', () => {
  const schema: Schema = { type: 'object', properties: { a: { type: 'string' } } }
  assert.equal(parse(schema, { a: 'x', extra: 1 }).success, true)
})

test('compiles arrays with item bounds', () => {
  const schema: Schema = { type: 'array', items: { type: 'integer' }, minItems: 2 }
  assert.equal(parse(schema, [1, 2]).success, true)
  assert.equal(parse(schema, [1]).success, false)
  assert.equal(parse(schema, ['x', 'y']).success, false)
})

test('compiles enum and const', () => {
  assert.equal(parse({ enum: ['a', 'b'] }, 'a').success, true)
  assert.equal(parse({ enum: ['a', 'b'] }, 'c').success, false)
  assert.equal(parse({ const: 7 }, 7).success, true)
  assert.equal(parse({ const: 7 }, 8).success, false)
})

test('compiles a union from oneOf', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  assert.equal(parse(schema, 'x').success, true)
  assert.equal(parse(schema, 1).success, true)
  assert.equal(parse(schema, true).success, false)
})

test('compiles a discriminated union', () => {
  const schema: Schema = {
    oneOf: [
      { type: 'object', required: ['kind'], properties: { kind: { const: 'a' }, a: { type: 'string' } } },
      { type: 'object', required: ['kind'], properties: { kind: { const: 'b' }, b: { type: 'integer' } } }
    ],
    discriminator: { propertyName: 'kind' }
  }
  assert.equal(parse(schema, { kind: 'a', a: 'x' }).success, true)
  assert.equal(parse(schema, { kind: 'b', b: 1 }).success, true)
  assert.equal(parse(schema, { kind: 'b', b: 'x' }).success, false)
})

test('merges allOf through the shared interpretation', () => {
  const schema: Schema = {
    allOf: [
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } }
    ]
  }
  assert.equal(parse(schema, { a: 'x', b: 1 }).success, true)
  assert.equal(parse(schema, { a: 'x' }).success, false)
})

test('honors nullable in both spellings', () => {
  assert.equal(parse({ type: 'string', nullable: true }, null).success, true)
  assert.equal(parse({ type: ['string', 'null'] }, null).success, true)
  assert.equal(parse({ type: 'string' }, null).success, false)
})

test('an empty schema accepts anything', () => {
  assert.equal(parse({}, { anything: true }).success, true)
})

test('compiles a recursive schema without overflowing', () => {
  const node: Schema = { type: 'object', properties: { name: { type: 'string' } } }
  node.properties!['children'] = { type: 'array', items: node }
  const compiled = createCompiler().compile(node)
  assert.equal(compiled.safeParse({ name: 'a', children: [{ name: 'b', children: [] }] }).success, true)
  assert.equal(compiled.safeParse({ name: 'a', children: [{ name: 1 }] }).success, false)
})

test('the same schema object compiles once', () => {
  const compiler = createCompiler()
  const schema: Schema = { type: 'string' }
  assert.strictEqual(compiler.compile(schema), compiler.compile(schema))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/schema/compile.test.ts`
Expected: FAIL - cannot find module `../../src/schema/compile.ts`.

- [ ] **Step 3: Implement `src/schema/compile.ts`**

```ts
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Schema } from '../spec/types.ts'
import { classify, isNullable } from './walk.ts'

/**
 * Compiles an OpenAPI schema to a zod schema THROUGH `classify()` - the same
 * interpretation value generation uses. That shared reading is the whole point:
 * what we generate and what we validate can never disagree about a schema.
 */
export interface Compiler {
  compile(schema: Schema): ZodType
}

function withStringRules(schema: Schema): ZodType {
  let out = z.string()
  if (schema.minLength !== undefined) out = out.min(schema.minLength)
  if (schema.maxLength !== undefined) out = out.max(schema.maxLength)
  if (schema.pattern !== undefined) out = out.regex(new RegExp(schema.pattern))
  return out
}

function withNumberRules(schema: Schema, integer: boolean): ZodType {
  let out = integer ? z.number().int() : z.number()
  if (schema.minimum !== undefined) out = out.min(schema.minimum)
  if (schema.maximum !== undefined) out = out.max(schema.maximum)
  if (typeof schema.exclusiveMinimum === 'number') {
    out = out.gt(schema.exclusiveMinimum)
  } else if (schema.exclusiveMinimum === true && schema.minimum !== undefined) {
    out = out.gt(schema.minimum)
  }
  if (typeof schema.exclusiveMaximum === 'number') {
    out = out.lt(schema.exclusiveMaximum)
  } else if (schema.exclusiveMaximum === true && schema.maximum !== undefined) {
    out = out.lt(schema.maximum)
  }
  if (schema.multipleOf !== undefined) out = out.multipleOf(schema.multipleOf)
  return out
}

export function createCompiler(): Compiler {
  // Keyed on resolved-schema object identity, so a component referenced by
  // twenty operations compiles once. `$ref` resolution makes every reference to
  // one component the same object, which is what makes identity sufficient.
  const cache = new WeakMap<Schema, ZodType>()
  // Schemas currently being compiled. A recursive schema reaches itself while
  // still mid-compilation, and z.lazy defers that edge until parse time.
  const active = new Set<Schema>()

  function compile(schema: Schema): ZodType {
    const cached = cache.get(schema)
    if (cached) return cached
    if (active.has(schema)) {
      return z.lazy(() => cache.get(schema) ?? z.unknown())
    }

    active.add(schema)
    const built = build(schema)
    active.delete(schema)

    const final = isNullable(schema) ? built.nullable() : built
    cache.set(schema, final)
    return final
  }

  function build(schema: Schema): ZodType {
    const kind = classify(schema)

    switch (kind.kind) {
      case 'const':
        return z.literal(kind.value as never)
      case 'enum':
        return z.union(
          kind.values.map((value) => z.literal(value as never))
        ) as ZodType
      case 'string':
        return withStringRules(schema)
      case 'integer':
        return withNumberRules(schema, true)
      case 'number':
        return withNumberRules(schema, false)
      case 'boolean':
        return z.boolean()
      case 'null':
        return z.null()
      case 'union': {
        const variants = kind.variants.map((variant) => compile(variant))
        if (kind.discriminator !== undefined) {
          // A discriminated union parses faster and reports far better errors,
          // but zod requires every variant to be an object with that key. Fall
          // back to a plain union when the shape does not allow it.
          try {
            return z.discriminatedUnion(
              kind.discriminator,
              variants as never
            ) as ZodType
          } catch {
            return z.union(variants as never) as ZodType
          }
        }
        return z.union(variants as never) as ZodType
      }
      case 'array': {
        let out = z.array(compile(kind.items))
        if (schema.minItems !== undefined) out = out.min(schema.minItems)
        if (schema.maxItems !== undefined) out = out.max(schema.maxItems)
        return out
      }
      case 'object': {
        const shape: Record<string, ZodType> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          const compiled = compile(property)
          shape[name] = kind.required.includes(name)
            ? compiled
            : compiled.optional()
        }
        return kind.additional === false
          ? z.strictObject(shape)
          : z.looseObject(shape)
      }
      default:
        return z.unknown()
    }
  }

  return { compile }
}

const shared = createCompiler()

export function compileSchema(schema: Schema): ZodType {
  return shared.compile(schema)
}
```

> **CORRECTIONS FOUND DURING IMPLEMENTATION.** The Step 3 code above is wrong in
> three places, each confirmed empirically against the installed zod 4.4.3. Apply
> these; do not implement Step 3 as written.
>
> **1. The `z.discriminatedUnion` try/catch is dead code.** zod 4 does not throw
> at construction for malformed variants - it defers validation to first parse,
> so the throw lands outside the `try` and crashes at request time. Replace the
> try/catch with a construction-time pre-check, and add the helper:
>
> ```ts
> function usable(variant: Schema, key: string): boolean {
>   const kind = classify(variant)
>   if (kind.kind !== 'object') return false
>   const property = kind.properties[key]
>   if (property === undefined) return false
>   const discriminator = classify(property)
>   // zod 4 requires a discriminator whose compiled schema exposes literal
>   // values; `const` and `enum` are exactly the two that do.
>   return discriminator.kind === 'const' || discriminator.kind === 'enum'
> }
> ```
>
> ```ts
>       case 'union': {
>         const variants = kind.variants.map((variant) => compile(variant))
>         const key = kind.discriminator
>         if (key !== undefined && kind.variants.every((v) => usable(v, key))) {
>           return z.discriminatedUnion(key, variants as never) as ZodType
>         }
>         return z.union(variants as never) as ZodType
>       }
> ```
>
> **2. `allOf`-nested constraints are dropped - in TWO files.** `build` passes the
> un-merged `schema` to the constraint helpers, so `{ allOf: [{ type: 'string',
> minLength: 5 }] }` accepts `'ab'`. Import `mergeAllOf` from `./walk.ts`, compute
> `const merged = mergeAllOf(schema)` once at the top of `build`, and pass
> `merged` to every constraint read.
>
> `src/generate/generate.ts` has the identical blind spot and MUST be fixed in the
> same task: compute the merged schema in `walk` and pass it to `generateString`,
> `generateInteger`, `generateNumber`, and `arrayLength`, leaving the
> `example`/`default` reads on the original node. Fixing only the compiler would
> make validation stricter than generation, so mockingham could generate a value
> its own validator rejects - the exact drift invariant 1 exists to prevent.
>
> **3. `build()` needs a `try/finally`.** If it throws (an invalid `pattern`
> reaching `new RegExp` is the realistic case), `active.delete(schema)` never
> runs and that schema is stuck active forever, so later references resolve to
> `z.lazy(() => cache.get(schema) ?? z.unknown())` with a cache entry that can
> never be set - silently accepting anything:
>
> ```ts
>     active.add(schema)
>     let built: ZodType
>     try {
>       built = build(schema)
>     } finally {
>       active.delete(schema)
>     }
> ```
>
> **4. Add these tests.** The `allOf` ones must wrap a PRIMITIVE - object-level
> `allOf` is flattened by `classify()` and does NOT reproduce the bug, so a test
> using it passes against the broken implementation:
>
> ```ts
> test('honors a constraint declared inside allOf', () => {
>   assert.equal(parse({ allOf: [{ type: 'string', minLength: 5 }] }, 'ab').success, false)
>   assert.equal(parse({ allOf: [{ type: 'string', minLength: 5 }] }, 'abcdef').success, true)
> })
>
> test('honors a numeric constraint declared inside allOf', () => {
>   assert.equal(parse({ allOf: [{ type: 'integer', minimum: 21 }] }, 7).success, false)
>   assert.equal(parse({ allOf: [{ type: 'integer', minimum: 21 }] }, 42).success, true)
> })
>
> test('honors the 3.0 boolean spelling of exclusive bounds', () => {
>   assert.equal(parse({ type: 'integer', minimum: 5, exclusiveMinimum: true }, 5).success, false)
>   assert.equal(parse({ type: 'integer', minimum: 5, exclusiveMinimum: true }, 6).success, true)
>   assert.equal(parse({ type: 'integer', maximum: 5, exclusiveMaximum: true }, 5).success, false)
> })
> ```
>
> and in `test/generate/generate.test.ts`, guarding the generation half - the
> bound is far outside the default 5-to-12 range so it cannot pass by luck:
>
> ```ts
> test('honors a length constraint declared inside allOf', () => {
>   const value = generateValue(
>     { allOf: [{ type: 'string', minLength: 40 }] }, createRng('allof'), {}
>   ) as string
>   assert.ok(value.length >= 40, `expected at least 40 characters, got ${value.length}`)
> })
> ```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/schema/compile.test.ts test/generate/generate.test.ts`
Expected: PASS, 19 compile tests and the generate suite plus its new one.

- [ ] **Step 5: Run the whole suite, typecheck, commit**

Run: `npm test`

Run: `npx tsc --noEmit`

```sh
git add src/schema/compile.ts test/schema/compile.test.ts
```

```sh
git commit -m 'feat: compile OpenAPI schemas to zod through the shared interpretation' -m 'The compiler consumes classify() rather than reading schemas its own way, so what we generate and what we validate cannot drift. Memoized on resolved-schema identity, which ref resolution makes sufficient; recursive schemas defer through z.lazy.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 6: On-contract error bodies

When mockingham emits a status itself, it should emit the operation's own error
schema so the client's error-path parsing gets exercised too.

**Files:**
- Modify: `src/runtime/errors.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/errors.test.ts` (append)
- Test: `test/server/contract-errors.test.ts`

**Interfaces:**
- Consumes: `responseForStatus` from `src/runtime/select.ts`; `generateValue`
  from `src/generate/generate.ts`.
- Produces: `buildError(input: ErrorInput): Promise<Response>` and the
  `ErrorBodyMode` type. `HandlerOptions` gains `errorBody?: ErrorBodyMode`.

- [ ] **Step 1: Write the failing tests**

Create `test/server/contract-errors.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'

// Exercised through the 415 that body parsing already emits on its own: the
// operation declares application/json, so posting XML is a genuine
// content-negotiation failure rather than a contrived one.
//
// Note what is NOT used here: `Prefer: status=415`. A client asking for a
// status is mockingham SERVING a declared response, not emitting an error, and
// normal rendering already generates it from the declared schema.
const doc = {
  openapi: '3.1.0',
  paths: {
    '/on-contract': {
      post: {
        operationId: 'onContract',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          '200': { description: 'ok' },
          '415': {
            description: 'bad type',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['errorCode', 'detail'],
                  properties: {
                    errorCode: { type: 'string' },
                    detail: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/off-contract': {
      post: {
        operationId: 'offContract',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  }
}

const api = loadApi(doc)

function badType(path: string): Request {
  return new Request(`http://mock${path}`, {
    method: 'POST',
    body: '<xml/>',
    headers: { 'content-type': 'application/xml' }
  })
}

test('a declared error status is emitted in the operation shape', async () => {
  const handle = createHandler(api, { seed: 'contract' })
  const response = await handle(badType('/on-contract'))
  assert.equal(response.status, 415)
  const body = (await response.json()) as any
  // The operation's own schema, not the built-in envelope.
  assert.equal(typeof body.errorCode, 'string')
  assert.equal(typeof body.detail, 'string')
  assert.equal(body.error, undefined)
})

test('an undeclared error status falls back to the envelope', async () => {
  const handle = createHandler(api, { seed: 'contract' })
  const response = await handle(badType('/off-contract'))
  assert.equal(response.status, 415)
  assert.equal(
    ((await response.json()) as any).error.code,
    'MOCK_UNSUPPORTED_MEDIA_TYPE'
  )
})

test('a 404 always uses the envelope, having no operation to be on contract with', async () => {
  const handle = createHandler(api, { seed: 'contract' })
  const response = await handle(new Request('http://mock/nope'))
  assert.equal(response.status, 404)
  assert.equal(((await response.json()) as any).error.code, 'MOCK_NOT_FOUND')
})

test('diagnostic mode always uses the envelope', async () => {
  const handle = createHandler(api, { seed: 'contract', errorBody: 'diagnostic' })
  const response = await handle(badType('/on-contract'))
  assert.equal(
    ((await response.json()) as any).error.code,
    'MOCK_UNSUPPORTED_MEDIA_TYPE'
  )
})

test('contract mode still exposes the diagnostic on a debug header', async () => {
  const handle = createHandler(api, { seed: 'contract', debugHeaders: true })
  const response = await handle(badType('/on-contract'))
  assert.match(
    response.headers.get('x-mock-error') ?? '',
    /MOCK_UNSUPPORTED_MEDIA_TYPE/
  )
})

test('a custom errorBody function wins over both modes', async () => {
  const handle = createHandler(api, {
    seed: 'contract',
    errorBody: (_ctx, err) => ({ custom: err.code })
  })
  const response = await handle(badType('/on-contract'))
  assert.deepEqual(await response.json(), { custom: 'MOCK_UNSUPPORTED_MEDIA_TYPE' })
})
```

Append to `test/runtime/errors.test.ts`:

```ts
import { buildError } from '../../src/runtime/errors.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Operation } from '../../src/spec/types.ts'

const bare: Operation = {
  method: 'get', path: '/x', parameters: [], responses: []
}

test('buildError uses the envelope when nothing is declared', async () => {
  const response = await buildError({
    operation: bare, status: 500, code: 'MOCK_X', message: 'boom',
    mode: 'contract', rng: createRng('e'), generateOptions: {}
  })
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error: { code: 'MOCK_X', message: 'boom' }
  })
})

test('buildError with no operation uses the envelope', async () => {
  const response = await buildError({
    operation: undefined, status: 404, code: 'MOCK_NOT_FOUND', message: 'gone',
    mode: 'contract', rng: createRng('e'), generateOptions: {}
  })
  assert.equal(((await response.json()) as any).error.code, 'MOCK_NOT_FOUND')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server/contract-errors.test.ts test/runtime/errors.test.ts`
Expected: FAIL - `buildError` does not exist.

- [ ] **Step 3: Extend `src/runtime/errors.ts`**

Add these imports and exports:

```ts
import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { generateValue } from '../generate/generate.ts'
import { responseForStatus } from './select.ts'

const JSON_TYPE = 'application/json'

export interface ErrorDetail {
  code: string
  message: string
  errors?: Array<{ path: string; message: string }>
}

export type ErrorBodyMode =
  | 'contract'
  | 'diagnostic'
  | ((ctx: unknown, error: ErrorDetail) => unknown)

export interface ErrorInput {
  operation: Operation | undefined
  status: number
  code: string
  message: string
  errors?: Array<{ path: string; message: string }>
  mode: ErrorBodyMode
  rng: Rng
  generateOptions: GenerateOptions
  ctx?: unknown
  debugHeaders?: boolean
}

/**
 * Builds the body for a status mockingham emits itself.
 *
 * In `contract` mode it first looks for the status among the operation's own
 * declared responses - falling back to the operation's `default` - and generates
 * from that schema, so a client's error-path parsing is exercised too. Only when
 * the operation declares nothing usable does the built-in envelope appear.
 *
 * 404 always lands here with no operation, because no route matched and there is
 * therefore no contract to be on.
 */
export async function buildError(input: ErrorInput): Promise<Response> {
  const detail: ErrorDetail = {
    code: input.code,
    message: input.message,
    errors: input.errors
  }

  const headers = new Headers()
  if (input.debugHeaders) {
    // The flattened failure list goes HERE, not into the body. In contract mode
    // the body comes from the document's own error schema, and adding an
    // `errors` key to it would violate the very schema the client was told to
    // expect - which is what contract mode exists to preserve. One line, because
    // header values cannot carry line breaks.
    const detail = input.errors?.length
      ? `${input.code}: ${input.message}; ` +
        input.errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ')
      : `${input.code}: ${input.message}`
    headers.set('x-mock-error', detail.replace(/[\r\n]+/g, ' '))
  }

  if (typeof input.mode === 'function') {
    const body = input.mode(input.ctx, detail)
    headers.set('content-type', JSON_TYPE)
    return new Response(JSON.stringify(body), { status: input.status, headers })
  }

  if (input.mode === 'contract' && input.operation) {
    const declared = responseForStatus(input.operation, input.status)
    const media = declared?.content[JSON_TYPE]
    if (media) {
      const body = generateValue(media.schema, input.rng, input.generateOptions)
      headers.set('content-type', JSON_TYPE)
      return new Response(JSON.stringify(body), {
        status: input.status,
        headers
      })
    }
  }

  const body: Record<string, unknown> = envelope(input.code, input.message)
  if (input.errors) {
    ;(body['error'] as Record<string, unknown>)['errors'] = input.errors
  }
  headers.set('content-type', JSON_TYPE)
  return new Response(JSON.stringify(body), { status: input.status, headers })
}
```

- [ ] **Step 4: Route the handler's own errors through it**

In `src/server/handler.ts`, add `errorBody?: ErrorBodyMode` to `HandlerOptions`
and import `buildError` and `ErrorBodyMode`.

Add a helper inside `createHandler`, above `run`:

```ts
  const mode: ErrorBodyMode = options.errorBody ?? 'contract'

  const fail = (
    operation: Operation | undefined,
    status: number,
    code: string,
    message: string,
    key: string,
    ctx?: unknown,
    errors?: Array<{ path: string; message: string }>
  ): Promise<Response> =>
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
```

Replace the 404 return with `return await fail(undefined, 404, 'MOCK_NOT_FOUND', \`No operation for ${url.pathname}\`, seed)`.

Replace the 415/400 body-parse return with
`return await fail(operation, parsed.status, parsed.code, parsed.message, requestKey(operation, params, seed))`.

Replace the `MOCK_NO_RESPONSE` 501 return with a `fail` call the same way.

**Do NOT route `Prefer`-selected statuses through `fail`.** A client asking for
`Prefer: status=404` is mockingham *serving a declared response*, not emitting an
error of its own - normal rendering already generates it from that response's
declared schema, which is the on-contract behavior. Sending it through `fail`
would both duplicate that and change existing behavior.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/server/contract-errors.test.ts test/runtime/errors.test.ts`
Expected: PASS, 6 contract tests and 7 error tests.

- [ ] **Step 6: Run the whole suite, typecheck, determinism, commit**

Run: `npm test`
Expected: PASS, with every pre-existing test unmodified. In particular the
existing `Prefer: status=404` test is untouched, because `Prefer` selection
deliberately does not go through `fail`.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

```sh
git add src/runtime/errors.ts src/server/handler.ts test/runtime/errors.test.ts test/server/contract-errors.test.ts
```

```sh
git commit -m 'feat: emit errors in the operation declared shape' -m 'A status mockingham emits itself now comes from the operation own error schema when one is declared, falling back to its default response, so a client error-path parsing is exercised too. The built-in envelope appears only when nothing is declared.' -m 'A 404 always uses the envelope: no route matched, so there is no contract to be on.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 7: Request validation

**Files:**
- Create: `src/runtime/validate.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/validate.test.ts`
- Test: `test/server/validation.test.ts`

**Interfaces:**
- Consumes: `compileSchema` from `src/schema/compile.ts`; `Ctx` from
  `src/runtime/types.ts`.
- Produces: `coerce(value: string, schema: Schema): unknown` and
  `validateRequest(ctx, operation): { ok: true } | { ok: false; errors: Array<{ path: string; message: string }> }`.
  `HandlerOptions` gains `validateRequests?: boolean`, default `true`.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/validate.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerce, validateRequest } from '../../src/runtime/validate.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { Operation } from '../../src/spec/types.ts'

function ctx(partial: Partial<Ctx>): Ctx {
  return {
    params: {}, query: {}, headers: {}, body: undefined, ...partial
  } as Ctx
}

function op(parameters: Operation['parameters'], requestBody?: Operation['requestBody']): Operation {
  return { method: 'post', path: '/x', parameters, responses: [], requestBody }
}

test('coerce turns numeric strings into numbers', () => {
  assert.equal(coerce('42', { type: 'integer' }), 42)
  assert.equal(coerce('4.5', { type: 'number' }), 4.5)
})

test('coerce leaves a non-numeric string alone so validation can report it', () => {
  assert.equal(coerce('abc', { type: 'integer' }), 'abc')
})

test('coerce handles booleans', () => {
  assert.equal(coerce('true', { type: 'boolean' }), true)
  assert.equal(coerce('false', { type: 'boolean' }), false)
  assert.equal(coerce('yes', { type: 'boolean' }), 'yes')
})

test('coerce leaves strings as strings', () => {
  assert.equal(coerce('42', { type: 'string' }), '42')
})

test('a valid request passes', () => {
  const operation = op([
    { name: 'petId', location: 'path', required: true, schema: { type: 'integer' } }
  ])
  assert.deepEqual(
    validateRequest(ctx({ params: { petId: '7' } }), operation),
    { ok: true }
  )
})

test('a path param of the wrong type is reported with a path', () => {
  const operation = op([
    { name: 'petId', location: 'path', required: true, schema: { type: 'integer' } }
  ])
  const result = validateRequest(ctx({ params: { petId: 'abc' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errors[0]?.path, 'path.petId')
    assert.ok(result.errors[0]?.message.length > 0)
  }
})

test('a missing required query param is reported', () => {
  const operation = op([
    { name: 'limit', location: 'query', required: true, schema: { type: 'integer' } }
  ])
  const result = validateRequest(ctx({}), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'query.limit')
})

test('a missing optional query param is fine', () => {
  const operation = op([
    { name: 'limit', location: 'query', required: false, schema: { type: 'integer' } }
  ])
  assert.deepEqual(validateRequest(ctx({}), operation), { ok: true })
})

test('headers are validated case-insensitively', () => {
  const operation = op([
    { name: 'X-Count', location: 'header', required: true, schema: { type: 'integer' } }
  ])
  assert.deepEqual(
    validateRequest(ctx({ headers: { 'x-count': '3' } }), operation),
    { ok: true }
  )
})

test('a body failing its schema is reported under body', () => {
  const operation = op([], {
    'application/json': {
      schema: { type: 'object', required: ['age'], properties: { age: { type: 'integer' } } }
    }
  })
  const result = validateRequest(ctx({ body: { age: 'old' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'body.age')
})

test('every failure is reported, not just the first', () => {
  const operation = op([
    { name: 'a', location: 'query', required: true, schema: { type: 'integer' } },
    { name: 'b', location: 'query', required: true, schema: { type: 'integer' } }
  ])
  const result = validateRequest(ctx({ query: { a: 'x', b: 'y' } }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors.length, 2)
})

test('raw bytes are skipped rather than guessed at', () => {
  const operation = op([], {
    'application/json': { schema: { type: 'object', required: ['a'], properties: {} } }
  })
  assert.deepEqual(
    validateRequest(ctx({ body: new Uint8Array([1, 2]) }), operation),
    { ok: true }
  )
})

test('an operation declaring no request body accepts any body', () => {
  assert.deepEqual(validateRequest(ctx({ body: { any: true } }), op([])), { ok: true })
})
```

Create `test/server/validation.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

test('a bad path param is a 400 with a flattened error list', async () => {
  const handle = createHandler(api, { seed: 'validate' })
  const response = await handle(new Request('http://mock/pets/abc'))
  assert.equal(response.status, 400)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_REQUEST_INVALID')
  assert.equal(body.error.errors[0].path, 'path.petId')
})

test('a valid request is unaffected', async () => {
  const handle = createHandler(api, { seed: 'validate' })
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 200)
})

test('validation can be turned off', async () => {
  const handle = createHandler(api, { seed: 'validate', validateRequests: false })
  assert.equal((await handle(new Request('http://mock/pets/abc'))).status, 200)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/validate.test.ts test/server/validation.test.ts`
Expected: FAIL - `validate.ts` does not exist.

- [ ] **Step 3: Implement `src/runtime/validate.ts`**

```ts
import type { Operation, Schema } from '../spec/types.ts'
import { compileSchema } from '../schema/compile.ts'
import { classify } from '../schema/walk.ts'
import type { Ctx } from './types.ts'

const JSON_TYPE = 'application/json'

export interface ValidationFailure {
  path: string
  message: string
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationFailure[] }

/**
 * Path and query values arrive from the wire as strings. Without coercion every
 * `{petId}` declared `integer` would fail against a compiled `z.number()`.
 *
 * A value that does not convert is left as the original string on purpose, so
 * validation reports "expected number, received string" rather than NaN.
 */
export function coerce(value: string, schema: Schema): unknown {
  const kind = classify(schema)
  if (kind.kind === 'integer' || kind.kind === 'number') {
    const asNumber = Number(value)
    return value.trim() !== '' && !Number.isNaN(asNumber) ? asNumber : value
  }
  if (kind.kind === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }
  return value
}

function check(
  schema: Schema,
  value: unknown,
  prefix: string,
  errors: ValidationFailure[]
): void {
  const result = compileSchema(schema).safeParse(value)
  if (result.success) return
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? `${prefix}.${issue.path.join('.')}` : prefix
    errors.push({ path, message: issue.message })
  }
}

export function validateRequest(
  ctx: Ctx,
  operation: Operation
): ValidationResult {
  const errors: ValidationFailure[] = []

  for (const parameter of operation.parameters) {
    const source =
      parameter.location === 'path'
        ? ctx.params[parameter.name]
        : parameter.location === 'query'
          ? ctx.query[parameter.name]
          : parameter.location === 'header'
            ? ctx.headers[parameter.name.toLowerCase()]
            : undefined

    if (source === undefined) {
      if (parameter.required) {
        errors.push({
          path: `${parameter.location}.${parameter.name}`,
          message: 'Required'
        })
      }
      continue
    }

    const value = Array.isArray(source)
      ? source.map((entry) => coerce(entry, parameter.schema))
      : coerce(source, parameter.schema)

    check(parameter.schema, value, `${parameter.location}.${parameter.name}`, errors)
  }

  // Raw bytes mean the media type was not one we parse. Validating them would
  // be guessing, so they are skipped, per the master spec's body-parsing rules.
  const body = ctx.body
  const declared = operation.requestBody?.[JSON_TYPE]
  if (declared && body !== undefined && !(body instanceof Uint8Array)) {
    check(declared.schema, body, 'body', errors)
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
```

- [ ] **Step 4: Add it to the stage list in `src/server/handler.ts`**

Add `validateRequests?: boolean` to `HandlerOptions`. Task 3 already declares
`const stages: Stage[] = []` inside `run`, immediately before the stage loop -
push onto that list, between its declaration and the loop. It has to be per
request because the stage closes over `operation` and `key`:

```ts
    if (options.validateRequests !== false) {
      stages.push(async (current) => {
        const result = validateRequest(current, operation)
        if (result.ok) return undefined
        return await fail(
          operation,
          400,
          'MOCK_REQUEST_INVALID',
          'Request does not match the declared schema',
          key,
          current,
          result.errors
        )
      })
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/runtime/validate.test.ts test/server/validation.test.ts`
Expected: PASS, 13 validate tests and 3 server tests.

- [ ] **Step 6: Run the whole suite, typecheck, determinism, commit**

Run: `npm test`
Expected: PASS. Watch for pre-existing tests that send requests now considered
invalid - if one appears, the test is exercising a real validation gap and the
fix belongs in the request, not in weakening validation. Report any such case.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

```sh
git add src/runtime/validate.ts src/server/handler.ts test/runtime/validate.test.ts test/server/validation.test.ts
```

```sh
git commit -m 'feat: validate incoming requests against the declared schemas' -m 'Path params, query params, headers, and body are checked through the compiled zod schemas. Path and query values are coerced from their wire strings first, or every integer path parameter would fail on principle.' -m 'Failures produce a 400 listing every problem with a dotted path, not just the first one.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 8: Spec-driven auth

**Files:**
- Create: `src/runtime/auth.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/auth.test.ts`
- Test: `test/server/auth.test.ts`

**Interfaces:**
- Consumes: `SecurityRequirement`, `SecurityScheme` from `src/spec/types.ts`.
- Produces: `Principal` (`{ sub?: string; scopes?: string[] } & Record<string, unknown>`),
  `AuthSchemeConfig` (`{ verify?(credential: string, ctx: Ctx): Promise<Principal | Response> | Principal | Response }`),
  `checkAuth(input): Promise<AuthOutcome>`. `HandlerOptions` gains
  `auth?: Record<string, true | AuthSchemeConfig>`. `Ctx` gains
  `auth?: Principal` and `deny(status, code?): Response`.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/auth.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAuth, credentialFor } from '../../src/runtime/auth.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { SecurityScheme } from '../../src/spec/types.ts'

function ctx(partial: Partial<Ctx> = {}): Ctx {
  return { headers: {}, query: {}, params: {}, ...partial } as Ctx
}

const bearer: SecurityScheme = { type: 'http', scheme: 'bearer' }
const apiKey: SecurityScheme = { type: 'apiKey', location: 'header', name: 'x-api-key' }

test('extracts a bearer token', () => {
  assert.equal(
    credentialFor(bearer, ctx({ headers: { authorization: 'Bearer abc' } })),
    'abc'
  )
})

test('bearer extraction is case-insensitive on the scheme word', () => {
  assert.equal(
    credentialFor(bearer, ctx({ headers: { authorization: 'bearer abc' } })),
    'abc'
  )
})

test('a missing or malformed authorization header yields no credential', () => {
  assert.equal(credentialFor(bearer, ctx()), undefined)
  assert.equal(
    credentialFor(bearer, ctx({ headers: { authorization: 'Basic abc' } })),
    undefined
  )
})

test('extracts an apiKey from a header, a query param, and a cookie', () => {
  assert.equal(credentialFor(apiKey, ctx({ headers: { 'x-api-key': 'k' } })), 'k')
  assert.equal(
    credentialFor(
      { type: 'apiKey', location: 'query', name: 'key' },
      ctx({ query: { key: 'k' } })
    ),
    'k'
  )
  assert.equal(
    credentialFor(
      { type: 'apiKey', location: 'cookie', name: 'sid' },
      ctx({ headers: { cookie: 'a=1; sid=k' } })
    ),
    'k'
  )
})

const schemes = { bearerAuth: bearer, apiKey }

test('no requirements means no auth', async () => {
  const outcome = await checkAuth({
    security: undefined, schemes, config: {}, ctx: ctx()
  })
  assert.equal(outcome.ok, true)
})

test('an empty requirement list means auth is explicitly not required', async () => {
  const outcome = await checkAuth({ security: [], schemes, config: {}, ctx: ctx() })
  assert.equal(outcome.ok, true)
})

test('a missing credential is a 401', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }], schemes, config: {}, ctx: ctx()
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 401)
})

test('a present credential passes a presence-only check', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: {},
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
})

test('requirements are OR across the array', async () => {
  // bearerAuth is absent, apiKey is present - one satisfied object is enough.
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }, { apiKey: [] }],
    schemes,
    config: {},
    ctx: ctx({ headers: { 'x-api-key': 'k' } })
  })
  assert.equal(outcome.ok, true)
})

test('requirements are AND within one object', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [], apiKey: [] }],
    schemes,
    config: {},
    ctx: ctx({ headers: { 'x-api-key': 'k' } })
  })
  assert.equal(outcome.ok, false)
})

test('verify returning a principal succeeds and the principal is returned', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: { bearerAuth: { verify: () => ({ sub: 'u_1' }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.principal?.sub, 'u_1')
})

test('verify may be async', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: { bearerAuth: { verify: async () => ({ sub: 'u_2' }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.principal?.sub, 'u_2')
})

test('verify returning a Response denies with it', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: [] }],
    schemes,
    config: { bearerAuth: { verify: () => new Response(null, { status: 401 }) } },
    ctx: ctx({ headers: { authorization: 'Bearer expired' } })
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.ok(outcome.response)
})

test('unmet scopes are a 403, not a 401', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: ['orders:write'] }],
    schemes,
    config: { bearerAuth: { verify: () => ({ scopes: ['orders:read'] }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 403)
})

test('met scopes pass', async () => {
  const outcome = await checkAuth({
    security: [{ bearerAuth: ['orders:read'] }],
    schemes,
    config: { bearerAuth: { verify: () => ({ scopes: ['orders:read', 'x'] }) } },
    ctx: ctx({ headers: { authorization: 'Bearer abc' } })
  })
  assert.equal(outcome.ok, true)
})

test('a requirement naming an undeclared scheme fails closed', async () => {
  const outcome = await checkAuth({
    security: [{ ghost: [] }], schemes, config: {}, ctx: ctx()
  })
  assert.equal(outcome.ok, false)
})
```

Create `test/server/auth.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'

// A dedicated document rather than the shared petstore: adding security to that
// fixture would make every existing /pets/7 test start failing on 401.
const doc = {
  openapi: '3.1.0',
  paths: {
    '/guarded': {
      get: {
        operationId: 'guarded',
        security: [{ bearerAuth: ['pets:read'] }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
              }
            }
          }
        }
      }
    },
    '/open': {
      get: { operationId: 'open', responses: { '200': { description: 'ok' } } }
    }
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }
  }
}

const api = loadApi(doc)
const withToken = { headers: { authorization: 'Bearer abc' } }

test('a protected operation without a credential is 401', async () => {
  const handle = createHandler(api, { seed: 'auth' })
  assert.equal((await handle(new Request('http://mock/guarded'))).status, 401)
})

test('a credential satisfies the presence check', async () => {
  const handle = createHandler(api, { seed: 'auth' })
  const response = await handle(new Request('http://mock/guarded', withToken))
  assert.equal(response.status, 200)
})

test('an unprotected operation is unaffected', async () => {
  const handle = createHandler(api, { seed: 'auth' })
  assert.equal((await handle(new Request('http://mock/open'))).status, 200)
})

test('the principal from verify reaches ctx.auth', async () => {
  const seen: unknown[] = []
  const handle = createHandler(api, {
    seed: 'auth',
    auth: { bearerAuth: { verify: () => ({ sub: 'u_9', scopes: ['pets:read'] }) } },
    operations: {
      guarded: {
        respond: (ctx: any) => {
          seen.push(ctx.auth)
          return ctx.respond(200, { ok: true })
        }
      }
    }
  })
  await handle(new Request('http://mock/guarded', withToken))
  assert.deepEqual(seen[0], { sub: 'u_9', scopes: ['pets:read'] })
})

test('unmet scopes are a 403', async () => {
  const handle = createHandler(api, {
    seed: 'auth',
    auth: { bearerAuth: { verify: () => ({ scopes: [] }) } }
  })
  const response = await handle(new Request('http://mock/guarded', withToken))
  assert.equal(response.status, 403)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/auth.test.ts test/server/auth.test.ts`
Expected: FAIL - `auth.ts` does not exist.

- [ ] **Step 3: Implement `src/runtime/auth.ts`**

```ts
import type { SecurityRequirement, SecurityScheme } from '../spec/types.ts'
import type { Ctx } from './types.ts'

export type Principal = { sub?: string; scopes?: string[] } & Record<string, unknown>

export interface AuthSchemeConfig {
  verify?(
    credential: string,
    ctx: Ctx
  ): Principal | Response | Promise<Principal | Response>
}

export type AuthConfig = Record<string, true | AuthSchemeConfig>

export type AuthOutcome =
  | { ok: true; principal?: Principal }
  | { ok: false; status: number; code: string; message: string; response?: Response }

export interface AuthInput {
  security: SecurityRequirement[] | undefined
  schemes: Record<string, SecurityScheme>
  config: AuthConfig
  ctx: Ctx
}

function cookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

/** Pulls the credential a scheme describes out of the request. */
export function credentialFor(
  scheme: SecurityScheme,
  ctx: Ctx
): string | undefined {
  if (scheme.type === 'apiKey') {
    const name = scheme.name ?? ''
    if (scheme.location === 'query') {
      const found = ctx.query[name]
      return Array.isArray(found) ? found[0] : found
    }
    if (scheme.location === 'cookie') return cookie(ctx.headers['cookie'], name)
    return ctx.headers[name.toLowerCase()]
  }

  // http basic/bearer, and oauth2/openIdConnect which are bearer in practice.
  const header = ctx.headers['authorization']
  if (header === undefined) return undefined
  const want = scheme.type === 'http' ? (scheme.scheme ?? 'bearer') : 'bearer'
  const [word, ...rest] = header.split(' ')
  if ((word ?? '').toLowerCase() !== want.toLowerCase()) return undefined
  const value = rest.join(' ').trim()
  return value.length > 0 ? value : undefined
}

function missing(scheme: string): AuthOutcome {
  return {
    ok: false,
    status: 401,
    code: 'MOCK_UNAUTHORIZED',
    message: `Missing or malformed credential for security scheme "${scheme}"`
  }
}

/**
 * OpenAPI security semantics, which are easy to invert:
 *  - the `security` array is OR - any ONE requirement object satisfied is enough
 *  - within one object it is AND - every scheme named must be satisfied
 *  - `security: []` means auth is explicitly NOT required, which is different
 *    from an absent `security` field
 */
export async function checkAuth(input: AuthInput): Promise<AuthOutcome> {
  const { security } = input
  if (security === undefined || security.length === 0) return { ok: true }

  let firstFailure: AuthOutcome | undefined
  let principal: Principal | undefined

  for (const requirement of security) {
    let satisfied = true
    let failure: AuthOutcome | undefined
    let found: Principal | undefined

    for (const [name, scopes] of Object.entries(requirement)) {
      const scheme = input.schemes[name]
      if (!scheme) {
        // A requirement naming a scheme the document never declared cannot be
        // satisfied. Failing closed is the safe reading.
        satisfied = false
        failure = missing(name)
        break
      }

      const credential = credentialFor(scheme, input.ctx)
      if (credential === undefined) {
        satisfied = false
        failure = missing(name)
        break
      }

      const entry = input.config[name]
      const verify = entry !== undefined && entry !== true ? entry.verify : undefined
      if (!verify) continue

      const verified = await verify(credential, input.ctx)
      if (verified instanceof Response) {
        satisfied = false
        failure = {
          ok: false,
          status: verified.status,
          code: 'MOCK_UNAUTHORIZED',
          message: 'Credential rejected',
          response: verified
        }
        break
      }

      const granted = verified.scopes ?? []
      const unmet = scopes.filter((scope) => !granted.includes(scope))
      if (unmet.length > 0) {
        satisfied = false
        failure = {
          ok: false,
          status: 403,
          code: 'MOCK_FORBIDDEN',
          message: `Missing required scope(s): ${unmet.join(', ')}`
        }
        break
      }

      found = { ...(found ?? {}), ...verified }
    }

    if (satisfied) {
      principal = found
      return { ok: true, principal }
    }
    // Report the first requirement's failure: it is the one the API author
    // listed first, and so the one a client most likely intended to satisfy.
    if (!firstFailure) firstFailure = failure
  }

  return firstFailure ?? missing(Object.keys(security[0] ?? {})[0] ?? 'unknown')
}
```

- [ ] **Step 4: Add `auth` and `deny` to `Ctx`**

In `src/runtime/types.ts`, add to the `Ctx` interface:

```ts
  auth?: unknown
  deny(status: number, code?: string): Response
```

In `src/runtime/context.ts`, add `deny` to the returned object:

```ts
    deny(status, code) {
      return Response.json(
        { error: { code: code ?? 'MOCK_DENIED', message: `Denied with ${status}` } },
        { status }
      )
    },
```

`auth` is assigned by the auth stage rather than at construction, so it needs no
entry in `createContext`.

- [ ] **Step 5: Add the auth stage to `src/server/handler.ts`**

Add `auth?: AuthConfig` to `HandlerOptions` and import `checkAuth` and
`AuthConfig`. Push the stage BEFORE the validation stage - auth is stage 3 and
validation stage 4, and an unauthenticated caller should not learn whether their
body was well-formed:

```ts
    stages.push(async (current) => {
      const outcome = await checkAuth({
        security: operation.security,
        schemes: api.securitySchemes,
        config: options.auth ?? {},
        ctx: current
      })
      if (outcome.ok) {
        current.auth = outcome.principal
        return undefined
      }
      if (outcome.response) return outcome.response
      return await fail(
        operation, outcome.status, outcome.code, outcome.message, key, current
      )
    })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/runtime/auth.test.ts test/server/auth.test.ts`
Expected: PASS, 16 auth unit tests and 5 server tests.

- [ ] **Step 7: Run the whole suite, typecheck, determinism**

Run: `npm test`
Expected: PASS with every pre-existing test unmodified. The shared petstore
fixture deliberately declares no security, so no existing test starts hitting a
401. If one does, something enforced auth where the document asked for none -
investigate rather than adding credentials to the test.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged, and `scripts/determinism.ts` needs no edit - the petstore
declares no security.

- [ ] **Step 8: Commit**

```sh
git add src/runtime/auth.ts src/runtime/types.ts src/runtime/context.ts src/server/handler.ts test/runtime/auth.test.ts test/server/auth.test.ts
```

```sh
git commit -m 'feat: enforce spec-driven auth' -m 'securitySchemes and per-operation security are enforced by default. A missing or malformed credential is a 401 and unmet scopes are a 403, both in the operation own error shape.' -m 'The three OpenAPI semantics that are easy to invert each get a test: OR across the security array, AND within one requirement object, and security: [] meaning explicitly no auth rather than inheriting the document default.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

## Definition of Done

- [ ] `npm test` passes with every test file green.
- [ ] `npx tsc --noEmit` reports no errors.
- [ ] `grep -rn "from 'node:" src/spec src/schema src/generate src/resolve src/runtime src/server/handler.ts` returns nothing.
- [ ] `grep -rn "Math.random\|Date.now()" src/generate src/schema src/resolve` returns nothing.
- [ ] `node scripts/determinism.ts` run twice produces byte-identical output, and
      the three generated bodies still match plan 1's values.
- [ ] `src/server/handler.ts` is an orchestrator: route match, body parse, context
      construction, a stage list, and a call to `renderResponse`. Status
      selection, config resolution, and rendering live in their own modules.
- [ ] An internal failure reports `MOCK_INTERNAL`; a user-callback failure
      reports `MOCK_CALLBACK_FAILED`.
- [ ] Every module named in the File Structure table has an isolation test.

## What plan 4 picks up

Phase 6 of the design: `runtime/store.ts` (the `Store` interface and a
`MemoryStore` with an injectable clock), `runtime/failure.ts` (pipeline stage 6 -
`decide`, `failNext`, outage, circuit, rate, latency, with chaos seeded per
invocation), and the async control plane on `src/index.ts`. Pipeline stages 5 and
11 - idempotency and logging - follow in plan 5 along with the CLI.

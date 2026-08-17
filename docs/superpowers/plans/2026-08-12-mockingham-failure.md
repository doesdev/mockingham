# mockingham Failure Simulation Implementation Plan (Phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mock fail on purpose - latency, error rates, outages, and circuit
breakers - driven by declarative policy and an async control plane, without
losing reproducibility.

**Architecture:** Task 1 makes status selection lazy so the pipeline finally runs
stages in the order the design specifies; phase 6 adds three more stages and would
otherwise re-negotiate the same ordering compromise each time. Task 2 closes the
validation gaps plan 3 deferred. Tasks 3–5 add the `Store`, the failure stage, and
the async control plane.

**Tech Stack:** TypeScript (types stripped natively, never compiled), Node >= 24,
`node:test`, `zod` 4.

**Design document:** `docs/superpowers/specs/2026-08-12-mockingham-phases-4-6-design.md` -
read §1 (amendments) and §7 before starting. **Master spec:**
`docs/superpowers/specs/2026-08-11-mockingham-design.md` §§9, 10, 16.

## Global Constraints

- **Node floor >= 24.** Types stripped natively; no build step.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
- **Relative imports MUST carry the `.ts` extension.**
- **`zod` is the only permitted runtime dependency.**
- **One schema interpretation.** `src/schema/walk.ts` is shared by generation and
  the zod compiler. Never add a second traversal.
- **Determinism:** no `Math.random()`, and no `Date.now()` except at an explicit
  construction boundary (see Task 3). `node scripts/determinism.ts` must keep
  printing `/pets/7 200 {"id":843,"name":"cedar","email":"neil.quinn@fjord.io","tag":"gale-marsh"}`.
- **The core is pure.** Nothing reachable from `server/handler.ts` may import a
  `node:` module.
- **The mock keeps serving** when a user callback throws.
- **Errors stay on-contract.**
- **US English spelling** - `honor`, `behavior`, `serialize`, `normalize`.
- **Shell:** one plain command per Bash call, single quotes, no `&&`, no pipes, no
  `$(...)`, no heredocs, no redirects, never `cd`. Repeated `-m` flags for
  multi-paragraph commits. `git push` and `rm -rf` are denied by policy.

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/pipeline.ts` | **New** - lazy selection and the response helper cluster |
| `src/runtime/store.ts` | **New** - `Store` interface and `MemoryStore` with an injectable clock |
| `src/runtime/failure.ts` | **New** - pipeline stage 6 |
| `src/runtime/body.ts` | **Modified** - exports media-type matching |
| `src/schema/compile.ts` | **Modified** - `additionalProperties` schema, `oneOf` exactly-one |
| `src/runtime/validate.ts` | **Modified** - media matching, required body |
| `src/spec/types.ts`, `src/spec/load.ts` | **Modified** - `requestBodyRequired` |
| `src/server/handler.ts` | **Modified** - orchestrates the lazy pipeline and the failure stage |
| `src/index.ts` | **Modified** - async control plane |

## Task Dependency Graph

```
Task 1 (lazy pipeline) ─┬─ Task 4 (failure stage) ─ Task 5 (control plane)
Task 2 (validation gaps)│
Task 3 (Store) ─────────┘
```

**Parallel batch A:** Tasks 1, 2, 3 - no shared files. Tasks 1 and 2 both touch
nothing the other does (Task 1 is `handler.ts` plus a new module; Task 2 is
`validate.ts`/`compile.ts`/`body.ts`/`spec`). Run them serially anyway if your
runner commits to one branch.
**Then:** Task 4, then Task 5.

---

### Task 1: Lazy status selection

Status selection currently runs before the stage list, which inverts the design's
stage order and forced a workaround in plan 3. Making it lazy lets stages run
first, and moves the response helper cluster out of `handler.ts`.

**Files:**
- Create: `src/runtime/pipeline.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/pipeline.test.ts`
- Test: `test/server/stage-order.test.ts`

**Interfaces:**
- Consumes: `selectResponse`, `Selection` from `src/runtime/select.ts`;
  `generateValue`, `GenerateOptions` from `src/generate/generate.ts`; `createRng`,
  `Rng` from `src/generate/rng.ts`.
- Produces: `createResponders(input: RespondersInput): Responders`, where
  `Responders` is
  `{ rngFor(label: string): Rng; selection(): Selection | undefined; generate(status?: number): unknown; example(status?: number, name?: string): unknown; generateOptions: GenerateOptions }`.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/pipeline.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResponders } from '../../src/runtime/pipeline.ts'
import type { Operation, ResponseSpec } from '../../src/spec/types.ts'

function spec(status: number): ResponseSpec {
  return {
    status,
    headers: {},
    content: {
      'application/json': {
        schema: { type: 'object', properties: { a: { type: 'string' } } },
        examples: { empty: { value: { a: '' } } }
      }
    }
  }
}

function operation(responses: ResponseSpec[]): Operation {
  return { method: 'get', path: '/x', parameters: [], responses }
}

function build(responses: ResponseSpec[], prefer?: string) {
  return createResponders({
    operation: operation(responses),
    request: new Request('http://mock/x', prefer ? { headers: { prefer } } : undefined),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {}
  })
}

test('selection is memoized', () => {
  // selectResponse builds a fresh { spec, source } each call, so identity across
  // two calls is proof the second one did not recompute. Laziness itself is
  // proven behaviorally by test/server/stage-order.test.ts - an unauthenticated
  // request to a response-less operation gets 401 rather than the 501 that only
  // an eager selection could produce.
  const responders = build([spec(200)])
  assert.strictEqual(responders.selection(), responders.selection())
})

test('selection returns undefined when the operation declares nothing', () => {
  assert.equal(build([]).selection(), undefined)
})

test('generate produces a value for the selected status', () => {
  const value = build([spec(200)]).generate() as Record<string, unknown>
  assert.equal(typeof value['a'], 'string')
})

test('generate for an explicit status uses that response', () => {
  const responders = build([spec(200), spec(404)])
  assert.equal(typeof (responders.generate(404) as Record<string, unknown>)['a'], 'string')
})

test('generate returns undefined when nothing is selected', () => {
  assert.equal(build([]).generate(), undefined)
})

test('generate returns undefined for a status with no JSON content', () => {
  const responders = createResponders({
    operation: operation([{ status: 204, headers: {}, content: {} }]),
    request: new Request('http://mock/x'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {}
  })
  assert.equal(responders.generate(), undefined)
})

test('example returns a named example', () => {
  assert.deepEqual(build([spec(200)]).example(200, 'empty'), { a: '' })
})

test('example returns undefined for an unknown name', () => {
  assert.equal(build([spec(200)]).example(200, 'nope'), undefined)
})

test('rngFor is stable for the same label', () => {
  const responders = build([spec(200)])
  assert.equal(responders.rngFor('a').next(), responders.rngFor('a').next())
})

test('rngFor differs across labels', () => {
  const responders = build([spec(200)])
  assert.notEqual(responders.rngFor('a').next(), responders.rngFor('b').next())
})

test('Prefer still selects a declared status', () => {
  assert.equal(build([spec(200), spec(404)], 'status=404').selection()?.spec.status, 404)
})
```

Create `test/server/stage-order.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'

const guarded = loadApi({
  openapi: '3.1.0',
  paths: {
    '/secret/{id}': {
      get: {
        operationId: 'secret',
        security: [{ b: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }
        ],
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } }
})

test('auth answers before validation', async () => {
  // Both are wrong: no credential AND a non-integer id. Auth is stage 3 and
  // validation stage 4, so the caller must learn about auth and nothing else.
  const handle = createHandler(guarded, { seed: 'order' })
  const response = await handle(new Request('http://mock/secret/abc'))
  assert.equal(response.status, 401)
})

test('validation answers once authenticated', async () => {
  const handle = createHandler(guarded, { seed: 'order' })
  const response = await handle(
    new Request('http://mock/secret/abc', { headers: { authorization: 'Bearer x' } })
  )
  assert.equal(response.status, 400)
})

test('an unauthenticated request never reaches a response callback', async () => {
  let reached = false
  const handle = createHandler(guarded, {
    seed: 'order',
    operations: {
      secret: {
        respond: (ctx) => {
          reached = true
          return ctx.respond(200, {})
        }
      }
    }
  })
  const response = await handle(new Request('http://mock/secret/1'))
  assert.equal(response.status, 401)
  assert.equal(reached, false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/pipeline.test.ts test/server/stage-order.test.ts`
Expected: FAIL - `pipeline.ts` does not exist.

- [ ] **Step 3: Create `src/runtime/pipeline.ts`**

```ts
import type { MediaType, Operation } from '../spec/types.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { generateValue } from '../generate/generate.ts'
import { createRng } from '../generate/rng.ts'
import type { Rng } from '../generate/rng.ts'
import { selectResponse } from './select.ts'
import type { Selection } from './select.ts'

const JSON_TYPE = 'application/json'

export interface RespondersInput {
  operation: Operation
  request: Request
  staticStatus: number | undefined
  key: string
  generateOptions: GenerateOptions
}

export interface Responders {
  rngFor(label: string): Rng
  selection(): Selection | undefined
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
  generateOptions: GenerateOptions
}

/**
 * The response helper cluster, with status selection DEFERRED.
 *
 * Selection used to run before the pipeline's stage list, which inverted the
 * stage order the design specifies - auth is stage 3 and selection stage 7 - and
 * leaked operation metadata to unauthenticated callers. Making it lazy lets every
 * stage run first, while `ctx.generate`/`ctx.example` still work inside a user
 * callback because they trigger selection on demand.
 */
export function createResponders(input: RespondersInput): Responders {
  let computed = false
  let cached: Selection | undefined

  const selection = (): Selection | undefined => {
    if (!computed) {
      computed = true
      cached = selectResponse(input.operation, input.request, input.staticStatus)
    }
    return cached
  }

  const rngFor = (label: string): Rng => createRng(`${input.key}|${label}`)

  const mediaFor = (status: number): MediaType | undefined =>
    input.operation.responses.find((response) => response.status === status)
      ?.content[JSON_TYPE]

  const targetFor = (status?: number): number | undefined =>
    status === undefined ? selection()?.spec.status : status

  return {
    rngFor,
    selection,
    generateOptions: input.generateOptions,

    generate(status) {
      const target = targetFor(status)
      if (target === undefined) return undefined
      const media = mediaFor(target)
      if (!media) return undefined
      return generateValue(media.schema, rngFor(String(target)), input.generateOptions)
    },

    example(status, name) {
      const target = targetFor(status)
      if (target === undefined) return undefined
      const media = mediaFor(target)
      if (!media) return undefined
      if (name === undefined) return media.example
      return media.examples?.[name]?.value
    }
  }
}
```

- [ ] **Step 4: Rewire `src/server/handler.ts`**

Delete the whole helper cluster from `run` - `generateOptions`, `rngFor`,
`mediaFor`, `generateFor`, `exampleFor`, and the `selected`/`chosen`/`source`
bindings that precede them. Add the import:

```ts
import { createResponders } from '../runtime/pipeline.ts'
```

In their place, build the responders:

```ts
    const key = requestKey(operation, params, seed)
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
      }
    })
```

Pass `responders.generate` and `responders.example` to `createContext`, and
`responders.rngFor('ctx')` as the rng. `ctx` no longer needs a selection to exist.

After the stage loop and before the `config.respond` call, resolve the selection:

```ts
    // Stage 7 - status selection, now that every short-circuiting stage has run.
    const selected = responders.selection()
    if (!selected) {
      return await fail(
        operation,
        501,
        'MOCK_NO_RESPONSE',
        `Operation ${operation.method} ${operation.path} declares no responses`,
        key,
        ctx
      )
    }
    const chosen = selected.spec
```

Then pass `chosen`, `responders.rngFor`, `responders.generateOptions`,
`responders.generate`, and `responders.example` to `renderResponse`, with
`source: selected.source` in the debug block.

- [ ] **Step 5: Make the 405 on-contract**

Design §1.5 lists 405 among the statuses that go through the on-contract path, but
`handler.ts` returns a bare `Response` with only an `Allow` header. It has no
operation - the path matched but the method did not - so it uses the envelope,
exactly like 404. Replace the 405 return with:

```ts
      if (allowed.length > 0) {
        const response = await fail(
          undefined,
          405,
          'MOCK_METHOD_NOT_ALLOWED',
          `Allowed methods: ${allowed.join(', ')}`,
          seed
        )
        response.headers.set('allow', allowed.join(', '))
        return response
      }
```

Add to `test/server/handler.test.ts`:

```ts
test('a 405 carries both the Allow header and an error body', async () => {
  const handle = createHandler(loadApi(petstore), { seed: '405' })
  const response = await handle(
    new Request('http://mock/pets/7', { method: 'DELETE' })
  )
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET')
  assert.equal(((await response.json()) as any).error.code, 'MOCK_METHOD_NOT_ALLOWED')
})
```

Note: an existing test asserts the 405 `Allow` header. It must still pass
unmodified - the header behavior does not change, only the body appears.

- [ ] **Step 6: Run the tests, suite, typecheck, determinism**

Run: `node --test test/runtime/pipeline.test.ts test/server/stage-order.test.ts`
Expected: PASS, 12 pipeline tests and 3 stage-order tests.

Run: `npm test`
Expected: PASS, all 330 pre-existing tests unmodified except none.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

- [ ] **Step 7: Commit**

```sh
git add src/runtime/pipeline.ts src/server/handler.ts test/runtime/pipeline.test.ts test/server/stage-order.test.ts test/server/handler.test.ts
```

```sh
git commit -m 'refactor: defer status selection until after the stage list' -m 'Selection ran before the pipeline stages, inverting the stage order the design specifies and forcing a workaround when it leaked operation metadata pre-auth. It is now lazy and memoized, so every short-circuiting stage runs first while ctx.generate still works inside a user callback.' -m 'The response helper cluster moves out of handler.ts into runtime/pipeline.ts, and the 405 gains an error body to match the other self-emitted statuses.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 2: Validation completeness

Four gaps plan 3's final review recorded as deferred.

**Files:**
- Modify: `src/runtime/body.ts`
- Modify: `src/schema/compile.ts`
- Modify: `src/runtime/validate.ts`
- Modify: `src/spec/types.ts`
- Modify: `src/spec/load.ts`
- Test: `test/runtime/body.test.ts`, `test/schema/compile.test.ts`,
  `test/runtime/validate.test.ts`, `test/spec/load.test.ts` (all append)

**Interfaces:**
- Produces: `pickMedia(content: Record<string, MediaType>, mediaType?: string): MediaType | undefined`
  from `src/runtime/body.ts`; `Operation.requestBodyRequired?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/runtime/body.test.ts`:

```ts
import { pickMedia } from '../../src/runtime/body.ts'

test('pickMedia matches an exact media type', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/json'))
})

test('pickMedia matches a +json suffix against a JSON entry', () => {
  // body.ts already PARSES application/vnd.api+json as JSON, so validation must
  // match it too, or a parsed body is silently never validated.
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/vnd.api+json'))
})

test('pickMedia matches a declared suffix type exactly', () => {
  const content = { 'application/vnd.api+json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/vnd.api+json'))
})

test('pickMedia ignores parameters on the media type', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, 'application/json; charset=utf-8'))
})

test('pickMedia returns undefined for an unrelated type', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.equal(pickMedia(content, 'text/plain'), undefined)
})

test('pickMedia falls back to the JSON entry when no type is given', () => {
  const content = { 'application/json': { schema: { type: 'string' } } }
  assert.ok(pickMedia(content, undefined))
})
```

Append to `test/schema/compile.test.ts`:

```ts
test('additionalProperties as a schema constrains unknown keys', () => {
  const schema: Schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: { type: 'integer' }
  }
  assert.equal(parse(schema, { a: 'x', extra: 1 }).success, true)
  assert.equal(parse(schema, { a: 'x', extra: 'no' }).success, false)
})

test('oneOf requires exactly one variant to match', () => {
  // classify carries `mode` precisely so a validator can tell oneOf from anyOf.
  const schema: Schema = {
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } }
    ]
  }
  // Both variants are loose objects, so this matches BOTH - oneOf must reject it.
  assert.equal(parse(schema, { a: 'x', b: 'y' }).success, false)
})

test('anyOf accepts a value matching several variants', () => {
  const schema: Schema = {
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } }
    ]
  }
  assert.equal(parse(schema, { a: 'x', b: 'y' }).success, true)
})

test('oneOf still accepts a value matching exactly one variant', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  assert.equal(parse(schema, 'x').success, true)
  assert.equal(parse(schema, 1).success, true)
  assert.equal(parse(schema, true).success, false)
})
```

Append to `test/spec/load.test.ts`:

```ts
test('records whether a request body is required', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/a': {
        post: {
          operationId: 'a',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } }
          },
          responses: { '200': { description: 'ok' } }
        }
      }
    }
  }
  assert.equal(loadApi(doc).operations[0]?.requestBodyRequired, true)
})

test('an absent required flag is falsy', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/a': {
        post: {
          operationId: 'a',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'ok' } }
        }
      }
    }
  }
  assert.notEqual(loadApi(doc).operations[0]?.requestBodyRequired, true)
})
```

Append to `test/runtime/validate.test.ts`:

```ts
test('a missing required body is reported', () => {
  const operation = op([], {
    'application/json': { schema: { type: 'object' } }
  })
  operation.requestBodyRequired = true
  const result = validateRequest(ctx({ body: undefined }), operation)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.errors[0]?.path, 'body')
})

test('a missing optional body is fine', () => {
  const operation = op([], { 'application/json': { schema: { type: 'object' } } })
  assert.deepEqual(validateRequest(ctx({ body: undefined }), operation), { ok: true })
})

test('a suffix JSON body is validated', () => {
  const operation = op([], {
    'application/json': {
      schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }
    }
  })
  const result = validateRequest(
    ctx({ body: { a: 1 }, mediaType: 'application/vnd.api+json' }), operation
  )
  assert.equal(result.ok, false)
})
```

The `ctx` helper in that file must gain a `mediaType` passthrough; add it to the
partial it spreads.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/body.test.ts test/schema/compile.test.ts test/runtime/validate.test.ts test/spec/load.test.ts`
Expected: FAIL.

- [ ] **Step 3: Export media matching from `src/runtime/body.ts`**

Export the existing `baseMediaType` and add:

```ts
import type { MediaType } from '../spec/types.ts'

/**
 * Finds the media entry a request's content type should be validated against.
 *
 * `body.ts` parses any `+json` suffix type as JSON, so validation has to match
 * the same way - otherwise a parsed `application/vnd.api+json` body is silently
 * never validated. An exact match always wins; a `+json` type falls back to the
 * plain JSON entry.
 */
export function pickMedia(
  content: Record<string, MediaType>,
  mediaType?: string
): MediaType | undefined {
  const base = mediaType === undefined ? undefined : baseMediaType(mediaType)
  if (base !== undefined) {
    const exact = content[base]
    if (exact) return exact
    if (base.endsWith('+json')) return content['application/json']
    return undefined
  }
  return content['application/json']
}
```

`baseMediaType` currently takes `string | null`; widen it to accept a `string` and
keep its existing null handling, or add a thin wrapper - either is fine as long as
there is one implementation.

> **CORRECTION FOUND DURING IMPLEMENTATION.** The gap is in NEGOTIATION, not
> validation, and `pickMedia` alone does not close it. `parseBody` gates on
> `declared.includes(mediaType)` with exact-string matching and returns 415
> BEFORE validation runs, so a `application/vnd.api+json` request against a
> document declaring `application/json` never reaches `validateRequest` at all -
> it is rejected, not parsed-then-unvalidated. `pickMedia`'s fallback would be
> dead code without this. Change the gate too:
>
> ```ts
>   if (
>     declared.length > 0 &&
>     mediaType !== undefined &&
>     pickMedia(operation.requestBody ?? {}, mediaType) === undefined
>   ) {
>     return { ok: false, status: 415, ... }   // message unchanged
>   }
> ```
>
> This only widens what is accepted - an unrelated type such as `text/plain`
> against a JSON-only operation is still a 415. It resolves an inconsistency the
> module already had: `body.ts` parses any `+json` suffix as JSON, so rejecting
> those at negotiation contradicted its own parsing decision.
>
> Add an end-to-end test through the handler, not just a `pickMedia` unit test -
> the unit tests pass either way, which is exactly why this survived. Assert both
> that a well-formed `+json` body returns 200 AND that a schema-invalid one
> returns 400 with the right error path; the second is what proves validation
> actually runs rather than the body being waved through. Both produce 415 before
> the fix.

- [ ] **Step 4: Compile `additionalProperties` and `oneOf` correctly**

In `src/schema/compile.ts`'s `object` case, replace the strict/loose choice with:

```ts
      case 'object': {
        const shape: Record<string, ZodType> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          const compiled = compile(property)
          shape[name] = kind.required.includes(name) ? compiled : compiled.optional()
        }
        if (kind.additional === false) return z.strictObject(shape)
        // An `additionalProperties` SCHEMA constrains unknown keys rather than
        // merely allowing them, so it becomes a catchall.
        if (Object.keys(kind.additional).length > 0) {
          return z.object(shape).catchall(compile(kind.additional))
        }
        return z.looseObject(shape)
      }
```

In the `union` case, honor `mode`. `classify` carries it precisely so a validator
can tell `oneOf` from `anyOf`, and nothing consumed it until now:

```ts
      case 'union': {
        const variants = kind.variants.map((variant) => compile(variant))
        const key = kind.discriminator
        if (key !== undefined && kind.variants.every((variant) => usable(variant, key))) {
          // A discriminator already guarantees at most one match.
          return z.discriminatedUnion(key, variants as never) as ZodType
        }
        if (kind.mode === 'one') {
          // oneOf means EXACTLY one variant matches; a plain union means at
          // least one, which is anyOf's rule.
          return z.unknown().superRefine((value, context) => {
            const matched = variants.filter(
              (variant) => variant.safeParse(value).success
            ).length
            if (matched !== 1) {
              context.addIssue({
                code: 'custom',
                message: `Expected exactly one oneOf variant to match, ${matched} did`
              })
            }
          }) as ZodType
        }
        return z.union(variants as never) as ZodType
      }
```

- [ ] **Step 5: Carry `requestBodyRequired`**

In `src/spec/types.ts`, add to `Operation`:

```ts
  requestBodyRequired?: boolean
```

In `src/spec/load.ts`, where the operation object is built, add:

```ts
        requestBodyRequired: asRecord(op['requestBody'])['required'] === true,
```

- [ ] **Step 6: Use both in `src/runtime/validate.ts`**

Replace the body block with:

```ts
  const body = ctx.body
  const declared = operation.requestBody
    ? pickMedia(operation.requestBody, ctx.mediaType)
    : undefined

  if (body === undefined) {
    if (operation.requestBodyRequired === true) {
      errors.push({ path: 'body', message: 'Required' })
    }
  } else if (declared && !(body instanceof Uint8Array)) {
    check(declared.schema, body, 'body', errors)
  }
```

`Ctx` needs the request's media type for this. Add `mediaType?: string` to `Ctx` in
`src/runtime/types.ts`, set it in `createContext` from a new `mediaType` field on
`ContextInput`, and pass `parsed.body.mediaType` from `handler.ts`.

- [ ] **Step 7: Run the tests, suite, typecheck, determinism**

Run: `node --test test/runtime/body.test.ts test/schema/compile.test.ts test/runtime/validate.test.ts test/spec/load.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS. Watch for a pre-existing test that a stricter `oneOf` now rejects -
if one appears, report it rather than weakening the rule.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged - `additionalProperties` and `oneOf` changes affect validation
only, and the petstore uses neither.

- [ ] **Step 8: Commit**

```sh
git add src/runtime/body.ts src/schema/compile.ts src/runtime/validate.ts src/runtime/types.ts src/runtime/context.ts src/spec/types.ts src/spec/load.ts src/server/handler.ts test/runtime/body.test.ts test/schema/compile.test.ts test/runtime/validate.test.ts test/spec/load.test.ts
```

```sh
git commit -m 'feat: close four validation gaps' -m 'A +json body was parsed and then silently never validated, because media matching was exact-string on both sides. additionalProperties as a schema allowed unknown keys instead of constraining them. oneOf accepted a value matching several variants, although classify carries a mode field precisely so a validator can tell oneOf from anyOf. A wholly missing body never failed, because requestBody.required was absent from the model.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 3: The Store

**Files:**
- Create: `src/runtime/store.ts`
- Test: `test/runtime/store.test.ts`

**Interfaces:**
- Produces: `Store` (`{ get(key): Promise<unknown | undefined>; set(key, value, ttlMs?): Promise<void>; delete(key): Promise<void>; incr(key, by?): Promise<number>; clear(): Promise<void> }`)
  and `createMemoryStore(now?: () => number): Store`.

`clear()` is not in master spec §10's interface; it is added because `reset()` needs
it and every backend can implement it.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/store.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../../src/runtime/store.ts'

function clock(start = 0) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

test('get returns undefined for an unset key', async () => {
  assert.equal(await createMemoryStore().get('nope'), undefined)
})

test('set then get round-trips a value', async () => {
  const store = createMemoryStore()
  await store.set('a', { n: 1 })
  assert.deepEqual(await store.get('a'), { n: 1 })
})

test('set overwrites', async () => {
  const store = createMemoryStore()
  await store.set('a', 1)
  await store.set('a', 2)
  assert.equal(await store.get('a'), 2)
})

test('delete removes a key', async () => {
  const store = createMemoryStore()
  await store.set('a', 1)
  await store.delete('a')
  assert.equal(await store.get('a'), undefined)
})

test('incr starts at the increment and accumulates', async () => {
  const store = createMemoryStore()
  assert.equal(await store.incr('n'), 1)
  assert.equal(await store.incr('n'), 2)
  assert.equal(await store.incr('n', 5), 7)
})

test('incr on a non-numeric value restarts from the increment', async () => {
  const store = createMemoryStore()
  await store.set('n', 'not a number')
  assert.equal(await store.incr('n'), 1)
})

test('a value expires once its ttl elapses', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1, 1000)
  time.advance(999)
  assert.equal(await store.get('a'), 1)
  time.advance(2)
  assert.equal(await store.get('a'), undefined)
})

test('a value without a ttl never expires', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1)
  time.advance(1_000_000)
  assert.equal(await store.get('a'), 1)
})

test('setting a key again resets its ttl', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('a', 1, 1000)
  time.advance(900)
  await store.set('a', 2, 1000)
  time.advance(900)
  assert.equal(await store.get('a'), 2)
})

test('incr respects expiry', async () => {
  const time = clock()
  const store = createMemoryStore(time.now)
  await store.set('n', 5, 1000)
  time.advance(1001)
  assert.equal(await store.incr('n'), 1)
})

test('clear empties the store', async () => {
  const store = createMemoryStore()
  await store.set('a', 1)
  await store.clear()
  assert.equal(await store.get('a'), undefined)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/runtime/store.test.ts`
Expected: FAIL - module missing.

- [ ] **Step 3: Implement `src/runtime/store.ts`**

```ts
export interface Store {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  incr(key: string, by?: number): Promise<number>
  clear(): Promise<void>
}

interface Entry {
  value: unknown
  expiresAt?: number
}

/**
 * The in-process `Store`.
 *
 * `now` is injected because determinism forbids scattering wall-clock reads
 * through the runtime - tests drive expiry with a fake clock rather than by
 * waiting. The default is a FUNCTION called fresh on every operation; the
 * invariant is that this parameter is the only `Date.now()` call site in the
 * runtime, NOT that it is read once. Snapshotting it at construction would
 * freeze the clock and disable expiry altogether.
 *
 * Expiry is lazy: an entry is dropped when it is read after its deadline, not on
 * a timer. That keeps the store free of scheduling and of `node:` imports.
 *
 * `incr` takes no `ttlMs`, so it cannot arm a deadline it was never given: a live
 * entry keeps its existing deadline, while an expired or absent one produces an
 * entry with none. A caller wanting a counter that decays must `set` it with a
 * TTL rather than relying on `incr`.
 */
export function createMemoryStore(now: () => number = () => Date.now()): Store {
  const entries = new Map<string, Entry>()

  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== undefined && now() > entry.expiresAt) {
      entries.delete(key)
      return undefined
    }
    return entry
  }

  return {
    async get(key) {
      return live(key)?.value
    },

    async set(key, value, ttlMs) {
      entries.set(key, {
        value,
        expiresAt: ttlMs === undefined ? undefined : now() + ttlMs
      })
    },

    async delete(key) {
      entries.delete(key)
    },

    async incr(key, by = 1) {
      const current = live(key)?.value
      // A non-numeric or expired value restarts the counter rather than
      // producing NaN, which would poison every later increment.
      const base = typeof current === 'number' ? current : 0
      const next = base + by
      const existing = entries.get(key)
      entries.set(key, { value: next, expiresAt: existing?.expiresAt })
      return next
    },

    async clear() {
      entries.clear()
    }
  }
}
```

- [ ] **Step 4: Run the test, suite, typecheck, commit**

Run: `node --test test/runtime/store.test.ts`
Expected: PASS, 11 tests.

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `grep -rn "Date.now()" src/runtime/store.ts`
Expected: exactly one hit, the default parameter.

```sh
git add src/runtime/store.ts test/runtime/store.test.ts
```

```sh
git commit -m 'feat: add the Store interface and an in-memory implementation' -m 'Expiry is lazy and the clock is injected, so tests drive TTL with a fake clock instead of waiting and the runtime never reads the wall clock outside its construction boundary.' -m 'incr restarts from zero on a non-numeric or expired value rather than producing NaN, which would poison every later increment.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 4: The failure stage

**Files:**
- Create: `src/runtime/failure.ts`
- Modify: `src/server/handler.ts`
- Test: `test/runtime/failure.test.ts`
- Test: `test/server/failure.test.ts`

**Interfaces:**
- Consumes: `Store` from Task 3; `Ctx` from `src/runtime/types.ts`; `fnv1a`,
  `createRng` from `src/generate/rng.ts`.
- Produces: `FailurePolicy`, `Directive`, `checkFailure(input): Promise<FailureOutcome>`.
  `HandlerOptions` gains `failure?: FailurePolicy[]`, `decide?: (ctx: Ctx) => Directive | undefined`,
  `chaosSeed?: string`, `store?: Store`, and `sleep?: (ms: number) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `test/runtime/failure.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFailure } from '../../src/runtime/failure.ts'
import type { FailureInput, FailurePolicy } from '../../src/runtime/failure.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { compileTarget } from '../../src/resolve/target.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { Operation } from '../../src/spec/types.ts'

const operation: Operation = {
  method: 'get', path: '/x', operationId: 'x', parameters: [], responses: []
}

/**
 * Compiles policies the way the handler does, but WITHOUT compilePolicies'
 * construction-time check that every target matches something - one test needs a
 * policy that deliberately matches nothing, and compilePolicies throws on those.
 */
function compile(policies: FailurePolicy[]) {
  return policies.map((policy) => ({
    matches: compileTarget(policy.match).matches,
    policy
  }))
}

function input(overrides: Partial<FailureInput> & { policies?: FailurePolicy[] } = {}) {
  const slept: number[] = []
  const { policies, ...rest } = overrides
  const args: FailureInput = {
    operation,
    ctx: {} as Ctx,
    policies: compile(policies ?? []),
    store: createMemoryStore(),
    chaosSeed: 'chaos',
    requestKey: 'k',
    counter: () => 0,
    sleep: async (ms: number) => { slept.push(ms) },
    ...rest
  }
  return { slept, args }
}

test('no policies means no failure', async () => {
  const { args } = input()
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('a policy matching no operation is ignored', async () => {
  const { args } = input({
    policies: [{ match: 'GET /other', rate: 1, respond: 503 }]
  })
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('rate 1 always fails with the configured status', async () => {
  const { args } = input({ policies: [{ match: 'x', rate: 1, respond: 503 }] })
  const outcome = await checkFailure(args)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 503)
})

test('rate 0 never fails', async () => {
  const { args } = input({ policies: [{ match: 'x', rate: 0, respond: 503 }] })
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('decide wins over every policy', async () => {
  const { args } = input({
    policies: [{ match: 'x', rate: 0 }],
    decide: () => ({ status: 500 })
  })
  const outcome = await checkFailure(args)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.status, 500)
})

test('decide returning undefined falls through', async () => {
  const { args } = input({ policies: [], decide: () => undefined })
  assert.deepEqual(await checkFailure(args), { ok: true })
})

test('failNext fires the configured number of times then stops', async () => {
  const store = createMemoryStore()
  await store.set('failnext|x', { times: 2, status: 500 })
  const { args } = input({ store })
  const first = await checkFailure(args)
  const second = await checkFailure(args)
  const third = await checkFailure(args)
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
  assert.equal(third.ok, true)
})

test('an outage fails until its deadline passes', async () => {
  let time = 0
  const store = createMemoryStore(() => time)
  await store.set('outage|x', { status: 503 }, 1000)
  const { args } = input({ store })
  assert.equal((await checkFailure(args)).ok, false)
  time = 1001
  assert.equal((await checkFailure(args)).ok, true)
})

test('latency is awaited even when the request succeeds', async () => {
  const { args, slept } = input({ policies: [{ match: 'x', latency: 250 }] })
  assert.deepEqual(await checkFailure(args), { ok: true })
  assert.deepEqual(slept, [250])
})

test('a latency function receives ctx', async () => {
  const { args, slept } = input({ policies: [{ match: 'x', latency: () => 42 }] })
  await checkFailure(args)
  assert.deepEqual(slept, [42])
})

test('the circuit opens after the configured failure count', async () => {
  const store = createMemoryStore()
  const { args } = input({
    store,
    policies: [{ match: 'x', rate: 1, respond: 500, circuit: { after: 2, openFor: 1000, then: 429 } }]
  })
  const first = await checkFailure(args)
  const second = await checkFailure(args)
  const third = await checkFailure(args)
  assert.equal(first.ok, false)
  if (!first.ok) assert.equal(first.status, 500)
  assert.equal(second.ok, false)
  // Once open, the circuit's own status takes over.
  assert.equal(third.ok, false)
  if (!third.ok) assert.equal(third.status, 429)
})

test('the same request sequence is reproducible across fresh instances', async () => {
  const run = async () => {
    let n = 0
    const { args } = input({
      policies: [{ match: 'x', rate: 0.5, respond: 503 }],
      counter: () => n++
    })
    const results: boolean[] = []
    for (let i = 0; i < 20; i++) results.push((await checkFailure(args)).ok)
    return results
  }
  assert.deepEqual(await run(), await run())
})

test('repeated identical calls do not all share one outcome', async () => {
  let n = 0
  const { args } = input({
    policies: [{ match: 'x', rate: 0.5, respond: 503 }],
    counter: () => n++
  })
  const results: boolean[] = []
  for (let i = 0; i < 20; i++) results.push((await checkFailure(args)).ok)
  // Seeding per invocation rather than per request identity is what makes a
  // rate behave like a rate instead of a permanent verdict.
  assert.ok(new Set(results).size > 1)
})
```

Create `test/server/failure.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

test('a rate of 1 turns every matching request into the configured status', async () => {
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', rate: 1, respond: 503 }],
    sleep: async () => {}
  })
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 503)
})

test('an unmatched operation is unaffected', async () => {
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', rate: 1, respond: 503 }],
    sleep: async () => {}
  })
  assert.equal((await handle(new Request('http://mock/pets'))).status, 200)
})

test('a failure status is emitted on contract when declared', async () => {
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', rate: 1, respond: 404 }],
    sleep: async () => {}
  })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 404)
})

test('latency is applied through the injected sleep', async () => {
  const slept: number[] = []
  const handle = createHandler(api, {
    seed: 'fail',
    failure: [{ match: 'GET /pets/{petId}', latency: 300 }],
    sleep: async (ms) => { slept.push(ms) }
  })
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 200)
  assert.deepEqual(slept, [300])
})

test('a target matching no operation throws at construction', () => {
  assert.throws(
    () => createHandler(api, { failure: [{ match: 'GET /nope', rate: 1 }] }),
    /matches no operation/
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/runtime/failure.test.ts test/server/failure.test.ts`
Expected: FAIL - `failure.ts` does not exist.

- [ ] **Step 3: Implement `src/runtime/failure.ts`**

```ts
import type { Operation } from '../spec/types.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import { compileTarget } from '../resolve/target.ts'
import type { Ctx } from './types.ts'
import type { Store } from './store.ts'

export interface CircuitPolicy {
  after: number
  openFor: number
  then: number
}

export interface FailurePolicy {
  match: string
  rate?: number
  respond?: number
  latency?: number | ((ctx: Ctx) => number)
  circuit?: CircuitPolicy
}

export interface Directive {
  status: number
  code?: string
}

export type FailureOutcome =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

export interface FailureInput {
  operation: Operation
  ctx: Ctx
  policies: Array<{ matches(operation: Operation): boolean; policy: FailurePolicy }>
  decide?: (ctx: Ctx) => Directive | undefined
  store: Store
  chaosSeed: string
  requestKey: string
  /** Per-request-identity invocation count; see the seeding note below. */
  counter: () => number
  sleep: (ms: number) => Promise<void>
}

const DEFAULT_STATUS = 503

function targetKey(operation: Operation): string {
  return operation.operationId ?? `${operation.method} ${operation.path}`
}

function failure(status: number, message: string): FailureOutcome {
  return { ok: false, status, code: 'MOCK_FAILURE_INJECTED', message }
}

/**
 * Pipeline stage 6, evaluating in the master spec's order: `decide` → one-shot
 * `failNext` → outage → circuit state → rate → latency. Latency applies even when
 * the request succeeds.
 *
 * CHAOS SEEDING. Each roll is seeded from `hash(chaosSeed, requestKey, n)` where
 * `n` is a per-request-identity invocation counter. A single advancing PRNG
 * stream would make a request's outcome depend on how many other requests came
 * first, which breaks under concurrency and when a test runs alone. Seeding from
 * request identity alone would make a request permanently pass or permanently
 * fail, turning `rate: 0.05` into "5% of endpoints" rather than "5% of calls".
 * The counter gives reproducibility AND a rate that behaves like a rate.
 */
export async function checkFailure(input: FailureInput): Promise<FailureOutcome> {
  const key = targetKey(input.operation)
  const matching = input.policies
    .filter((entry) => entry.matches(input.operation))
    .map((entry) => entry.policy)

  // 1. decide() overrides everything.
  if (input.decide) {
    const directive = input.decide(input.ctx)
    if (directive) {
      return failure(directive.status, 'Failure injected by decide()')
    }
  }

  // 2. One-shot failNext.
  const pending = (await input.store.get(`failnext|${key}`)) as
    | { times: number; status?: number }
    | undefined
  if (pending && pending.times > 0) {
    const left = pending.times - 1
    if (left > 0) await input.store.set(`failnext|${key}`, { ...pending, times: left })
    else await input.store.delete(`failnext|${key}`)
    return failure(pending.status ?? DEFAULT_STATUS, 'Failure injected by failNext()')
  }

  // 3. Outage. Its TTL is the deadline, so an expired key simply reads as absent.
  const outage = (await input.store.get(`outage|${key}`)) as
    | { status?: number }
    | undefined
  if (outage) {
    return failure(outage.status ?? DEFAULT_STATUS, 'Failure injected by outage()')
  }

  for (const policy of matching) {
    // 4. Circuit state, before rolling - an open circuit answers immediately.
    if (policy.circuit) {
      const open = await input.store.get(`circuit-open|${key}`)
      if (open !== undefined) {
        return failure(policy.circuit.then, 'Circuit is open')
      }
    }

    // 5. Rate.
    if (policy.rate !== undefined && policy.rate > 0) {
      const seed = fnv1a(`${input.chaosSeed}|${input.requestKey}|${input.counter()}`)
      if (createRng(seed).next() < policy.rate) {
        if (policy.circuit) {
          const failures = await input.store.incr(`circuit-count|${key}`)
          if (failures >= policy.circuit.after) {
            await input.store.set(`circuit-open|${key}`, true, policy.circuit.openFor)
            await input.store.delete(`circuit-count|${key}`)
          }
        }
        return failure(policy.respond ?? DEFAULT_STATUS, 'Failure injected by rate')
      }
    }
  }

  // 6. Latency, applied even on success.
  for (const policy of matching) {
    if (policy.latency === undefined) continue
    const ms =
      typeof policy.latency === 'function' ? policy.latency(input.ctx) : policy.latency
    if (ms > 0) await input.sleep(ms)
  }

  return { ok: true }
}

/** Compiles policy targets once, throwing on one that matches no operation. */
export function compilePolicies(
  policies: FailurePolicy[] | undefined,
  known: Operation[]
): Array<{ matches(operation: Operation): boolean; policy: FailurePolicy }> {
  return (policies ?? []).map((policy) => {
    const matcher = compileTarget(policy.match)
    if (!known.some((operation) => matcher.matches(operation))) {
      throw new Error(
        `mockingham: failure policy target "${policy.match}" matches no operation ` +
          'in the document.'
      )
    }
    return { matches: matcher.matches, policy }
  })
}
```

- [ ] **Step 4: Add the stage to `src/server/handler.ts`**

Add to `HandlerOptions`: `failure?: FailurePolicy[]`, `decide?: (ctx: Ctx) => Directive | undefined`,
`chaosSeed?: string`, `store?: Store`, `sleep?: (ms: number) => Promise<void>`.

At construction:

```ts
  const store = options.store ?? createMemoryStore()
  const policies = compilePolicies(options.failure, api.operations)
  const chaosSeed = options.chaosSeed ?? seed
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const chaosCounts = new Map<string, number>()
```

`setTimeout` is a global, not a `node:` import, so the core stays pure.

Push the failure stage AFTER validation, so a malformed request is still rejected
on its merits rather than by chaos:

```ts
    stages.push(async (current) => {
      const outcome = await checkFailure({
        operation,
        ctx: current,
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
        sleep
      })
      if (outcome.ok) return undefined
      return await fail(operation, outcome.status, outcome.code, outcome.message, key, current)
    })
```

- [ ] **Step 5: Run the tests, suite, typecheck, determinism**

Run: `node --test test/runtime/failure.test.ts test/server/failure.test.ts`
Expected: PASS, 13 unit tests and 5 server tests.

Run: `npm test`
Expected: PASS. With no `failure` configured the stage always returns `ok`, so
nothing pre-existing changes.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

- [ ] **Step 6: Commit**

```sh
git add src/runtime/failure.ts src/server/handler.ts test/runtime/failure.test.ts test/server/failure.test.ts
```

```sh
git commit -m 'feat: add the failure simulation stage' -m 'Evaluates decide, failNext, outage, circuit state, rate, and latency in the specified order, with latency applied even on success. Failure statuses go through the same on-contract path as every other status the mock emits itself.' -m 'Each chaos roll is seeded from the chaos seed, the request identity, and a per-identity invocation counter, so a run replays exactly while a rate still behaves like a rate rather than a permanent verdict.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 5: The async control plane

**Files:**
- Modify: `src/index.ts`
- Modify: `src/server/handler.ts`
- Test: `test/control-plane.test.ts`

**Interfaces:**
- Produces: `Mock` gains `failNext(target, opts): Promise<void>`,
  `outage(target, opts): Promise<void>`, `setSeed(seed): Promise<void>`,
  `reset(): Promise<void>`, and `store: Store`. `createHandler` returns a handler
  object rather than a bare function.

Per design amendment 1.1 every control-plane method returns a `Promise`, including
the two that are in-process, so callers never have to remember which is which.

- [ ] **Step 1: Write the failing test**

Create `test/control-plane.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../src/index.ts'
import { petstore } from './fixtures/petstore.ts'

function mock() {
  return createMock(petstore, { seed: 'control', sleep: async () => {} })
}

test('failNext fails the configured number of requests then recovers', async () => {
  const instance = mock()
  await instance.failNext('GET /pets/{petId}', { times: 2, status: 500 })
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 500)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 500)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 200)
})

test('failNext defaults to one time and a 503', async () => {
  const instance = mock()
  await instance.failNext('GET /pets/{petId}', {})
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 200)
})

test('outage fails every request until reset', async () => {
  const instance = mock()
  await instance.outage('GET /pets/{petId}', { forMs: 60_000 })
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  await instance.reset()
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 200)
})

test('an unmatched control-plane target throws', async () => {
  const instance = mock()
  await assert.rejects(() => instance.failNext('GET /nope', {}), /matches no operation/)
})

test('a wildcard target arms every operation it matches', async () => {
  // Not just the first match - arming one of several would silently leave the
  // rest healthy while the caller believes the whole path is down.
  const instance = mock()
  await instance.outage('* /pets/**', { forMs: 60_000 })
  assert.equal((await instance.fetch(new Request('http://mock/pets/7'))).status, 503)
  assert.equal((await instance.fetch(new Request('http://mock/pets/mine'))).status, 503)
})

test('setSeed changes generated output', async () => {
  const instance = mock()
  const before = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  await instance.setSeed('different')
  const after = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  assert.notEqual(before, after)
})

test('reset restores the original seed and clears counters', async () => {
  const instance = mock()
  const before = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  await instance.setSeed('different')
  await instance.reset()
  const after = await (await instance.fetch(new Request('http://mock/pets/7'))).text()
  assert.equal(before, after)
})

test('the store is exposed', async () => {
  const instance = mock()
  await instance.store.set('k', 1)
  assert.equal(await instance.store.get('k'), 1)
})

test('every control-plane method returns a promise', () => {
  const instance = mock()
  assert.ok(instance.reset() instanceof Promise)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/control-plane.test.ts`
Expected: FAIL - the methods do not exist.

- [ ] **Step 3: Return a handler object from `createHandler`**

The control plane needs to reach the handler's store, seed, and counters, so
`createHandler` returns an object instead of a bare function. Change its return
type to:

```ts
export interface Handler {
  fetch(request: Request): Promise<Response>
  store: Store
  setSeed(next: string): void
  reset(): void
}
```

and return:

```ts
  return {
    fetch: handle,
    store,
    setSeed(next) {
      seed = next
    },
    reset() {
      seed = options.seed ?? 'mockingham'
      counters.reset()
      chaosCounts.clear()
    }
  }
```

`seed` must become `let` rather than `const` for this. Note that `store.clear()` is
async and so is handled by `index.ts`, not here.

**Every existing caller of `createHandler` must now use `.fetch`.** Search for
them - `src/index.ts` and several test files call the returned value directly.
Updating those tests IS expected for this task and is a mechanical change; list
every file you touch in your report.

- [ ] **Step 4: Wire the control plane in `src/index.ts`**

```ts
import { createMemoryStore } from './runtime/store.ts'
import type { Store } from './runtime/store.ts'
import { resolveTarget } from './resolve/target.ts'
import type { Operation } from './spec/types.ts'

export interface FailNextOptions {
  times?: number
  status?: number
}

export interface OutageOptions {
  forMs?: number
  status?: number
}

export interface Mock {
  fetch(request: Request): Promise<Response>
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
  failNext(target: string, opts?: FailNextOptions): Promise<void>
  outage(target: string, opts?: OutageOptions): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  store: Store
  api: Api
}
```

and in `createMock`, after building the handler:

```ts
  // Resolves a control-plane target to EVERY key the failure stage reads, so a
  // typo throws instead of silently arming nothing and a wildcard target arms
  // every operation it matches rather than only the first.
  const keysFor = (target: string): string[] =>
    resolveTarget(target, api.operations).map(
      (operation) => operation.operationId ?? `${operation.method} ${operation.path}`
    )

  return {
    fetch: handler.fetch,
    listen: (port) => server.listen(port),
    close: () => server.close(),

    async failNext(target, opts = {}) {
      for (const key of keysFor(target)) {
        await handler.store.set(`failnext|${key}`, {
          times: opts.times ?? 1,
          status: opts.status ?? 503
        })
      }
    },

    async outage(target, opts = {}) {
      for (const key of keysFor(target)) {
        await handler.store.set(
          `outage|${key}`,
          { status: opts.status ?? 503 },
          opts.forMs
        )
      }
    },

    async setSeed(next) {
      handler.setSeed(next)
    },

    async reset() {
      handler.reset()
      await handler.store.clear()
    },

    store: handler.store,
    api
  }
```

`createNodeServer` takes the fetch function, so pass `handler.fetch` to it.

- [ ] **Step 5: Run the test, suite, typecheck, determinism**

Run: `node --test test/control-plane.test.ts`
Expected: PASS, 9 tests.

Run: `npm test`
Expected: PASS. Test files calling the old bare-function handler are updated
mechanically as described in Step 3.

Run: `npx tsc --noEmit`

Run: `node scripts/determinism.ts`
Expected: unchanged.

- [ ] **Step 6: Commit**

```sh
git add src/index.ts src/server/handler.ts test/control-plane.test.ts
```

```sh
git commit -m 'feat: add the async control plane' -m 'failNext, outage, setSeed, and reset all return promises, including the two that are in-process, so callers never have to remember which touch the Store. Targets resolve through the same matcher the override config uses and throw on a typo.' -m 'createHandler now returns an object rather than a bare function, because the control plane needs the handler store, seed, and counters.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

## Definition of Done

- [ ] `npm test` passes with every test file green.
- [ ] `npx tsc --noEmit` reports no errors.
- [ ] `grep -rn "from 'node:" src/spec src/schema src/generate src/resolve src/runtime src/server/handler.ts` returns nothing.
- [ ] `grep -rn "Math.random" src/` returns nothing. `grep -rn "Date.now()" src/`
      returns only `createMemoryStore`'s default clock parameter and the comment
      above it that names the invariant - two hits in one file, no call sites
      anywhere else.
- [ ] `node scripts/determinism.ts` run twice is byte-identical and still matches
      plan 1's values.
- [ ] Status selection happens AFTER the stage list; an unauthenticated request to
      a response-less secured operation returns 401, not 501.
- [ ] The same request sequence against two fresh instances produces the same
      failure pattern.

## What plan 5 picks up

Pipeline stages 5 and 11 - idempotency (`runtime/idempotency.ts`) and logging
(`runtime/logging.ts`) - plus `server/cli.ts`. Phases 8 and 10–12 of the master
spec (webhooks, MCP, fixtures, docs) follow.

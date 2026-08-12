# mockingham Overrides Implementation Plan (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generated value overridable — by format, by property name, by
schema name, by operation, or by replacing the whole response with a callback.

**Architecture:** Override sources split by what they key on. `byFormat`, `byName`,
and `bySchema` are schema-keyed, so they are consulted inside `generate.ts` at
leaves the existing walk already visits — adding a second schema traversal is
forbidden. `operations[...].body` is value-keyed, so it is a plain value-tree
overlay in `resolve/layer.ts` applied afterward. `handler.ts` becomes an
orchestrator calling uniform stage functions in the design's §2.3 order.

**Tech Stack:** TypeScript (types stripped natively by Node, never compiled),
Node >= 24, `node:test`, `zod` (present as a dependency; not used until plan 3).

**Design document:** `docs/superpowers/specs/2026-08-12-mockingham-phases-4-6-design.md`.
**Master spec:** `docs/superpowers/specs/2026-08-11-mockingham-design.md` §4 and §5.
Read the design document's §1 (amendments) before starting — it overrides the
master spec in six places, two of which affect this plan.

## Global Constraints

Copied verbatim from the design document and `CLAUDE.md`. Every task's
requirements implicitly include this section.

- **Node floor is >= 24.** Types are stripped natively; there is no build step.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
  Use `const X = {...} as const`.
- **Relative imports MUST carry the `.ts` extension** (`import { x } from './refs.ts'`).
  This is the single most common way to break the build.
- **`zod` is the only permitted hard runtime dependency.** No new runtime
  dependency may be added in this plan.
- **One schema interpretation.** `schema/walk.ts` is shared by value generation and
  zod compilation. Never add a second traversal. This constraint is the entire
  reason resolvers live inside `generate.ts` rather than in a post-pass.
- **Determinism:** no `Math.random()`, no `Date.now()`, and no iteration over an
  unordered `Set` or object anywhere in a generation path. Randomness comes only
  from `generate/rng.ts`. The guarantee covers values *mockingham* generates —
  user-supplied override functions are explicitly exempt (design §8).
- **The core is pure.** Nothing reachable from `server/handler.ts` may import a
  `node:` module. Node-only code lives in `server/node.ts`.
- **US English spelling** everywhere — `honor`, `behavior`, `serialize`,
  `normalize`, `canceled`.
- **Shell:** one plain command per Bash call, single-quoted arguments, no `&&`
  chains, no heredocs, no redirects, never `cd`. Multi-paragraph commits use
  repeated `-m` flags.

## File Structure

| File | Responsibility |
|---|---|
| `src/spec/refs.ts` | **Modified** — also returns the schema-name table |
| `src/spec/types.ts` | **Modified** — `Api` gains `schemaNames` |
| `src/spec/load.ts` | **Modified** — threads `schemaNames` onto the `Api` |
| `src/resolve/target.ts` | Target string → operation predicate |
| `src/runtime/body.ts` | Content negotiation and body parsing (stage 2) |
| `src/runtime/types.ts` | `Ctx`, `Resolvers`, override node types — shared vocabulary |
| `src/runtime/context.ts` | `Ctx` construction and the sequence counters |
| `src/resolve/resolvers.ts` | Compiles `byFormat`/`byName`/`bySchema` into one lookup |
| `src/generate/generate.ts` | **Modified** — consults the resolver lookup at each leaf |
| `src/resolve/layer.ts` | Value-tree override overlay, async-aware |
| `src/runtime/headers.ts` | Response header generation and layering |
| `src/server/handler.ts` | **Modified** — stage orchestrator |

`src/runtime/types.ts` exists to break a cycle: `runtime/context.ts` imports
`generateValue`, and `generate.ts` needs the `Ctx` type to type resolver
callbacks. Both import the type from `runtime/types.ts`, which imports neither.

## Task Dependency Graph

```
Task 1 (schemaNames) ──────┬─ Task 5 (resolver hook) ─┐
Task 2 (target strings) ───┤                          │
Task 3 (body parsing) ─ Task 4 (context + types) ─┬─ Task 6 (layer) ──┼─ Task 8 (pipeline) ─ Task 9 (respond)
                                                  └─ Task 7 (headers)─┘
```

**Parallel batch A:** Tasks 1, 2, 3 — no shared files.
**Then:** Task 4 (needs 3), Task 5 (needs 1).
**Parallel batch B:** Tasks 6 and 7 (both need 4).
**Serial tail:** Task 8 → Task 9.

---

### Task 1: The schema-name table

`bySchema: { User: … }` keys on a component name, but after `$ref` resolution a
schema object no longer records that it came from `components.schemas.User`.
Resolution already makes every reference to `User` the same object, so identity is
enough — this task records what resolution already knows.

**Files:**
- Modify: `src/spec/refs.ts`
- Modify: `src/spec/types.ts`
- Modify: `src/spec/load.ts`
- Test: `test/spec/refs.test.ts` (existing tests migrate)
- Test: `test/spec/load.test.ts`

**Interfaces:**
- Consumes: `Schema` from `src/spec/types.ts`.
- Produces: `resolveDocument(doc: Record<string, unknown>): ResolvedDocument`,
  where `ResolvedDocument` is `{ document: Record<string, unknown>; schemaNames: Map<Schema, string> }`.
  **This is a breaking signature change** — it previously returned the document
  directly. `Api` gains `schemaNames: Map<Schema, string>`.

- [ ] **Step 1: Migrate the existing ref tests to the new shape**

Every existing test in `test/spec/refs.test.ts` calls `resolveDocument(doc) as any`
and indexes straight into the document. Each must now go through `.document`.
Rewrite the whole file:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDocument } from '../../src/spec/refs.ts'

test('inlines a simple internal ref', () => {
  const doc = {
    components: { schemas: { User: { type: 'object' } } },
    paths: { '/u': { get: { schema: { $ref: '#/components/schemas/User' } } } }
  }
  const out = resolveDocument(doc).document as any
  assert.equal(out.paths['/u'].get.schema.type, 'object')
})

test('resolves a self-recursive schema without infinite recursion', () => {
  const doc = {
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }
          }
        }
      }
    }
  }
  const out = resolveDocument(doc).document as any
  const node = out.components.schemas.Node
  const inner = node.properties.children.items
  assert.equal(inner.type, 'object')
  assert.strictEqual(inner, node)
  assert.strictEqual(inner.properties.children.items, node)
})

test('resolves a recursive schema reached through an alias', () => {
  const doc = {
    components: {
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: {
          type: 'object',
          properties: { self: { $ref: '#/components/schemas/A' } }
        }
      }
    }
  }
  const out = resolveDocument(doc).document as any
  const b = out.components.schemas.B
  assert.equal(b.type, 'object')
  assert.strictEqual(b.properties.self, b)
  assert.strictEqual(out.components.schemas.A, b)
})

test('throws on a reference chain that never reaches a schema', () => {
  const doc = {
    components: {
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: { $ref: '#/components/schemas/A' }
      }
    }
  }
  assert.throws(() => resolveDocument(doc), /circular \$ref chain/)
})

test('decodes JSON pointer escapes', () => {
  const doc = {
    components: { schemas: { 'a/b': { type: 'string' } } },
    x: { $ref: '#/components/schemas/a~1b' }
  }
  const out = resolveDocument(doc).document as any
  assert.equal(out.x.type, 'string')
})

test('throws on an external ref', () => {
  const doc = { x: { $ref: 'other.json#/Thing' } }
  assert.throws(() => resolveDocument(doc), /only internal \$ref/)
})

test('throws on an unresolvable ref, naming the pointer', () => {
  const doc = { x: { $ref: '#/components/schemas/Missing' } }
  assert.throws(() => resolveDocument(doc), /#\/components\/schemas\/Missing/)
})

test('does not mutate the input document', () => {
  const doc = {
    components: { schemas: { User: { type: 'object' } } },
    x: { $ref: '#/components/schemas/User' }
  }
  resolveDocument(doc)
  assert.deepEqual((doc as any).x, { $ref: '#/components/schemas/User' })
})

test('names every component schema by identity', () => {
  const doc = {
    components: {
      schemas: {
        User: { type: 'object', properties: { id: { type: 'integer' } } },
        Pet: { type: 'object' }
      }
    },
    paths: { '/u': { get: { schema: { $ref: '#/components/schemas/User' } } } }
  }
  const { document, schemaNames } = resolveDocument(doc)
  const user = (document as any).paths['/u'].get.schema
  assert.equal(schemaNames.get(user), 'User')
  assert.equal(schemaNames.get((document as any).components.schemas.Pet), 'Pet')
})

test('an alias records the first declared name', () => {
  const doc = {
    components: {
      schemas: {
        A: { type: 'object' },
        B: { $ref: '#/components/schemas/A' }
      }
    }
  }
  const { document, schemaNames } = resolveDocument(doc)
  // A and B resolve to the same object; the first declared name wins so the
  // table is stable no matter what order later code reads it in.
  assert.strictEqual((document as any).components.schemas.A, (document as any).components.schemas.B)
  assert.equal(schemaNames.get((document as any).components.schemas.A), 'A')
})

test('schemas outside components are absent from the table', () => {
  const doc = { paths: { '/u': { get: { schema: { type: 'string' } } } } }
  const { document, schemaNames } = resolveDocument(doc)
  assert.equal(schemaNames.get((document as any).paths['/u'].get.schema), undefined)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/spec/refs.test.ts`
Expected: FAIL — `resolveDocument(...).document` is undefined, and the three new
tests fail on `schemaNames` being undefined.

- [ ] **Step 3: Change `resolveDocument` to return the table**

In `src/spec/refs.ts`, add the import and the exported interface at the top, then
replace only the final `return` statement of `resolveDocument`. The `lookup` and
`walk` functions do not change.

Add at the top of the file:

```ts
import type { Schema } from './types.ts'

export interface ResolvedDocument {
  document: Record<string, unknown>
  schemaNames: Map<Schema, string>
}
```

Change the signature line from `): Record<string, unknown> {` to `): ResolvedDocument {`.

Replace the final `return walk(doc) as Record<string, unknown>` with:

```ts
  const document = walk(doc) as Record<string, unknown>
  const schemaNames = new Map<Schema, string>()

  const components = document['components']
  if (components !== null && typeof components === 'object') {
    const schemas = (components as Record<string, unknown>)['schemas']
    if (schemas !== null && typeof schemas === 'object') {
      for (const [name, schema] of Object.entries(
        schemas as Record<string, unknown>
      )) {
        if (schema === null || typeof schema !== 'object') continue
        // An alias (`A: { $ref: '.../B' }`) resolves to the very same object as
        // its target, so both names would map to one schema. First declared
        // name wins, which keeps the table stable regardless of read order.
        if (!schemaNames.has(schema as Schema)) {
          schemaNames.set(schema as Schema, name)
        }
      }
    }
  }

  return { document, schemaNames }
```

- [ ] **Step 4: Add `schemaNames` to the `Api` model**

In `src/spec/types.ts`, replace the `Api` interface:

```ts
export interface Api {
  version: string
  operations: Operation[]
  /** Maps a resolved component schema object to the name it was declared under. */
  schemaNames: Map<Schema, string>
}
```

- [ ] **Step 5: Thread the table through the loader**

In `src/spec/load.ts`, change the resolve call from
`const resolved = resolveDocument(doc)` to:

```ts
  const { document: resolved, schemaNames } = resolveDocument(doc)
```

and the final return from `return { version, operations }` to:

```ts
  return { version, operations, schemaNames }
```

- [ ] **Step 6: Add a loader test for the table**

Append to `test/spec/load.test.ts`:

```ts
test('exposes component schema names on the api', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  const schema = op?.responses[0]?.content['application/json']?.schema
  assert.ok(schema)
  assert.equal(api.schemaNames.get(schema), 'Pet')
})
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/spec/refs.test.ts test/spec/load.test.ts`
Expected: PASS, 11 ref tests (the 8 that existed, migrated, plus 3 new) and every
existing load test plus the new one.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm test`
Expected: PASS. Nothing else constructs an `Api` literal, so no other file breaks.

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```sh
git add src/spec/refs.ts src/spec/types.ts src/spec/load.ts test/spec/refs.test.ts test/spec/load.test.ts
```

```sh
git commit -m 'feat: record component schema names during ref resolution' -m 'bySchema overrides key on a component name, which a resolved schema object no longer carries. Resolution already makes every reference to a component the same object, so a side table keyed on identity is enough and adds no traversal.' -m 'resolveDocument now returns the document alongside the table, which is a breaking signature change its callers and tests move with.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 2: Target strings

One syntax addresses operations for `operations` keys, `failure[].match`, and the
control plane alike. Plan 3 and plan 4 both consume this module unchanged.

**Files:**
- Create: `src/resolve/target.ts`
- Test: `test/resolve/target.test.ts`

**Interfaces:**
- Consumes: `Operation` from `src/spec/types.ts`.
- Produces: `compileTarget(target: string): TargetMatcher` where `TargetMatcher`
  is `{ target: string; matches(operation: Operation): boolean }`, and
  `resolveTarget(target: string, operations: Operation[]): Operation[]` which
  throws when nothing matches.

- [ ] **Step 1: Write the failing test**

Create `test/resolve/target.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTarget, resolveTarget } from '../../src/resolve/target.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(method: Operation['method'], path: string, id: string): Operation {
  return { method, path, operationId: id, parameters: [], responses: [] }
}

const operations = [
  op('get', '/users/{id}', 'getUserById'),
  op('post', '/users', 'createUser'),
  op('get', '/orders/{id}/items', 'listOrderItems'),
  op('delete', '/orders/{id}', 'deleteOrder')
]

test('matches a method and exact path template', () => {
  const matcher = compileTarget('GET /users/{id}')
  assert.equal(matcher.matches(operations[0] as Operation), true)
  assert.equal(matcher.matches(operations[1] as Operation), false)
})

test('is case-insensitive on method', () => {
  assert.equal(compileTarget('get /users/{id}').matches(operations[0] as Operation), true)
})

test('a bare operationId matches by id', () => {
  const matcher = compileTarget('createUser')
  assert.equal(matcher.matches(operations[1] as Operation), true)
  assert.equal(matcher.matches(operations[0] as Operation), false)
})

test('a method wildcard matches any method at that path', () => {
  const matcher = compileTarget('* /users/{id}')
  assert.equal(matcher.matches(operations[0] as Operation), true)
  assert.equal(matcher.matches(op('put', '/users/{id}', 'putUser')), true)
  assert.equal(matcher.matches(operations[1] as Operation), false)
})

test('a single star matches exactly one segment', () => {
  const matcher = compileTarget('GET /orders/*')
  // /orders/{id}/items has two segments after /orders, so it must not match
  assert.equal(matcher.matches(operations[2] as Operation), false)
  assert.equal(matcher.matches(op('get', '/orders/{id}', 'getOrder')), true)
})

test('a double star matches the remaining segments', () => {
  const matcher = compileTarget('GET /orders/**')
  assert.equal(matcher.matches(operations[2] as Operation), true)
  assert.equal(matcher.matches(op('get', '/orders/{id}', 'getOrder')), true)
})

test('a double star also matches zero remaining segments', () => {
  assert.equal(compileTarget('GET /orders/**').matches(op('get', '/orders', 'listOrders')), true)
})

test('resolveTarget returns every matching operation', () => {
  const found = resolveTarget('* /users/{id}', operations)
  assert.deepEqual(found.map((o) => o.operationId), ['getUserById'])
})

test('resolveTarget throws when nothing matches, naming the target', () => {
  assert.throws(() => resolveTarget('GET /nope', operations), /GET \/nope/)
})

test('a path with no method is rejected with a usable message', () => {
  assert.throws(() => compileTarget('/users/{id}'), /has no method/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/resolve/target.test.ts`
Expected: FAIL — cannot find module `../../src/resolve/target.ts`.

- [ ] **Step 3: Implement `src/resolve/target.ts`**

```ts
import type { Operation } from '../spec/types.ts'

export interface TargetMatcher {
  target: string
  matches(operation: Operation): boolean
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * Compiles one of the four target forms into an operation predicate:
 *
 *   'getUserById'        an operationId
 *   'GET /users/{id}'    method plus the path template as written in the document
 *   '* /users/{id}'      any method
 *   'GET /orders/*'      '*' matches one segment, '**' matches the rest
 *
 * Path matching is against the template, not against a concrete request path —
 * `{id}` is a literal segment here, so '/users/{id}' targets the operation and
 * '/users/42' targets nothing.
 */
export function compileTarget(target: string): TargetMatcher {
  const trimmed = target.trim()
  const space = trimmed.indexOf(' ')

  if (space === -1) {
    if (trimmed.startsWith('/')) {
      throw new Error(
        `mockingham: target "${target}" looks like a path but has no method. ` +
          'Write "GET /users/{id}", or "* /users/{id}" to match any method.'
      )
    }
    return {
      target: trimmed,
      matches: (operation) => operation.operationId === trimmed
    }
  }

  const method = trimmed.slice(0, space).toUpperCase()
  const pattern = split(trimmed.slice(space + 1).trim())

  return {
    target: trimmed,
    matches(operation) {
      if (method !== '*' && operation.method.toUpperCase() !== method) return false
      const parts = split(operation.path)
      for (let i = 0; i < pattern.length; i++) {
        // '**' consumes whatever is left, including nothing at all.
        if (pattern[i] === '**') return true
        if (i >= parts.length) return false
        if (pattern[i] !== '*' && pattern[i] !== parts[i]) return false
      }
      return pattern.length === parts.length
    }
  }
}

/**
 * Resolves a target against a document's operations. A target matching nothing
 * is a configuration error rather than an empty result — it means an override,
 * failure policy, or control-plane call would silently never fire.
 */
export function resolveTarget(
  target: string,
  operations: Operation[]
): Operation[] {
  const matcher = compileTarget(target)
  const found = operations.filter((operation) => matcher.matches(operation))
  if (found.length === 0) {
    throw new Error(
      `mockingham: target "${target}" matches no operation in the document. ` +
        'Check the method, the path template exactly as written in the ' +
        'document, or the operationId.'
    )
  }
  return found
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/resolve/target.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/resolve/target.ts test/resolve/target.test.ts
```

```sh
git commit -m 'feat: compile override target strings into operation predicates' -m 'One syntax serves operations keys, failure policies, and the control plane. A target matching no operation throws rather than silently never firing.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 3: Body parsing and content negotiation

Pipeline stage 2. This must exist before `Ctx` can carry `body`.

**Files:**
- Create: `src/runtime/body.ts`
- Test: `test/runtime/body.test.ts`

**Interfaces:**
- Consumes: `Operation` from `src/spec/types.ts`.
- Produces: `parseBody(request: Request, operation: Operation): Promise<BodyResult>`,
  where `BodyResult` is
  `{ ok: true; body: ParsedBody } | { ok: false; status: number; code: string; message: string }`
  and `ParsedBody` is `{ value: unknown; mediaType?: string; raw: Uint8Array }`.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/body.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBody } from '../../src/runtime/body.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    method: 'post', path: '/things', parameters: [], responses: [], ...overrides
  }
}

function post(body: string, contentType?: string): Request {
  const headers: Record<string, string> = {}
  if (contentType) headers['content-type'] = contentType
  return new Request('http://mock/things', { method: 'POST', body, headers })
}

test('parses a JSON body', async () => {
  const result = await parseBody(post('{"a":1}', 'application/json'), op())
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.body.value, { a: 1 })
})

test('honors a charset parameter on the content type', async () => {
  const result = await parseBody(
    post('{"a":1}', 'application/json; charset=utf-8'), op()
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.body.value, { a: 1 })
})

test('a malformed JSON body is a 400', async () => {
  const result = await parseBody(post('{not json', 'application/json'), op())
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 400)
    assert.equal(result.code, 'MOCK_BODY_MALFORMED')
  }
})

test('parses a form-urlencoded body', async () => {
  const result = await parseBody(
    post('a=1&b=two', 'application/x-www-form-urlencoded'), op()
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.body.value, { a: '1', b: 'two' })
})

test('parses a text body as a string', async () => {
  const result = await parseBody(post('hello', 'text/plain'), op())
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body.value, 'hello')
})

test('an unrecognized content type is exposed as raw bytes', async () => {
  const result = await parseBody(post('', 'application/octet-stream'), op())
  assert.equal(result.ok, true)
  if (result.ok) assert.ok(result.body.value instanceof Uint8Array)
})

test('an empty body yields undefined', async () => {
  const request = new Request('http://mock/things', { method: 'POST' })
  const result = await parseBody(request, op())
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body.value, undefined)
})

test('a content type the operation does not declare is a 415', async () => {
  const operation = op({
    requestBody: { 'application/json': { schema: { type: 'object' } } }
  })
  const result = await parseBody(post('x=1', 'application/x-www-form-urlencoded'), operation)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 415)
    assert.match(result.message, /application\/json/)
  }
})

test('an operation declaring no request body accepts anything', async () => {
  const result = await parseBody(post('x=1', 'application/x-www-form-urlencoded'), op())
  assert.equal(result.ok, true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/runtime/body.test.ts`
Expected: FAIL — cannot find module `../../src/runtime/body.ts`.

- [ ] **Step 3: Implement `src/runtime/body.ts`**

`Request`, `TextDecoder`, and `URLSearchParams` are globals rather than `node:`
imports, so this module stays inside the pure core.

```ts
import type { Operation } from '../spec/types.ts'

export interface ParsedBody {
  value: unknown
  mediaType?: string
  raw: Uint8Array
}

export type BodyResult =
  | { ok: true; body: ParsedBody }
  | { ok: false; status: number; code: string; message: string }

function baseMediaType(header: string | null): string | undefined {
  if (header === null) return undefined
  const base = header.split(';')[0]
  return base === undefined ? undefined : base.trim().toLowerCase()
}

export async function parseBody(
  request: Request,
  operation: Operation
): Promise<BodyResult> {
  const raw = new Uint8Array(await request.arrayBuffer())
  const mediaType = baseMediaType(request.headers.get('content-type'))

  if (raw.length === 0) {
    return { ok: true, body: { value: undefined, mediaType, raw } }
  }

  const declared = operation.requestBody
    ? Object.keys(operation.requestBody)
    : []
  if (
    declared.length > 0 &&
    mediaType !== undefined &&
    !declared.includes(mediaType)
  ) {
    return {
      ok: false,
      status: 415,
      code: 'MOCK_UNSUPPORTED_MEDIA_TYPE',
      message:
        `Operation ${operation.method.toUpperCase()} ${operation.path} does not ` +
        `declare "${mediaType}". Declared: ${declared.join(', ')}.`
    }
  }

  const text = new TextDecoder().decode(raw)

  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
    try {
      return { ok: true, body: { value: JSON.parse(text), mediaType, raw } }
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'MOCK_BODY_MALFORMED',
        message: 'Request body is not valid JSON.'
      }
    }
  }

  if (mediaType === 'application/x-www-form-urlencoded') {
    const value: Record<string, string> = {}
    for (const [key, entry] of new URLSearchParams(text)) value[key] = entry
    return { ok: true, body: { value, mediaType, raw } }
  }

  if (mediaType?.startsWith('text/')) {
    return { ok: true, body: { value: text, mediaType, raw } }
  }

  // Anything else stays bytes. Validation skips it rather than guessing.
  return { ok: true, body: { value: raw, mediaType, raw } }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/runtime/body.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/runtime/body.ts test/runtime/body.test.ts
```

```sh
git commit -m 'feat: add request body parsing and content negotiation' -m 'Parses JSON, form-urlencoded, and text bodies; anything else stays raw bytes for validation to skip. A content type the operation does not declare is a 415.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 4: The context object and shared runtime types

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/context.ts`
- Test: `test/runtime/context.test.ts`

**Interfaces:**
- Consumes: `Operation` from `src/spec/types.ts`, `Rng` from `src/generate/rng.ts`.
- Produces: from `src/runtime/types.ts` the types `Ctx`, `Resolver`, `Resolvers`,
  `OverrideNode`; from `src/runtime/context.ts` the functions
  `createCounters(): Counters` where `Counters` is `{ next(name: string): number; reset(): void }`,
  and `createContext(input: ContextInput): Ctx`.

`Ctx` in this plan omits `auth`, `store`, `schema.*`, and `deny()` — those arrive
with plans 3 and 4. Per design amendment 1.2, `seq` is **synchronous**.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/context.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContext, createCounters } from '../../src/runtime/context.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Operation } from '../../src/spec/types.ts'

const operation: Operation = {
  method: 'get', path: '/things/{id}', parameters: [], responses: []
}

function build(url: string, init?: RequestInit) {
  const request = new Request(url, init)
  return createContext({
    request,
    url: new URL(url),
    operation,
    params: { id: '7' },
    body: undefined,
    rng: createRng('ctx'),
    requestKey: 'key',
    counters: createCounters(),
    generate: () => ({ generated: true }),
    example: () => ({ example: true })
  })
}

test('counters start at one and increment per name', () => {
  const counters = createCounters()
  assert.equal(counters.next('order'), 1)
  assert.equal(counters.next('order'), 2)
  assert.equal(counters.next('user'), 1)
})

test('reset returns every counter to the start', () => {
  const counters = createCounters()
  counters.next('order')
  counters.reset()
  assert.equal(counters.next('order'), 1)
})

test('seq is synchronous and returns a number', () => {
  const ctx = build('http://mock/things/7')
  const first = ctx.seq('order')
  assert.equal(typeof first, 'number')
  assert.equal(ctx.seq('order'), first + 1)
})

test('exposes path params', () => {
  assert.deepEqual(build('http://mock/things/7').params, { id: '7' })
})

test('collects query parameters', () => {
  const ctx = build('http://mock/things/7?limit=5&sort=name')
  assert.deepEqual(ctx.query, { limit: '5', sort: 'name' })
})

test('a repeated query key becomes an array in order of appearance', () => {
  const ctx = build('http://mock/things/7?tag=a&tag=b&tag=c')
  assert.deepEqual(ctx.query, { tag: ['a', 'b', 'c'] })
})

test('header names are lowercased', () => {
  const ctx = build('http://mock/things/7', {
    headers: { 'X-Trace-Id': 'abc' }
  })
  assert.equal(ctx.headers['x-trace-id'], 'abc')
})

test('respond builds a JSON response', async () => {
  const ctx = build('http://mock/things/7')
  const response = ctx.respond(201, { ok: true }, { 'x-custom': 'y' })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('x-custom'), 'y')
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { ok: true })
})

test('respond with no body sends no content type', () => {
  const response = build('http://mock/things/7').respond(204)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('content-type'), null)
})

test('log starts as an empty object callbacks can add to', () => {
  const ctx = build('http://mock/things/7')
  assert.deepEqual(ctx.log, {})
  ctx.log['tenant'] = 'acme'
  assert.deepEqual(ctx.log, { tenant: 'acme' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/runtime/context.test.ts`
Expected: FAIL — cannot find module `../../src/runtime/context.ts`.

- [ ] **Step 3: Create `src/runtime/types.ts`**

This module imports only types, and nothing imports it at runtime, so it can be
imported from both `generate/` and `runtime/` without a cycle.

```ts
import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'

/**
 * The value handed to every user callback: resolvers, override functions, and
 * full response callbacks.
 *
 * `auth`, `store`, `schema.*`, and `deny()` are specified in the master spec §4
 * and arrive with plans 3 and 4. `seq` is synchronous by design decision 1.2 —
 * it is per-instance identity, not shared state.
 */
export interface Ctx {
  req: Request
  operation: Operation
  params: Record<string, string>
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body: unknown
  rng: Rng
  requestKey: string
  log: Record<string, unknown>
  seq(name: string): number
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
  respond(status: number, body?: unknown, headers?: Record<string, string>): Response
}

/** A resolver or override leaf. May return a value or a promise of one. */
export type Resolver = (ctx: Ctx) => unknown

export interface Resolvers {
  byFormat?: Record<string, Resolver>
  /** Ordered — the first matching entry wins. Strings are globs. */
  byName?: Array<[string | RegExp, Resolver]>
  bySchema?: Record<string, Record<string, Resolver>>
}

/**
 * A node in an override tree: a literal value, a function, or a deeper object
 * whose keys address object properties, array indices, or '*' for every index.
 */
export type OverrideNode = unknown
```

- [ ] **Step 4: Implement `src/runtime/context.ts`**

```ts
import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { Ctx } from './types.ts'

export interface Counters {
  next(name: string): number
  reset(): void
}

export function createCounters(): Counters {
  const counts = new Map<string, number>()
  return {
    next(name) {
      const value = (counts.get(name) ?? 0) + 1
      counts.set(name, value)
      return value
    },
    reset() {
      counts.clear()
    }
  }
}

export interface ContextInput {
  request: Request
  url: URL
  operation: Operation
  params: Record<string, string>
  body: unknown
  rng: Rng
  requestKey: string
  counters: Counters
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
}

export function createContext(input: ContextInput): Ctx {
  // Built by iterating searchParams in order of appearance rather than through
  // a Set, so the result is deterministic — invariant 2 forbids unordered
  // iteration anywhere a generated value can depend on it.
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of input.url.searchParams) {
    const existing = query[key]
    if (existing === undefined) query[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else query[key] = [existing, value]
  }

  const headers: Record<string, string> = {}
  input.request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })

  return {
    req: input.request,
    operation: input.operation,
    params: input.params,
    query,
    headers,
    body: input.body,
    rng: input.rng,
    requestKey: input.requestKey,
    log: {},
    seq: (name) => input.counters.next(name),
    generate: (status) => input.generate(status),
    example: (status, name) => input.example(status, name),
    respond(status, body, extra) {
      const out = new Headers(extra)
      if (body === undefined) return new Response(null, { status, headers: out })
      out.set('content-type', 'application/json')
      return new Response(JSON.stringify(body), { status, headers: out })
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/runtime/context.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/runtime/types.ts src/runtime/context.ts test/runtime/context.test.ts
```

```sh
git commit -m 'feat: add the request context and sequence counters' -m 'ctx is the value handed to every user callback. seq is synchronous and backed by an in-process counter map rather than the Store, because sequence numbers are per-instance identity.' -m 'runtime/types.ts holds the shared vocabulary so generate.ts can type resolver callbacks without importing the module that constructs them.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 5: Schema-keyed resolvers

`byFormat`, `byName`, and `bySchema` are consulted **inside** generation. Applying
them afterward would require walking the schema alongside the generated value,
which is the second traversal invariant 1 forbids.

**Files:**
- Create: `src/resolve/resolvers.ts`
- Modify: `src/generate/generate.ts`
- Test: `test/resolve/resolvers.test.ts`
- Test: `test/generate/generate.test.ts` (append)

**Interfaces:**
- Consumes: `Resolvers`, `Ctx` from `src/runtime/types.ts`; `Schema` from
  `src/spec/types.ts`.
- Produces: `compileResolvers(resolvers?: Resolvers): ResolverLookup`, where
  `ResolverLookup` is
  `{ resolve(schema: Schema, propertyName: string | undefined, schemaName: string | undefined, ctx: unknown): { hit: true; value: unknown } | { hit: false } }`.
  `GenerateOptions` gains `resolvers?: ResolverLookup`, `schemaNames?: Map<Schema, string>`,
  and `ctx?: unknown`.

- [ ] **Step 1: Write the failing test**

Create `test/resolve/resolvers.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileResolvers } from '../../src/resolve/resolvers.ts'
import type { Ctx } from '../../src/runtime/types.ts'

const ctx = {} as Ctx

test('byFormat resolves on the schema format', () => {
  const lookup = compileResolvers({ byFormat: { email: () => 'x@y.z' } })
  const hit = lookup.resolve({ type: 'string', format: 'email' }, undefined, undefined, ctx)
  assert.deepEqual(hit, { hit: true, value: 'x@y.z' })
})

test('a format with no resolver is a miss', () => {
  const lookup = compileResolvers({ byFormat: { email: () => 'x@y.z' } })
  assert.deepEqual(
    lookup.resolve({ type: 'string', format: 'uuid' }, undefined, undefined, ctx),
    { hit: false }
  )
})

test('byName matches a property name as a glob', () => {
  const lookup = compileResolvers({ byName: [['*_id', () => 'ID']] })
  assert.deepEqual(lookup.resolve({}, 'user_id', undefined, ctx), { hit: true, value: 'ID' })
  assert.deepEqual(lookup.resolve({}, 'name', undefined, ctx), { hit: false })
})

test('byName accepts a RegExp', () => {
  const lookup = compileResolvers({ byName: [[/^user[A-Z]/, () => 'u_1']] })
  assert.deepEqual(lookup.resolve({}, 'userName', undefined, ctx), { hit: true, value: 'u_1' })
  assert.deepEqual(lookup.resolve({}, 'username', undefined, ctx), { hit: false })
})

test('byName is ordered and the first match wins', () => {
  const lookup = compileResolvers({
    byName: [['user_id', () => 'specific'], ['*_id', () => 'general']]
  })
  assert.deepEqual(lookup.resolve({}, 'user_id', undefined, ctx), { hit: true, value: 'specific' })
})

test('a glob does not match across a literal dot', () => {
  const lookup = compileResolvers({ byName: [['a.b', () => 'x']] })
  assert.deepEqual(lookup.resolve({}, 'axb', undefined, ctx), { hit: false })
})

test('bySchema matches a component name and property', () => {
  const lookup = compileResolvers({ bySchema: { User: { id: () => 'u_1' } } })
  assert.deepEqual(lookup.resolve({}, 'id', 'User', ctx), { hit: true, value: 'u_1' })
  assert.deepEqual(lookup.resolve({}, 'id', 'Pet', ctx), { hit: false })
})

test('precedence is bySchema over byName over byFormat', () => {
  const lookup = compileResolvers({
    byFormat: { email: () => 'format' },
    byName: [['email', () => 'name']],
    bySchema: { User: { email: () => 'schema' } }
  })
  const schema = { type: 'string', format: 'email' }
  assert.deepEqual(lookup.resolve(schema, 'email', 'User', ctx), { hit: true, value: 'schema' })
  assert.deepEqual(lookup.resolve(schema, 'email', 'Pet', ctx), { hit: true, value: 'name' })
  assert.deepEqual(lookup.resolve(schema, 'other', 'Pet', ctx), { hit: true, value: 'format' })
})

test('an empty resolver set always misses', () => {
  assert.deepEqual(compileResolvers().resolve({ format: 'email' }, 'id', 'User', ctx), { hit: false })
})

test('a resolver returning undefined still counts as a hit', () => {
  const lookup = compileResolvers({ byName: [['id', () => undefined]] })
  assert.deepEqual(lookup.resolve({}, 'id', undefined, ctx), { hit: true, value: undefined })
})
```

Append to `test/generate/generate.test.ts`:

```ts
import { compileResolvers } from '../../src/resolve/resolvers.ts'

test('generation consults byFormat resolvers', () => {
  const value = generateValue(
    { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byFormat: { email: () => 'fixed@example.com' } }) }
  ) as Record<string, unknown>
  assert.equal(value['email'], 'fixed@example.com')
})

test('generation consults bySchema using the schema name table', () => {
  const user = {
    type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }
  }
  const schemaNames = new Map([[user, 'User']])
  const value = generateValue(user, createRng('resolvers'), {
    schemaNames,
    resolvers: compileResolvers({ bySchema: { User: { id: () => 42 } } })
  }) as Record<string, unknown>
  assert.equal(value['id'], 42)
  assert.equal(typeof value['name'], 'string')
})

test('a resolver beats a spec example', () => {
  const value = generateValue(
    { type: 'object', properties: { id: { type: 'string', example: 'from-spec' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byName: [['id', () => 'from-resolver']] }) }
  ) as Record<string, unknown>
  assert.equal(value['id'], 'from-resolver')
})

test('a resolver may return a promise, left unsettled for the override pass', () => {
  const value = generateValue(
    { type: 'object', properties: { id: { type: 'string' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byName: [['id', async () => 'later']] }) }
  ) as Record<string, unknown>
  assert.ok(value['id'] instanceof Promise)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/resolve/resolvers.test.ts test/generate/generate.test.ts`
Expected: FAIL — cannot find module `../../src/resolve/resolvers.ts`.

- [ ] **Step 3: Implement `src/resolve/resolvers.ts`**

```ts
import type { Schema } from '../spec/types.ts'
import type { Ctx, Resolvers } from '../runtime/types.ts'

export type ResolverHit = { hit: true; value: unknown } | { hit: false }

export interface ResolverLookup {
  resolve(
    schema: Schema,
    propertyName: string | undefined,
    schemaName: string | undefined,
    ctx: unknown
  ): ResolverHit
}

const MISS: ResolverHit = { hit: false }

/**
 * Converts a glob to an anchored RegExp. Every regex metacharacter is escaped
 * first, so a literal '.' in a property name stays literal; only '*' survives
 * as a wildcard.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

export function compileResolvers(resolvers: Resolvers = {}): ResolverLookup {
  const byName = (resolvers.byName ?? []).map(([pattern, fn]) => ({
    test: typeof pattern === 'string' ? globToRegExp(pattern) : pattern,
    fn
  }))

  return {
    resolve(schema, propertyName, schemaName, ctx) {
      const request = ctx as Ctx

      if (schemaName !== undefined && propertyName !== undefined) {
        const fn = resolvers.bySchema?.[schemaName]?.[propertyName]
        if (fn) return { hit: true, value: fn(request) }
      }

      if (propertyName !== undefined) {
        for (const entry of byName) {
          // A RegExp with the global flag carries lastIndex between calls, so
          // test it from a known state rather than trusting the caller's flags.
          entry.test.lastIndex = 0
          if (entry.test.test(propertyName)) {
            return { hit: true, value: entry.fn(request) }
          }
        }
      }

      if (schema.format !== undefined) {
        const fn = resolvers.byFormat?.[schema.format]
        if (fn) return { hit: true, value: fn(request) }
      }

      return MISS
    }
  }
}
```

- [ ] **Step 4: Wire the lookup into `src/generate/generate.ts`**

Add the imports at the top:

```ts
import type { ResolverLookup } from '../resolve/resolvers.ts'
```

Replace the `GenerateOptions` interface:

```ts
export interface GenerateOptions {
  maxDepth?: number
  preferExamples?: boolean
  resolvers?: ResolverLookup
  schemaNames?: Map<Schema, string>
  /** Passed through to resolver callbacks. Typed loosely to avoid a cycle. */
  ctx?: unknown
}
```

Replace the `walk` function's signature and add the hook as its first act. A
resolver outranks `example` and `default`, per the master spec's precedence chain,
so the hook must come before those checks:

```ts
  function walk(
    current: Schema,
    depth: number,
    propertyName?: string,
    containerName?: string
  ): unknown {
    const hook = options.resolvers?.resolve(
      current, propertyName, containerName, options.ctx
    )
    // A resolver may legitimately return undefined, so hit is checked rather
    // than the value. A returned promise is left in the tree for the override
    // pass to settle — generation itself stays synchronous.
    if (hook?.hit) return hook.value

    if (preferExamples && current.example !== undefined) return current.example
    if (current.default !== undefined) return current.default
```

The rest of `walk` is unchanged except the two recursive calls that know a name.
Replace the `array` case's recursion:

```ts
        for (let i = 0; i < count; i++) {
          items.push(walk(kind.items, depth + 1, propertyName, containerName))
        }
```

and replace the `object` case body:

```ts
      case 'object': {
        if (depth >= maxDepth) return {}
        const out: Record<string, unknown> = {}
        // The container name is this schema's own component name, so a
        // bySchema entry for `User` addresses the properties declared on User.
        const name = options.schemaNames?.get(current)
        for (const [property, schema] of Object.entries(kind.properties)) {
          out[property] = walk(schema, depth + 1, property, name)
        }
        return out
      }
```

Array items inherit the property name so `tags: ['*_id']` resolves per element.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/resolve/resolvers.test.ts test/generate/generate.test.ts`
Expected: PASS, 10 resolver tests and the existing generate tests plus 4 new ones.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test`
Expected: PASS. Existing generation output must be unchanged — with no resolvers
configured the hook always misses, so the determinism tests stay green.

Run: `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```sh
git add src/resolve/resolvers.ts src/generate/generate.ts test/resolve/resolvers.test.ts test/generate/generate.test.ts
```

```sh
git commit -m 'feat: consult schema-keyed resolvers during generation' -m 'byFormat, byName, and bySchema need the format, property name, and component name at each leaf. Applying them after generation would mean walking the schema a second time alongside the value, which invariant 1 forbids, so they are consulted inside the existing walk.' -m 'A resolver returning a promise is left unsettled in the tree; the override pass awaits every pending leaf in one batch.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 6: The override overlay

`operations[...].body` is value-keyed and needs no schema knowledge, so it is a
plain value-tree overlay. This module also settles the promises resolvers left
behind, so every async leaf in the response — resolver or override — is awaited
in one batch.

**Files:**
- Create: `src/resolve/layer.ts`
- Test: `test/resolve/layer.test.ts`

**Interfaces:**
- Consumes: `OverrideNode` from `src/runtime/types.ts`.
- Produces: `applyOverrides(generated: unknown, override: OverrideNode | undefined, ctx: unknown): Promise<unknown>`.

- [ ] **Step 1: Write the failing test**

Create `test/resolve/layer.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOverrides } from '../../src/resolve/layer.ts'

const ctx = {} as never

test('an absent override returns the generated value', async () => {
  assert.deepEqual(await applyOverrides({ a: 1 }, undefined, ctx), { a: 1 })
})

test('a static leaf replaces the generated one', async () => {
  assert.deepEqual(await applyOverrides({ a: 1, b: 2 }, { a: 9 }, ctx), { a: 9, b: 2 })
})

test('a synchronous function receives ctx and replaces the value', async () => {
  const seen: unknown[] = []
  const out = await applyOverrides({ a: 1 }, { a: (c: unknown) => { seen.push(c); return 9 } }, ctx)
  assert.deepEqual(out, { a: 9 })
  assert.equal(seen[0], ctx)
})

test('an async function is awaited', async () => {
  assert.deepEqual(await applyOverrides({ a: 1 }, { a: async () => 9 }, ctx), { a: 9 })
})

test('nested objects merge rather than replace', async () => {
  const out = await applyOverrides(
    { user: { id: 1, name: 'gen' } }, { user: { name: 'set' } }, ctx
  )
  assert.deepEqual(out, { user: { id: 1, name: 'set' } })
})

test('a key absent from the generated value is added', async () => {
  assert.deepEqual(await applyOverrides({ a: 1 }, { b: 2 }, ctx), { a: 1, b: 2 })
})

test('a numeric key addresses one array index', async () => {
  assert.deepEqual(await applyOverrides(['x', 'y', 'z'], { 1: 'Y' }, ctx), ['x', 'Y', 'z'])
})

test('a star key applies to every array element', async () => {
  assert.deepEqual(await applyOverrides(['x', 'y'], { '*': 'Z' }, ctx), ['Z', 'Z'])
})

test('a numeric key beats the star for its index', async () => {
  assert.deepEqual(
    await applyOverrides(['x', 'y', 'z'], { '*': 'Z', 1: 'Y' }, ctx), ['Z', 'Y', 'Z']
  )
})

test('a star override receives each element', async () => {
  const out = await applyOverrides(
    [{ n: 1 }, { n: 2 }], { '*': { n: () => 0 } }, ctx
  )
  assert.deepEqual(out, [{ n: 0 }, { n: 0 }])
})

test('settles a promise the generator left in the tree', async () => {
  assert.deepEqual(
    await applyOverrides({ a: Promise.resolve(1) }, undefined, ctx), { a: 1 }
  )
})

test('every async leaf is started before any is awaited', async () => {
  const started: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })

  const promise = applyOverrides({ a: 0, b: 0, c: 0 }, {
    a: async () => { started.push('a'); await gate; return 1 },
    b: async () => { started.push('b'); await gate; return 2 },
    c: async () => { started.push('c'); await gate; return 3 }
  }, ctx)

  // All three ran to their first await before anything resolved, which is what
  // a single Promise.all buys over awaiting each leaf in turn.
  assert.deepEqual(started, ['a', 'b', 'c'])
  release?.()
  assert.deepEqual(await promise, { a: 1, b: 2, c: 3 })
})

test('a promise resolving to a further promise is settled too', async () => {
  const out = await applyOverrides({ a: 0 }, { a: async () => Promise.resolve(7) }, ctx)
  assert.deepEqual(out, { a: 7 })
})

test('an override at the root replaces everything', async () => {
  assert.equal(await applyOverrides({ a: 1 }, () => 'gone', ctx), 'gone')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/resolve/layer.test.ts`
Expected: FAIL — cannot find module `../../src/resolve/layer.ts`.

- [ ] **Step 3: Implement `src/resolve/layer.ts`**

```ts
import type { OverrideNode } from '../runtime/types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Pass one. Builds the result tree, calling override functions as it goes and
 * leaving whatever they return — including promises — in place.
 *
 * Containers are always freshly built, never mutated, so a spec `example`
 * object reachable from the generated tree is never written through.
 */
function overlay(base: unknown, node: OverrideNode, ctx: unknown): unknown {
  if (node === undefined) return base
  if (typeof node === 'function') {
    return (node as (context: unknown) => unknown)(ctx)
  }

  if (isPlainObject(node)) {
    if (Array.isArray(base)) {
      const wildcard = node['*']
      return base.map((item, index) => {
        const byIndex = node[String(index)]
        const chosen = byIndex !== undefined ? byIndex : wildcard
        return chosen === undefined ? item : overlay(item, chosen, ctx)
      })
    }

    const source = isPlainObject(base) ? base : {}
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = key in node ? overlay(value, node[key], ctx) : value
    }
    // Keys the override adds are appended in declaration order, so the result
    // is deterministic.
    for (const [key, value] of Object.entries(node)) {
      if (key in out) continue
      out[key] = overlay(undefined, value, ctx)
    }
    return out
  }

  return node
}

interface Slot {
  promise: Promise<unknown>
  assign(value: unknown): void
}

/**
 * Pass two. Collects every pending leaf and awaits them in one batch, so fifty
 * async overrides cost one tick rather than fifty.
 *
 * The loop repeats because a promise may resolve to a value containing further
 * promises. Each nesting level costs one additional batch, not one per leaf.
 */
async function settle(root: unknown): Promise<unknown> {
  let result = root

  for (;;) {
    const slots: Slot[] = []

    const scan = (value: unknown, assign: (settled: unknown) => void): void => {
      if (value instanceof Promise) {
        slots.push({ promise: value, assign })
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          scan(item, (settled) => {
            value[index] = settled
          })
        })
        return
      }
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        for (const key of Object.keys(record)) {
          scan(record[key], (settled) => {
            record[key] = settled
          })
        }
      }
    }

    scan(result, (settled) => {
      result = settled
    })

    if (slots.length === 0) return result
    const settled = await Promise.all(slots.map((slot) => slot.promise))
    slots.forEach((slot, index) => slot.assign(settled[index]))
  }
}

export async function applyOverrides(
  generated: unknown,
  override: OverrideNode | undefined,
  ctx: unknown
): Promise<unknown> {
  return settle(overlay(generated, override, ctx))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/resolve/layer.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/resolve/layer.ts test/resolve/layer.test.ts
```

```sh
git commit -m 'feat: overlay per-operation overrides onto generated values' -m 'A value-keyed overlay needing no schema knowledge: object keys merge, numeric keys and a star address array elements, and functions are called with ctx.' -m 'Pass two collects every pending leaf and awaits them in a single batch, so a body with fifty async overrides costs one tick. Promises left by resolvers settle in the same pass.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 7: Response header layering

**Files:**
- Create: `src/runtime/headers.ts`
- Test: `test/runtime/headers.test.ts`

**Interfaces:**
- Consumes: `ResponseSpec` from `src/spec/types.ts`, `Rng` from
  `src/generate/rng.ts`, `generateValue` and `GenerateOptions` from
  `src/generate/generate.ts`, `ResolverLookup` from `src/resolve/resolvers.ts`.
- Produces: `buildHeaders(input: HeaderInput): Promise<Headers>`.

Layers 1 through 4 of master spec §5. Layer 5 (transport headers) is applied by
`handler.ts` in Task 8, after this returns, so it cannot be overridden.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/headers.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHeaders } from '../../src/runtime/headers.ts'
import { compileResolvers } from '../../src/resolve/resolvers.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { ResponseSpec } from '../../src/spec/types.ts'

const spec: ResponseSpec = {
  status: 200,
  headers: { 'x-next': { type: 'string' }, 'x-count': { type: 'integer' } },
  content: {}
}

function build(overrides: Record<string, unknown> = {}, extra = {}) {
  return buildHeaders({
    spec,
    ctx: {} as never,
    rngFor: (name) => createRng(`h|${name}`),
    generateOptions: {},
    overrides,
    ...extra
  })
}

test('generates declared response headers from their schemas', async () => {
  const headers = await build()
  assert.equal(typeof headers.get('x-next'), 'string')
  assert.match(headers.get('x-count') ?? '', /^\d+$/)
})

test('global defaults overwrite generated headers', async () => {
  const headers = await build({}, { globals: { 'x-next': 'from-global' } })
  assert.equal(headers.get('x-next'), 'from-global')
})

test('byName resolvers overwrite global defaults', async () => {
  const headers = await build({}, {
    globals: { 'x-next': 'from-global' },
    resolvers: compileResolvers({ byName: [['x-next', () => 'from-resolver']] })
  })
  assert.equal(headers.get('x-next'), 'from-resolver')
})

test('per-operation overrides beat everything below them', async () => {
  const headers = await build({ 'x-next': 'from-operation' }, {
    globals: { 'x-next': 'from-global' },
    resolvers: compileResolvers({ byName: [['x-next', () => 'from-resolver']] })
  })
  assert.equal(headers.get('x-next'), 'from-operation')
})

test('a function header override is called with ctx', async () => {
  const headers = await build({ 'x-rate-limit-remaining': () => 99 })
  assert.equal(headers.get('x-rate-limit-remaining'), '99')
})

test('an async header override is awaited', async () => {
  const headers = await build({ 'x-slow': async () => 'done' })
  assert.equal(headers.get('x-slow'), 'done')
})

test('a null or undefined value omits the header entirely', async () => {
  const headers = await build({ 'x-next': null, 'x-count': undefined })
  assert.equal(headers.get('x-next'), null)
  // undefined means "no override", so the generated value survives
  assert.match(headers.get('x-count') ?? '', /^\d+$/)
})

test('header names are matched case-insensitively', async () => {
  const headers = await build({ 'X-NEXT': 'upper' })
  assert.equal(headers.get('x-next'), 'upper')
})

test('an override may add a header the response does not declare', async () => {
  const headers = await build({ 'x-extra': 'added' })
  assert.equal(headers.get('x-extra'), 'added')
})

test('resolvers do not invent headers that no layer set', async () => {
  const headers = await build({}, {
    resolvers: compileResolvers({ byName: [['x-absent', () => 'nope']] })
  })
  assert.equal(headers.get('x-absent'), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/runtime/headers.test.ts`
Expected: FAIL — cannot find module `../../src/runtime/headers.ts`.

- [ ] **Step 3: Implement `src/runtime/headers.ts`**

```ts
import type { ResponseSpec, Schema } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { generateValue } from '../generate/generate.ts'
import type { ResolverLookup } from '../resolve/resolvers.ts'
import type { OverrideNode } from './types.ts'

export interface HeaderInput {
  spec: ResponseSpec
  globals?: Record<string, OverrideNode>
  resolvers?: ResolverLookup
  overrides?: Record<string, OverrideNode>
  ctx: unknown
  rngFor(name: string): Rng
  generateOptions: GenerateOptions
}

function evaluate(node: OverrideNode, ctx: unknown): unknown {
  return typeof node === 'function'
    ? (node as (context: unknown) => unknown)(ctx)
    : node
}

/**
 * Builds response headers through master spec §5's layers, in increasing
 * precedence. Transport headers are layer 5 and are applied by the caller after
 * this returns, which is what makes them non-overridable.
 */
export async function buildHeaders(input: HeaderInput): Promise<Headers> {
  const values: Record<string, unknown> = {}

  // 1. Declared in the operation's response object, generated from schemas.
  for (const [name, schema] of Object.entries(input.spec.headers)) {
    values[name.toLowerCase()] = generateValue(
      schema as Schema,
      input.rngFor(name),
      input.generateOptions
    )
  }

  // 2. Global defaults from config.
  for (const [name, node] of Object.entries(input.globals ?? {})) {
    values[name.toLowerCase()] = evaluate(node, input.ctx)
  }

  // 3. byName resolvers. These resolve values for headers some layer already
  //    set; they do not invent headers of their own.
  if (input.resolvers) {
    for (const name of Object.keys(values)) {
      const hit = input.resolvers.resolve({}, name, undefined, input.ctx)
      if (hit.hit) values[name] = hit.value
    }
  }

  // 4. Per-operation overrides.
  for (const [name, node] of Object.entries(input.overrides ?? {})) {
    if (node === undefined) continue
    values[name.toLowerCase()] = evaluate(node, input.ctx)
  }

  const names = Object.keys(values)
  const settled = await Promise.all(names.map((name) => values[name]))

  const headers = new Headers()
  names.forEach((name, index) => {
    const value = settled[index]
    if (value !== null && value !== undefined) headers.set(name, String(value))
  })
  return headers
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/runtime/headers.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/runtime/headers.ts test/runtime/headers.test.ts
```

```sh
git commit -m 'feat: layer response headers by increasing precedence' -m 'Declared schemas, then global defaults, then byName resolvers, then per-operation overrides. Async overrides are awaited in one batch and a null value omits the header.' -m 'Transport headers are applied by the caller afterward, which is what makes them non-overridable rather than merely last.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 8: The staged pipeline

Turns `handler.ts` from one function into an orchestrator, and wires body
parsing, resolvers, override overlay, and header layering into it.

**Files:**
- Modify: `src/server/handler.ts`
- Test: `test/server/handler.test.ts` (append)
- Test: `test/server/overrides.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1 through 7.
- Produces: `HandlerOptions` gains `resolvers?: Resolvers`,
  `headers?: Record<string, OverrideNode>`, and
  `operations?: Record<string, OperationConfig>`, where
  `OperationConfig` is
  `{ status?: number; respond?: (ctx: Ctx) => Response | Promise<Response> } & { [status: number]: StatusConfig }`
  and `StatusConfig` is `{ body?: OverrideNode; headers?: Record<string, OverrideNode> }`.
  `respond` is declared here but not honored until Task 9.

- [ ] **Step 1: Write the failing test**

Create `test/server/overrides.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'overrides', ...options })
}

async function get(options: object, path = '/pets/7') {
  const response = await handler(options)(new Request(`http://mock${path}`))
  // Read as text first: a 404 or 204 has no body, and Response.json() rejects
  // on an empty one.
  const text = await response.text()
  const body = (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>
  return { response, body }
}

test('a static body override replaces one property', async () => {
  const { body } = await get({
    operations: { 'GET /pets/{petId}': { 200: { body: { name: 'Fixed' } } } }
  })
  assert.equal(body['name'], 'Fixed')
  assert.equal(typeof body['id'], 'number')
})

test('an override function receives ctx with the path params', async () => {
  const { body } = await get({
    operations: {
      'GET /pets/{petId}': { 200: { body: { id: (ctx: any) => Number(ctx.params.petId) } } }
    }
  })
  assert.equal(body['id'], 7)
})

test('an async override is awaited', async () => {
  const { body } = await get({
    operations: { 'GET /pets/{petId}': { 200: { body: { name: async () => 'Async' } } } }
  })
  assert.equal(body['name'], 'Async')
})

test('a byFormat resolver applies without any per-operation config', async () => {
  const { body } = await get({ resolvers: { byFormat: { email: () => 'a@b.c' } } })
  assert.equal(body['email'], 'a@b.c')
})

test('a bySchema resolver applies through the schema name table', async () => {
  const { body } = await get({ resolvers: { bySchema: { Pet: { name: () => 'Rex' } } } })
  assert.equal(body['name'], 'Rex')
})

test('an operation override beats a resolver', async () => {
  const { body } = await get({
    resolvers: { byName: [['name', () => 'from-resolver']] },
    operations: { 'GET /pets/{petId}': { 200: { body: { name: 'from-operation' } } } }
  })
  assert.equal(body['name'], 'from-operation')
})

test('a wildcard target matches several operations', async () => {
  const { body } = await get({
    operations: { '* /pets/**': { 200: { body: { name: 'Wild' } } } }
  })
  assert.equal(body['name'], 'Wild')
})

test('an operationId target works', async () => {
  const { body } = await get({
    operations: { showPetById: { 200: { body: { name: 'ById' } } } }
  })
  assert.equal(body['name'], 'ById')
})

test('a broad target then a specific one layer in declaration order', async () => {
  const { body } = await get({
    operations: {
      '* /pets/**': { 200: { body: { name: 'Broad', tag: 'Broad' } } },
      'GET /pets/{petId}': { 200: { body: { name: 'Specific' } } }
    }
  })
  assert.equal(body['name'], 'Specific')
  assert.equal(body['tag'], 'Broad')
})

test('a target matching nothing throws at construction', () => {
  assert.throws(
    () => handler({ operations: { 'GET /nope': { 200: { body: {} } } } }),
    /matches no operation/
  )
})

test('a header override reaches the response', async () => {
  const { response } = await get({
    operations: {
      'GET /pets/{petId}': { 200: { headers: { 'x-rate-limit-remaining': () => 99 } } }
    }
  })
  assert.equal(response.headers.get('x-rate-limit-remaining'), '99')
})

test('global header defaults apply to every operation', async () => {
  const { response } = await get({ headers: { 'x-env': 'test' } })
  assert.equal(response.headers.get('x-env'), 'test')
})

test('content-type is not overridable', async () => {
  const { response } = await get({ headers: { 'content-type': 'text/plain' } })
  assert.equal(response.headers.get('content-type'), 'application/json')
})

test('a static status override selects a different declared response', async () => {
  const { response } = await get({
    operations: { 'GET /pets/{petId}': { status: 404 } }
  })
  assert.equal(response.status, 404)
})

test('a request body is parsed and reaches ctx', async () => {
  const seen: unknown[] = []
  const handle = handler({
    operations: {
      createPet: { 201: { body: { echoed: (ctx: any) => { seen.push(ctx.body); return true } } } }
    }
  })
  await handle(new Request('http://mock/pets', {
    method: 'POST',
    body: '{"name":"Rex"}',
    headers: { 'content-type': 'application/json' }
  }))
  assert.deepEqual(seen[0], { name: 'Rex' })
})

test('generation is unchanged when nothing is configured', async () => {
  const plain = await get({})
  const also = await get({})
  assert.deepEqual(plain.body, also.body)
})
```

Note: `createPet` declares a 201 with no content, so the override adds the body.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/overrides.test.ts`
Expected: FAIL — `resolvers` and `operations` are not accepted options, so
overrides have no effect and the assertions miss.

- [ ] **Step 3: Rewrite `src/server/handler.ts`**

```ts
import { createRouter } from '../spec/routes.ts'
import type { Api, Operation, ResponseSpec } from '../spec/types.ts'
import { generateValue } from '../generate/generate.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { createRng, fnv1a } from '../generate/rng.ts'
import type { Rng } from '../generate/rng.ts'
import { compileResolvers } from '../resolve/resolvers.ts'
import { compileTarget, resolveTarget } from '../resolve/target.ts'
import { applyOverrides } from '../resolve/layer.ts'
import { parseBody } from '../runtime/body.ts'
import { buildHeaders } from '../runtime/headers.ts'
import { createContext, createCounters } from '../runtime/context.ts'
import type { Counters } from '../runtime/context.ts'
import type { Ctx, OverrideNode, Resolvers } from '../runtime/types.ts'

export interface StatusConfig {
  body?: OverrideNode
  headers?: Record<string, OverrideNode>
}

export type OperationConfig = {
  status?: number
  respond?: (ctx: Ctx) => Response | Promise<Response>
} & { [status: number]: StatusConfig }

export interface HandlerOptions {
  seed?: string
  maxDepth?: number
  preferExamples?: boolean
  debugHeaders?: boolean
  resolvers?: Resolvers
  headers?: Record<string, OverrideNode>
  operations?: Record<string, OperationConfig>
}

const JSON_TYPE = 'application/json'

function requestKey(
  operation: Operation,
  params: Record<string, string>,
  seed: string
): string {
  const ordered = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&')
  return `${seed}|${operation.method}|${operation.path}|${ordered}`
}

function preferred(request: Request, key: string): string | undefined {
  const header = request.headers.get('prefer')
  if (header === null) return undefined
  const matched = new RegExp(`${key}=([^;,\\s]+)`).exec(header)
  return matched?.[1]
}

/**
 * Every configured target that matches, in declaration order.
 *
 * These are deliberately not merged into one config object. A broad target and
 * a specific one both setting `200.body` must layer — the specific one refining
 * the broad one's result — and merging with Object.assign would drop the broad
 * body entirely. Body overrides are instead applied in sequence below.
 */
function matchingConfigs(
  operation: Operation,
  compiled: Array<{ matches(op: Operation): boolean; config: OperationConfig }>
): OperationConfig[] {
  return compiled
    .filter((entry) => entry.matches(operation))
    .map((entry) => entry.config)
}

export function createHandler(
  api: Api,
  options: HandlerOptions = {}
): (request: Request) => Promise<Response> {
  const router = createRouter(api.operations)
  const seed = options.seed ?? 'mockingham'
  const resolvers = compileResolvers(options.resolvers)

  // Targets are validated here so a typo fails at construction rather than
  // silently never firing.
  const compiled = Object.entries(options.operations ?? {}).map(
    ([target, config]) => {
      resolveTarget(target, api.operations)
      return { matches: compileTarget(target).matches, config }
    }
  )

  const counters: Counters = createCounters()

  return async function handle(request: Request): Promise<Response> {
    // Stage 1 — route match.
    const url = new URL(request.url)
    const matched = router.match(request.method, url.pathname)

    if (!matched) {
      const allowed = router.allowedMethods(url.pathname)
      if (allowed.length > 0) {
        return new Response(null, {
          status: 405,
          headers: { allow: allowed.join(', ') }
        })
      }
      return Response.json(
        {
          error: {
            code: 'MOCK_NOT_FOUND',
            message: `No operation for ${url.pathname}`
          }
        },
        { status: 404 }
      )
    }

    const { operation, params } = matched
    const configs = matchingConfigs(operation, compiled)

    // For the scalar settings, the last matching config that defines one wins.
    let staticStatus: number | undefined
    let respond: OperationConfig['respond']
    for (const entry of configs) {
      if (entry.status !== undefined) staticStatus = entry.status
      if (entry.respond !== undefined) respond = entry.respond
    }

    // Stage 2 — body parse and content negotiation.
    const parsed = await parseBody(request, operation)
    if (!parsed.ok) {
      return Response.json(
        { error: { code: parsed.code, message: parsed.message } },
        { status: parsed.status }
      )
    }

    // Stages 3, 4, 5, and 6 (auth, validation, idempotency, failure) arrive
    // with plans 3 and 4.

    // Stage 7 — status selection.
    const key = requestKey(operation, params, seed)
    const wanted = preferred(request, 'status')
    const exampleName = preferred(request, 'example')

    let source = 'default'
    let spec: ResponseSpec | undefined
    if (wanted !== undefined) {
      spec = operation.responses.find((r) => r.status === Number.parseInt(wanted, 10))
      if (spec) source = 'prefer'
    }
    if (!spec && staticStatus !== undefined) {
      spec = operation.responses.find((r) => r.status === staticStatus)
      if (spec) source = 'config'
    }
    if (!spec) {
      spec =
        operation.responses.find((r) => r.status >= 200 && r.status < 300) ??
        operation.responses[0]
    }

    if (!spec) {
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

    const chosen = spec
    const generateOptions: GenerateOptions = {
      maxDepth: options.maxDepth,
      preferExamples: options.preferExamples,
      resolvers,
      schemaNames: api.schemaNames
    }

    const rngFor = (label: string): Rng => createRng(`${key}|${label}`)

    const mediaFor = (status: number) =>
      operation.responses.find((r) => r.status === status)?.content[JSON_TYPE]

    const generateFor = (status?: number): unknown => {
      const target = status === undefined ? chosen.status : status
      const media = mediaFor(target)
      if (!media) return undefined
      return generateValue(media.schema, rngFor(String(target)), {
        ...generateOptions,
        ctx
      })
    }

    const exampleFor = (status?: number, name?: string): unknown => {
      const media = mediaFor(status === undefined ? chosen.status : status)
      if (!media) return undefined
      if (name === undefined) return media.example
      return media.examples?.[name]?.value
    }

    const ctx: Ctx = createContext({
      request,
      url,
      operation,
      params,
      body: parsed.body.value,
      rng: rngFor('ctx'),
      requestKey: key,
      counters,
      generate: generateFor,
      example: exampleFor
    })

    // Stage 8 — generate the body.
    // Collect this status's overrides across every matching config. Bodies stay
    // a list so they layer; headers are flat, so a shallow merge in declaration
    // order is already the right precedence.
    const bodyOverrides: OverrideNode[] = []
    let headerOverrides: Record<string, OverrideNode> = {}
    for (const entry of configs) {
      const forStatus = entry[chosen.status]
      if (forStatus === undefined) continue
      if (forStatus.body !== undefined) bodyOverrides.push(forStatus.body)
      if (forStatus.headers) {
        headerOverrides = { ...headerOverrides, ...forStatus.headers }
      }
    }

    const headers = await buildHeaders({
      spec: chosen,
      globals: options.headers,
      resolvers,
      overrides: headerOverrides,
      ctx,
      rngFor: (name) => rngFor(`header|${name}`),
      generateOptions: { ...generateOptions, ctx }
    })

    if (options.debugHeaders) {
      headers.set('x-mock-seed', String(fnv1a(key)))
      headers.set('x-mock-status-source', source)
      if (operation.operationId) {
        headers.set('x-mock-operation', operation.operationId)
      }
    }

    let body: unknown
    if (exampleName !== undefined) {
      body = exampleFor(chosen.status, exampleName)
    }
    // Deliberately the same call ctx.generate(status) makes, rather than a
    // second copy of it — a response callback and the pipeline must never
    // produce different bodies for the same status.
    if (body === undefined) body = generateFor(chosen.status)

    // Stage 9 — apply the override layers, broad targets first so specific ones
    // refine their result rather than replacing it.
    if (bodyOverrides.length === 0) {
      // Still worth one pass: resolvers may have left promises in the tree.
      if (body !== undefined) body = await applyOverrides(body, undefined, ctx)
    } else {
      for (const override of bodyOverrides) {
        body = await applyOverrides(body, override, ctx)
      }
    }

    if (body === undefined) {
      return new Response(null, { status: chosen.status, headers })
    }

    // Layer 5 — transport headers, applied last so nothing can override them.
    // Content-Length is left to Response, per design amendment 1.4.
    headers.set('content-type', JSON_TYPE)
    return new Response(JSON.stringify(body), { status: chosen.status, headers })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/overrides.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`
Expected: PASS. The plan-1 determinism and handler tests must still be green —
with no overrides configured the pipeline produces byte-identical output.

Run: `npx tsc --noEmit`

- [ ] **Step 6: Verify the core is still pure**

Run: `grep -rn "from 'node:" src/spec src/schema src/generate src/resolve src/runtime src/server/handler.ts`
Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add src/server/handler.ts test/server/overrides.test.ts
```

```sh
git commit -m 'feat: turn the handler into a staged pipeline with overrides' -m 'Stages run in the design order and each short-circuits by returning a Response. Body parsing, resolvers, override overlay, and header layering are wired in; auth, validation, idempotency, and failure are left as marked gaps for later plans.' -m 'Targets are resolved at construction so a typo throws instead of silently never firing, and transport headers are set after layering so they cannot be overridden.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 9: The full response callback

`respond` replaces stages 7 through 10 for its operation.

**Files:**
- Modify: `src/server/handler.ts`
- Test: `test/server/respond.test.ts`

**Interfaces:**
- Consumes: `OperationConfig.respond` declared in Task 8.
- Produces: no new exports. `respond` is honored, and `ctx.generate(status)` and
  `ctx.example(status, name)` are reachable from inside it.

- [ ] **Step 1: Write the failing test**

Create `test/server/respond.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'respond', ...options })
}

test('respond replaces the whole response', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(202, { custom: true }) }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { custom: true })
})

test('respond may be async', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: async (ctx: any) => ctx.respond(200, { async: true }) }
    }
  })
  assert.deepEqual(await (await handle(new Request('http://mock/pets/7'))).json(), { async: true })
})

test('ctx.generate produces a seeded body inside the callback', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': {
        respond: (ctx: any) => {
          const body = ctx.generate(200) as Record<string, unknown>
          body['id'] = 1
          return ctx.respond(200, body)
        }
      }
    }
  })
  const body = (await (await handle(new Request('http://mock/pets/7'))).json()) as any
  assert.equal(body.id, 1)
  assert.equal(typeof body.name, 'string')
})

test('ctx.generate matches what the pipeline would have produced', async () => {
  const plain = await (await handler({})(new Request('http://mock/pets/7'))).json()
  const viaCallback = await (
    await handler({
      operations: { 'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(200, ctx.generate(200)) } }
    })(new Request('http://mock/pets/7'))
  ).json()
  assert.deepEqual(viaCallback, plain)
})

test('ctx.seq increments across requests', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(200, { n: ctx.seq('pet') }) }
    }
  })
  const first = (await (await handle(new Request('http://mock/pets/7'))).json()) as any
  const second = (await (await handle(new Request('http://mock/pets/7'))).json()) as any
  assert.equal(first.n, 1)
  assert.equal(second.n, 2)
})

test('respond receives the parsed request body', async () => {
  const handle = handler({
    operations: { createPet: { respond: (ctx: any) => ctx.respond(201, ctx.body) } }
  })
  const response = await handle(new Request('http://mock/pets', {
    method: 'POST',
    body: '{"name":"Rex"}',
    headers: { 'content-type': 'application/json' }
  }))
  assert.deepEqual(await response.json(), { name: 'Rex' })
})

test('a callback returning a plain Response is used as-is', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: () => new Response('raw', { status: 418 }) }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 418)
  assert.equal(await response.text(), 'raw')
})

test('an operation without respond is unaffected', async () => {
  const handle = handler({
    operations: { 'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(202) } }
  })
  const response = await handle(new Request('http://mock/pets'))
  assert.equal(response.status, 200)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/respond.test.ts`
Expected: FAIL — `respond` is declared but never called, so statuses stay 200.

- [ ] **Step 3: Honor `respond` in `src/server/handler.ts`**

Insert this block immediately after the `ctx` is constructed with `createContext`,
before the "Stage 8" comment:

```ts
    // Stage 10 — the full response callback replaces stages 7 through 10.
    // It runs after ctx exists so the callback can reach ctx.generate and
    // ctx.example, both of which are bound to the selected response.
    if (respond) {
      return await respond(ctx)
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/respond.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`
Expected: PASS, every file green.

Run: `npx tsc --noEmit`

- [ ] **Step 6: Confirm cross-process determinism still holds**

Create `scripts/determinism.ts`:

```ts
import { createMock } from '../src/index.ts'
import { petstore } from '../test/fixtures/petstore.ts'

const mock = createMock(petstore, { seed: 'cross-process' })

for (const path of ['/pets', '/pets/7', '/pets/mine']) {
  const response = await mock.fetch(new Request(`http://mock${path}`))
  console.log(`${path} ${response.status} ${await response.text()}`)
}
```

Run: `node scripts/determinism.ts`

Run it a second time and compare the two outputs by eye. They must be identical,
and they must still match what plan 1 produced — override machinery in the path
must not shift generated values.

- [ ] **Step 7: Commit**

```sh
git add src/server/handler.ts test/server/respond.test.ts scripts/determinism.ts
```

```sh
git commit -m 'feat: honor the full response callback' -m 'respond replaces stages 7 through 10 for its operation. It runs after ctx is built so the callback can reach ctx.generate and ctx.example bound to the selected response.' -m 'Adds scripts/determinism.ts so the cross-process check from plan 1 is a repeatable command rather than an ad hoc script.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

## Definition of Done

All of these must hold before this plan is considered complete:

- [ ] `npm test` passes with every test file green.
- [ ] `npx tsc --noEmit` reports no errors.
- [ ] `grep -rn "from 'node:" src/spec src/schema src/generate src/resolve src/runtime src/server/handler.ts` returns nothing.
- [ ] `grep -rn "Math.random\|Date.now()" src/generate src/schema src/resolve` returns nothing.
- [ ] `node scripts/determinism.ts` run twice produces byte-identical output, and
      that output still matches what plan 1 produced for the same seed.
- [ ] A configured target that matches no operation throws at construction.
- [ ] Every stage marked "new" or "extended" in design §2.3 has an isolation test.

## What plan 3 picks up

Phase 5 of the design: `schema/compile.ts` (the memoized OpenAPI-to-zod compiler),
`runtime/validate.ts` (pipeline stage 4), `runtime/auth.ts` (stage 3, which starts
by extending `spec/types.ts` and `spec/load.ts` to carry security schemes), and
`runtime/errors.ts` (on-contract error bodies). Plan 4 then covers phase 6:
`runtime/store.ts`, `runtime/failure.ts`, and the async control plane.

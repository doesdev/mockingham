# mockingham Core Implementation Plan (Phases 1–3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load an OpenAPI 3.0/3.1 document and serve a working HTTP mock that returns deterministic, schema-conforming generated responses.

**Architecture:** A document is resolved (`$ref`s inlined), normalized into an internal `Api` model, and compiled into a route table. On each request the router finds the operation, a seeded PRNG derived from the request identity drives value generation over the response schema, and the result is returned as a `Response`. The core is a pure `(Request) => Promise<Response>`; a thin `node:http` adapter wraps it.

**Tech Stack:** TypeScript 7 (types stripped natively by Node, never compiled), Node >= 24, `node:test`, `zod` (not yet used in this plan — it enters in plan 2).

**Scope:** This is plan 1 of 4. It covers spec §1–3 and phases 1–3 of spec §18. Overrides, validation, auth, failure simulation, idempotency, webhooks, logging, MCP, and fixtures are later plans.

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Node floor is >= 24.** Types are stripped natively; there is no build step.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties. Use `const X = {...} as const`.
- **Relative imports MUST carry the `.ts` extension** (`import { x } from './refs.ts'`). Node's type stripping resolves the real file on disk. This is the single most common way to break the build.
- **`zod` is the only permitted hard runtime dependency.** No other runtime dependency may be added in this plan.
- **Determinism:** no `Math.random()`, no `Date.now()`, and no iteration over an unordered `Set`/object anywhere in a generation path. Randomness comes only from `generate/rng.ts`.
- **The core is pure.** Nothing reachable from `server/handler.ts` may import a `node:` module. Node-only code lives in `server/node.ts`.
- **Shell:** no heredocs, single-quote shell arguments, no `&&` chains for writes, never `cd`. Multi-paragraph commits use repeated `-m` flags.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Fixed module type, `node --test` script, Node engine floor |
| `tsconfig.json` | Typecheck-only config; `erasableSyntaxOnly`, `allowImportingTsExtensions` |
| `src/spec/types.ts` | The internal `Api` model — every other module's shared vocabulary |
| `src/spec/refs.ts` | Internal `$ref` resolution with cycle tolerance |
| `src/spec/load.ts` | Raw document → normalized `Api` |
| `src/spec/routes.ts` | Path templates → matcher with static-beats-dynamic precedence |
| `src/generate/rng.ts` | Seeded PRNG and FNV-1a key hashing |
| `src/schema/walk.ts` | The single schema interpretation shared by generation and (later) validation |
| `src/generate/constraints.ts` | Clamping values into schema bounds |
| `src/generate/values.ts` | Leaf value producers by type and format |
| `src/generate/generate.ts` | Recursive composition into whole values |
| `src/server/handler.ts` | Pure `(Request) => Promise<Response>` |
| `src/server/node.ts` | `node:http` adapter |
| `src/index.ts` | `createMock` public surface |
| `test/fixtures/petstore.ts` | Shared test document |

## Task Dependency Graph

Tasks with no shared dependency may be dispatched in parallel.

```
Task 1 (scaffolding)
  ├─ Task 2 (refs) ─── Task 3 (load) ─┐
  ├─ Task 4 (routes) ─────────────────┤
  ├─ Task 5 (rng) ──┐                 │
  ├─ Task 6 (walk) ─┼─ Task 8 (values) ┼─ Task 9 (generate) ─ Task 10 (handler) ─ Task 11 (node + index)
  └─ Task 7 (constraints) ─┘          │
```

**Parallel batch A** (after Task 1): Tasks 2, 4, 5, 6, 7 — five independent modules, no shared files.
**Parallel batch B** (after batch A): Tasks 3 and 8.
**Serial tail:** Tasks 9 → 10 → 11.

---

### Task 1: Project scaffolding and the `Api` model

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `src/spec/types.ts`
- Test: `test/scaffolding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `src/spec/types.ts` — `Schema`, `Parameter`, `ResponseSpec`, `Operation`, `Api`, `HTTP_METHODS`. Every later task imports from here.

- [ ] **Step 1: Fix `package.json`**

Replace the whole file. Note `"type": "module"` (the current `"esm"` is invalid), `mvt` removed, and the Node floor.

```json
{
  "name": "mockingham",
  "version": "0.1.0",
  "description": "OpenAPI driven HTTP mock server",
  "homepage": "https://github.com/doesdev/mockingham#readme",
  "bugs": {
    "url": "https://github.com/doesdev/mockingham/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/doesdev/mockingham.git"
  },
  "license": "MIT",
  "author": "Andrew Carpenter",
  "type": "module",
  "main": "src/index.ts",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "test": "node --test test/",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.25.0-beta.20250519T094321"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`allowImportingTsExtensions` plus `noEmit` is what lets source use `.ts` import specifiers, which Node requires.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`

> **Note for the implementer:** `"main": "src/index.ts"` works for local development and tests, because Node strips types in your own source. It is **not** publishable as-is — Node does not strip types inside `node_modules`. Packaging is deliberately out of scope for this plan and is handled in plan 4; do not add a build step now.

- [ ] **Step 4: Write the failing test**

This test exists to prove the toolchain works end to end — that `node --test` discovers a `.ts` file, strips its types, and resolves a `.ts` import specifier. If any of that is wrong, everything downstream fails confusingly.

Create `test/scaffolding.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HTTP_METHODS } from '../src/spec/types.ts'

test('toolchain strips types and resolves .ts imports', () => {
  const methods: readonly string[] = HTTP_METHODS
  assert.ok(methods.includes('get'))
  assert.ok(methods.includes('delete'))
  assert.equal(methods.length, 7)
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/spec/types.ts`.

If instead it reports **zero tests found**, the runner is not discovering `.ts` files. Change the `test` script to `node --test 'test/**/*.test.ts'` and re-run before continuing.

- [ ] **Step 6: Create `src/spec/types.ts`**

```ts
export const HTTP_METHODS = [
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch'
] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

/** An OpenAPI Schema Object, after $ref resolution. May contain cycles. */
export interface Schema {
  type?: string | string[]
  format?: string
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: unknown[]
  const?: unknown
  default?: unknown
  example?: unknown
  nullable?: boolean
  allOf?: Schema[]
  oneOf?: Schema[]
  anyOf?: Schema[]
  discriminator?: { propertyName: string; mapping?: Record<string, string> }
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number | boolean
  exclusiveMaximum?: number | boolean
  multipleOf?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  additionalProperties?: boolean | Schema
  description?: string
}

export interface Parameter {
  name: string
  location: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  schema: Schema
}

export interface MediaType {
  schema: Schema
  example?: unknown
  examples?: Record<string, { value?: unknown }>
}

export interface ResponseSpec {
  status: number
  description?: string
  headers: Record<string, Schema>
  content: Record<string, MediaType>
}

export interface Operation {
  method: HttpMethod
  path: string
  operationId?: string
  summary?: string
  description?: string
  parameters: Parameter[]
  requestBody?: Record<string, MediaType>
  responses: ResponseSpec[]
}

export interface Api {
  version: string
  operations: Operation[]
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```sh
git add package.json package-lock.json tsconfig.json src/spec/types.ts test/scaffolding.test.ts
```

```sh
git commit -m 'chore: scaffold TypeScript project and Api model' -m 'Fixes the invalid module type, drops mvt for node:test, and adds the internal Api model that every module shares.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 2: `$ref` resolution

**Files:**
- Create: `src/spec/refs.ts`
- Test: `test/spec/refs.test.ts`

**Interfaces:**
- Consumes: nothing (operates on raw JSON, before the `Api` model exists).
- Produces: `resolveDocument(doc: Record<string, unknown>): Record<string, unknown>` — returns a deep copy with every internal `$ref` replaced by the referenced node. Recursive schemas become real object cycles; callers must bound their own recursion. Throws on external and unresolvable refs.

- [ ] **Step 1: Write the failing test**

Create `test/spec/refs.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDocument } from '../../src/spec/refs.ts'

test('inlines a simple internal ref', () => {
  const doc = {
    components: { schemas: { User: { type: 'object' } } },
    paths: { '/u': { get: { schema: { $ref: '#/components/schemas/User' } } } }
  }
  const out = resolveDocument(doc) as any
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
  const out = resolveDocument(doc) as any
  const node = out.components.schemas.Node
  const inner = node.properties.children.items
  assert.equal(inner.type, 'object')
  // the cycle is a real object cycle, not a copy
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
  const out = resolveDocument(doc) as any
  const b = out.components.schemas.B
  assert.equal(b.type, 'object')
  // A is an alias for B, so B.self must be B itself
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
  const out = resolveDocument(doc) as any
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/spec/refs.test.ts`
Expected: FAIL — cannot find module `../../src/spec/refs.ts`.

- [ ] **Step 3: Implement `src/spec/refs.ts`**

Cycles work through `byNode`, which registers a node's output object *before* that
object's own children are walked. A `$ref` pointing back at an ancestor therefore
returns the ancestor's live output object, and the cycle forms naturally as the
ancestor finishes filling in. The `resolving` set is a separate guard, for the
pathological case of references that resolve only to further references with no
schema in between — `byNode` cannot break those, because a bare `$ref` node never
gets registered.

```ts
function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function resolveDocument(
  doc: Record<string, unknown>
): Record<string, unknown> {
  const byNode = new Map<unknown, unknown>()
  const resolving = new Set<string>()

  function lookup(pointer: string): unknown {
    if (!pointer.startsWith('#/')) {
      throw new Error(
        `mockingham: only internal $ref is supported, got "${pointer}". ` +
          'Bundle external references before passing the document in.'
      )
    }
    let node: unknown = doc
    for (const raw of pointer.slice(2).split('/')) {
      if (node === null || typeof node !== 'object') {
        throw new Error(`mockingham: $ref "${pointer}" could not be resolved`)
      }
      node = (node as Record<string, unknown>)[decodeToken(raw)]
      if (node === undefined) {
        throw new Error(`mockingham: $ref "${pointer}" could not be resolved`)
      }
    }
    return node
  }

  function walk(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node
    if (byNode.has(node)) return byNode.get(node)

    if (Array.isArray(node)) {
      const out: unknown[] = []
      byNode.set(node, out)
      for (const item of node) out.push(walk(item))
      return out
    }

    const record = node as Record<string, unknown>
    const ref = record['$ref']
    if (typeof ref === 'string') {
      const target = lookup(ref)
      // A target already in byNode is a real schema, mid-construction. Return
      // its live object so the cycle forms — however many alias hops away it is.
      // This check must precede the `resolving` guard, or an alias chain like
      // `A -> B` where B recurses back through A is rejected as circular.
      if (byNode.has(target)) return byNode.get(target)
      if (resolving.has(ref)) {
        throw new Error(
          `mockingham: circular $ref chain at "${ref}" — a reference resolves ` +
            'only to further references, with no schema between them.'
        )
      }
      resolving.add(ref)
      const resolved = walk(target)
      resolving.delete(ref)
      return resolved
    }

    const out: Record<string, unknown> = {}
    byNode.set(node, out)
    for (const [key, value] of Object.entries(record)) out[key] = walk(value)
    return out
  }

  return walk(doc) as Record<string, unknown>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/spec/refs.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/spec/refs.ts test/spec/refs.test.ts
```

```sh
git commit -m 'feat: resolve internal OpenAPI $refs' -m 'Inlines internal references into a cyclic object graph. Recursive schemas resolve to real cycles; callers bound their own recursion. External and unresolvable refs throw with the pointer named.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 3: Document loading

**Files:**
- Create: `src/spec/load.ts`
- Create: `test/fixtures/petstore.ts`
- Test: `test/spec/load.test.ts`

**Interfaces:**
- Consumes: `resolveDocument` from Task 2; all types from Task 1.
- Produces: `loadApi(doc: Record<string, unknown>): Api`. Also exports `petstore` from `test/fixtures/petstore.ts`, the shared test document used by Tasks 10 and 11.

- [ ] **Step 1: Create the shared test fixture**

Create `test/fixtures/petstore.ts`:

```ts
export const petstore = {
  openapi: '3.1.0',
  info: { title: 'Petstore', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
        ],
        responses: {
          '200': {
            description: 'A list of pets',
            headers: { 'x-next': { schema: { type: 'string' } } },
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createPet',
        responses: { '201': { description: 'Created' } }
      }
    },
    '/pets/{petId}': {
      parameters: [
        { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }
      ],
      get: {
        operationId: 'showPetById',
        responses: {
          '200': {
            description: 'One pet',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } }
            }
          },
          '404': { description: 'Not found' }
        }
      }
    },
    '/pets/mine': {
      get: {
        operationId: 'myPet',
        responses: {
          '200': {
            description: 'My pet',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          tag: { type: 'string' }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/spec/load.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

test('extracts every operation', () => {
  const api = loadApi(petstore)
  assert.equal(api.version, '3.1.0')
  const ids = api.operations.map((op) => op.operationId).sort()
  assert.deepEqual(ids, ['createPet', 'listPets', 'myPet', 'showPetById'])
})

test('merges path-level parameters into each operation', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.ok(op)
  const petId = op.parameters.find((p) => p.name === 'petId')
  assert.ok(petId)
  assert.equal(petId.location, 'path')
  assert.equal(petId.required, true)
})

test('resolves refs inside response schemas', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  const schema = op?.responses[0]?.content['application/json']?.schema
  assert.equal(schema?.type, 'object')
  assert.equal(schema?.properties?.name?.type, 'string')
})

test('parses response status codes as numbers, in ascending order', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.deepEqual(op?.responses.map((r) => r.status), [200, 404])
})

test('throws when the document has no openapi version', () => {
  assert.throws(() => loadApi({ paths: {} }), /openapi/)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/spec/load.test.ts`
Expected: FAIL — cannot find module `../../src/spec/load.ts`.

- [ ] **Step 4: Implement `src/spec/load.ts`**

```ts
import { resolveDocument } from './refs.ts'
import { HTTP_METHODS } from './types.ts'
import type {
  Api, HttpMethod, MediaType, Operation, Parameter, ResponseSpec, Schema
} from './types.ts'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function toParameter(raw: unknown): Parameter {
  const record = asRecord(raw)
  return {
    name: String(record['name'] ?? ''),
    location: (record['in'] ?? 'query') as Parameter['location'],
    required: record['required'] === true,
    schema: asRecord(record['schema']) as Schema
  }
}

function toContent(raw: unknown): Record<string, MediaType> {
  const out: Record<string, MediaType> = {}
  for (const [mediaType, value] of Object.entries(asRecord(raw))) {
    const record = asRecord(value)
    out[mediaType] = {
      schema: asRecord(record['schema']) as Schema,
      example: record['example'],
      examples: record['examples'] as MediaType['examples']
    }
  }
  return out
}

function toResponses(raw: unknown): ResponseSpec[] {
  const out: ResponseSpec[] = []
  for (const [code, value] of Object.entries(asRecord(raw))) {
    const status = Number.parseInt(code, 10)
    if (Number.isNaN(status)) continue
    const record = asRecord(value)
    const headers: Record<string, Schema> = {}
    for (const [name, header] of Object.entries(asRecord(record['headers']))) {
      headers[name] = asRecord(asRecord(header)['schema']) as Schema
    }
    out.push({
      status,
      description: record['description'] as string | undefined,
      headers,
      content: toContent(record['content'])
    })
  }
  return out.sort((a, b) => a.status - b.status)
}

export function loadApi(doc: Record<string, unknown>): Api {
  const version = doc['openapi']
  if (typeof version !== 'string') {
    throw new Error(
      'mockingham: document is missing a string "openapi" version field. ' +
        'Swagger 2.0 documents are not supported.'
    )
  }

  const resolved = resolveDocument(doc)
  const operations: Operation[] = []

  for (const [path, rawItem] of Object.entries(asRecord(resolved['paths']))) {
    const item = asRecord(rawItem)
    const shared = Array.isArray(item['parameters'])
      ? (item['parameters'] as unknown[]).map(toParameter)
      : []

    for (const method of HTTP_METHODS) {
      const rawOp = item[method]
      if (rawOp === undefined) continue
      const op = asRecord(rawOp)
      const own = Array.isArray(op['parameters'])
        ? (op['parameters'] as unknown[]).map(toParameter)
        : []
      const merged = [...shared]
      for (const param of own) {
        const index = merged.findIndex(
          (p) => p.name === param.name && p.location === param.location
        )
        if (index === -1) merged.push(param)
        else merged[index] = param
      }

      operations.push({
        method: method as HttpMethod,
        path,
        operationId: op['operationId'] as string | undefined,
        summary: op['summary'] as string | undefined,
        description: op['description'] as string | undefined,
        parameters: merged,
        requestBody: op['requestBody']
          ? toContent(asRecord(op['requestBody'])['content'])
          : undefined,
        responses: toResponses(op['responses'])
      })
    }
  }

  return { version, operations }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/spec/load.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/spec/load.ts test/spec/load.test.ts test/fixtures/petstore.ts
```

```sh
git commit -m 'feat: normalize OpenAPI documents into the Api model' -m 'Flattens paths and methods into operations, merges path-level parameters with operation-level overrides, and sorts responses by status.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 4: Route matching

**Files:**
- Create: `src/spec/routes.ts`
- Test: `test/spec/routes.test.ts`

**Interfaces:**
- Consumes: `Operation`, `HttpMethod` from Task 1.
- Produces: `createRouter(operations: Operation[]): Router`, where `Router` is `{ match(method: string, path: string): RouteMatch | undefined; allowedMethods(path: string): string[] }` and `RouteMatch` is `{ operation: Operation; params: Record<string, string> }`. `allowedMethods` returns uppercase method names for the 405 `Allow` header.

- [ ] **Step 1: Write the failing test**

Create `test/spec/routes.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../../src/spec/routes.ts'
import type { Operation } from '../../src/spec/types.ts'

function op(method: Operation['method'], path: string, id: string): Operation {
  return { method, path, operationId: id, parameters: [], responses: [] }
}

test('matches a static path', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.equal(router.match('GET', '/pets')?.operation.operationId, 'listPets')
})

test('extracts path parameters', () => {
  const router = createRouter([op('get', '/pets/{petId}', 'showPet')])
  const found = router.match('GET', '/pets/42')
  assert.equal(found?.operation.operationId, 'showPet')
  assert.deepEqual(found?.params, { petId: '42' })
})

test('static segments beat dynamic ones at equal depth', () => {
  const router = createRouter([
    op('get', '/pets/{petId}', 'showPet'),
    op('get', '/pets/mine', 'myPet')
  ])
  assert.equal(router.match('GET', '/pets/mine')?.operation.operationId, 'myPet')
  assert.equal(router.match('GET', '/pets/9')?.operation.operationId, 'showPet')
})

test('is case-insensitive on method', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.ok(router.match('get', '/pets'))
})

test('percent-decodes path parameters', () => {
  const router = createRouter([op('get', '/pets/{name}', 'byName')])
  assert.deepEqual(router.match('GET', '/pets/a%20b')?.params, { name: 'a b' })
})

test('ignores a trailing slash', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.ok(router.match('GET', '/pets/'))
})

test('returns undefined for an unknown path', () => {
  const router = createRouter([op('get', '/pets', 'listPets')])
  assert.equal(router.match('GET', '/nope'), undefined)
})

test('reports allowed methods for a known path', () => {
  const router = createRouter([
    op('get', '/pets', 'listPets'),
    op('post', '/pets', 'createPet')
  ])
  assert.deepEqual(router.allowedMethods('/pets').sort(), ['GET', 'POST'])
  assert.deepEqual(router.allowedMethods('/nope'), [])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/spec/routes.test.ts`
Expected: FAIL — cannot find module `../../src/spec/routes.ts`.

- [ ] **Step 3: Implement `src/spec/routes.ts`**

Routes are sorted once at construction. The score array marks each segment `0` for static and `1` for dynamic; ascending lexicographic order therefore puts `/pets/mine` ahead of `/pets/{petId}`.

```ts
import type { Operation } from './types.ts'

export interface RouteMatch {
  operation: Operation
  params: Record<string, string>
}

export interface Router {
  match(method: string, path: string): RouteMatch | undefined
  allowedMethods(path: string): string[]
}

interface Segment {
  value: string
  dynamic: boolean
}

interface Route {
  operation: Operation
  segments: Segment[]
  score: number[]
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

function compile(operation: Operation): Route {
  const segments = split(operation.path).map((raw) => {
    const matched = /^\{(.+)\}$/.exec(raw)
    return matched
      ? { value: matched[1] as string, dynamic: true }
      : { value: raw, dynamic: false }
  })
  return { operation, segments, score: segments.map((s) => (s.dynamic ? 1 : 0)) }
}

function compareScore(a: Route, b: Route): number {
  const length = Math.max(a.score.length, b.score.length)
  for (let i = 0; i < length; i++) {
    const left = a.score[i] ?? -1
    const right = b.score[i] ?? -1
    if (left !== right) return left - right
  }
  return 0
}

/**
 * `decodeURIComponent` throws a `URIError` on a malformed escape such as `%`
 * or `%zz`. Path segments come straight off the wire, so a client could
 * otherwise crash route matching with `GET /pets/%`. An undecodable segment is
 * treated as a non-match, which surfaces as a 404 rather than an exception.
 */
function decodeSegment(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

function matchSegments(
  route: Route,
  parts: string[]
): Record<string, string> | undefined {
  if (route.segments.length !== parts.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i] as Segment
    const part = parts[i] as string
    if (segment.dynamic) {
      const decoded = decodeSegment(part)
      if (decoded === undefined) return undefined
      params[segment.value] = decoded
    } else if (segment.value !== part) return undefined
  }
  return params
}

export function createRouter(operations: Operation[]): Router {
  const routes = operations.map(compile).sort(compareScore)

  return {
    match(method, path) {
      const wanted = method.toUpperCase()
      const parts = split(path)
      for (const route of routes) {
        if (route.operation.method.toUpperCase() !== wanted) continue
        const params = matchSegments(route, parts)
        if (params !== undefined) return { operation: route.operation, params }
      }
      return undefined
    },

    allowedMethods(path) {
      const parts = split(path)
      const found: string[] = []
      for (const route of routes) {
        if (matchSegments(route, parts) === undefined) continue
        const method = route.operation.method.toUpperCase()
        if (!found.includes(method)) found.push(method)
      }
      return found
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/spec/routes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/spec/routes.ts test/spec/routes.test.ts
```

```sh
git commit -m 'feat: compile path templates into a route matcher' -m 'Static segments beat dynamic ones at equal depth. Path parameters are percent-decoded, and allowedMethods backs the 405 Allow header.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 5: Seeded PRNG

**Files:**
- Create: `src/generate/rng.ts`
- Test: `test/generate/rng.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fnv1a(input: string): number` and `createRng(seed: number | string): Rng`, where `Rng` is `{ next(): number; int(min: number, max: number): number; pick<T>(items: readonly T[]): T; bool(): boolean }`. `next` returns `[0, 1)`; `int` is inclusive of both bounds.

- [ ] **Step 1: Write the failing test**

Create `test/generate/rng.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng, fnv1a } from '../../src/generate/rng.ts'

test('the same seed produces the same sequence', () => {
  const a = createRng('seed-1')
  const b = createRng('seed-1')
  const left = [a.next(), a.next(), a.next()]
  const right = [b.next(), b.next(), b.next()]
  assert.deepEqual(left, right)
})

test('different seeds produce different sequences', () => {
  const a = createRng('seed-1')
  const b = createRng('seed-2')
  assert.notEqual(a.next(), b.next())
})

test('next stays within [0, 1)', () => {
  const rng = createRng('bounds')
  for (let i = 0; i < 1000; i++) {
    const value = rng.next()
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
  }
})

test('int is inclusive of both bounds and never exceeds them', () => {
  const rng = createRng('ints')
  const seen = new Set<number>()
  for (let i = 0; i < 1000; i++) {
    const value = rng.int(1, 3)
    assert.ok(value >= 1 && value <= 3, `out of range: ${value}`)
    seen.add(value)
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3])
})

test('int handles a single-value range', () => {
  const rng = createRng('single')
  assert.equal(rng.int(7, 7), 7)
})

test('pick returns a member of the array', () => {
  const rng = createRng('pick')
  const items = ['a', 'b', 'c'] as const
  for (let i = 0; i < 100; i++) assert.ok(items.includes(rng.pick(items)))
})

test('fnv1a is stable and differs across inputs', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'))
  assert.notEqual(fnv1a('abc'), fnv1a('abd'))
  assert.ok(Number.isInteger(fnv1a('abc')))
  assert.ok(fnv1a('abc') >= 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/generate/rng.test.ts`
Expected: FAIL — cannot find module `../../src/generate/rng.ts`.

- [ ] **Step 3: Implement `src/generate/rng.ts`**

mulberry32 over an FNV-1a hash of the seed string. Both are chosen for being short enough to own outright rather than take a dependency.

```ts
export interface Rng {
  next(): number
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(): boolean
}

export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function createRng(seed: number | string): Rng {
  let state = (typeof seed === 'string' ? fnv1a(seed) : seed) >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => {
      // The signature promises a T. Returning `items[0]` of an empty array
      // would hand back `undefined` wearing a T's type, which surfaces far
      // from the cause. Fail loudly at the call site instead.
      if (items.length === 0) {
        throw new Error('mockingham: cannot pick from an empty array')
      }
      return items[Math.floor(next() * items.length)] as T
    },
    bool: () => next() < 0.5
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/generate/rng.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/generate/rng.ts test/generate/rng.test.ts
```

```sh
git commit -m 'feat: add seeded PRNG and FNV-1a hashing' -m 'mulberry32 over an FNV-1a seed hash. This is the only source of randomness in the project; Math.random is forbidden in generation paths.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 6: Shared schema interpretation

**Files:**
- Create: `src/schema/walk.ts`
- Test: `test/schema/walk.test.ts`

**Interfaces:**
- Consumes: `Schema` from Task 1.
- Produces: `classify(schema: Schema): SchemaKind`, `mergeAllOf(schema: Schema): Schema`, `isNullable(schema: Schema): boolean`.
  `SchemaKind` is a discriminated union on `kind`: `'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'const' | 'union' | 'null' | 'unknown'`. Variants carry: `object` → `{ properties, required: string[], additional: Schema | false }`; `array` → `{ items: Schema }`; `enum` → `{ values: unknown[] }`; `const` → `{ value: unknown }`; `union` → `{ variants: Schema[]; discriminator?: string }`.

**This is the single interpretation point named in invariant 1 of `CLAUDE.md`.** The zod compiler in plan 2 consumes the same `classify` output. Do not add a second traversal.

- [ ] **Step 1: Write the failing test**

Create `test/schema/walk.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isNullable, mergeAllOf } from '../../src/schema/walk.ts'

test('classifies primitives', () => {
  assert.equal(classify({ type: 'string' }).kind, 'string')
  assert.equal(classify({ type: 'integer' }).kind, 'integer')
  assert.equal(classify({ type: 'number' }).kind, 'number')
  assert.equal(classify({ type: 'boolean' }).kind, 'boolean')
  assert.equal(classify({ type: 'null' }).kind, 'null')
})

test('const and enum win over type', () => {
  const asConst = classify({ type: 'string', const: 'x' })
  assert.equal(asConst.kind, 'const')
  const asEnum = classify({ type: 'string', enum: ['a', 'b'] })
  assert.equal(asEnum.kind, 'enum')
  if (asEnum.kind === 'enum') assert.deepEqual(asEnum.values, ['a', 'b'])
})

test('classifies objects with required and additionalProperties', () => {
  const kind = classify({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' } },
    additionalProperties: false
  })
  assert.equal(kind.kind, 'object')
  if (kind.kind === 'object') {
    assert.deepEqual(kind.required, ['a'])
    assert.equal(kind.additional, false)
    assert.equal(kind.properties.a?.type, 'string')
  }
})

test('infers object from properties when type is absent', () => {
  assert.equal(classify({ properties: { a: { type: 'string' } } }).kind, 'object')
})

test('infers array from items when type is absent', () => {
  assert.equal(classify({ items: { type: 'string' } }).kind, 'array')
})

test('classifies oneOf and anyOf as a union, carrying the discriminator', () => {
  const kind = classify({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    discriminator: { propertyName: 'kind' }
  })
  assert.equal(kind.kind, 'union')
  if (kind.kind === 'union') {
    assert.equal(kind.variants.length, 2)
    assert.equal(kind.discriminator, 'kind')
  }
})

test('treats a 3.1 type array as nullable plus the base type', () => {
  assert.equal(classify({ type: ['string', 'null'] }).kind, 'string')
  assert.equal(isNullable({ type: ['string', 'null'] }), true)
})

test('honors the 3.0 nullable keyword', () => {
  assert.equal(isNullable({ type: 'string', nullable: true }), true)
  assert.equal(isNullable({ type: 'string' }), false)
})

test('mergeAllOf combines properties and required', () => {
  const merged = mergeAllOf({
    allOf: [
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } }
    ]
  })
  assert.equal(merged.type, 'object')
  assert.deepEqual(merged.required?.sort(), ['a', 'b'])
  assert.equal(merged.properties?.a?.type, 'string')
  assert.equal(merged.properties?.b?.type, 'integer')
})

test('classify merges allOf before classifying', () => {
  const kind = classify({
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } }
    ]
  })
  assert.equal(kind.kind, 'object')
  if (kind.kind === 'object') {
    assert.deepEqual(Object.keys(kind.properties).sort(), ['a', 'b'])
  }
})

test('an empty schema is unknown', () => {
  assert.equal(classify({}).kind, 'unknown')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/schema/walk.test.ts`
Expected: FAIL — cannot find module `../../src/schema/walk.ts`.

- [ ] **Step 3: Implement `src/schema/walk.ts`**

```ts
import type { Schema } from '../spec/types.ts'

export type SchemaKind =
  | {
      kind: 'object'
      properties: Record<string, Schema>
      required: string[]
      additional: Schema | false
    }
  | { kind: 'array'; items: Schema }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'integer' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'enum'; values: unknown[] }
  | { kind: 'const'; value: unknown }
  | {
      kind: 'union'
      variants: Schema[]
      mode: 'one' | 'any'
      discriminator?: string
    }
  | { kind: 'unknown' }

function typeNames(schema: Schema): string[] {
  if (Array.isArray(schema.type)) return schema.type
  if (typeof schema.type === 'string') return [schema.type]
  return []
}

export function isNullable(schema: Schema): boolean {
  return schema.nullable === true || typeNames(schema).includes('null')
}

/**
 * Flattens `allOf` composition into a single schema.
 *
 * One precedence rule, applied to every keyword alike: `allOf` members are
 * merged in declaration order so a later member overrides an earlier one, and
 * the outer schema's own keywords then override all members. `properties` and
 * `required` accumulate instead of replacing — properties union with the outer
 * schema winning a key collision, required is a plain union.
 *
 * Every keyword is carried through, not just the structural ones. A constraint
 * that lives only on an `allOf` member (`minLength`, `pattern`, `format`,
 * `multipleOf`, …) must survive, or generation and validation would both
 * silently ignore it.
 */
export function mergeAllOf(schema: Schema): Schema {
  if (!schema.allOf || schema.allOf.length === 0) return schema

  const own: Record<string, unknown> = { ...schema }
  delete own['allOf']

  const merged: Record<string, unknown> = {}
  const properties: Record<string, Schema> = {}
  const required = new Set<string>()

  const absorb = (source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (key === 'properties' || key === 'required') continue
      merged[key] = value
    }
    const sourceProps = source['properties'] as
      | Record<string, Schema>
      | undefined
    for (const [name, prop] of Object.entries(sourceProps ?? {})) {
      properties[name] = prop
    }
    for (const name of (source['required'] as string[] | undefined) ?? []) {
      required.add(name)
    }
  }

  for (const part of schema.allOf) {
    absorb(mergeAllOf(part) as unknown as Record<string, unknown>)
  }
  absorb(own)

  const result = merged as Schema
  if (Object.keys(properties).length > 0) {
    result.properties = properties
    if (result.type === undefined) result.type = 'object'
  }
  if (required.size > 0) result.required = [...required]

  return result
}

export function classify(input: Schema): SchemaKind {
  const schema = mergeAllOf(input)

  if (schema.const !== undefined) return { kind: 'const', value: schema.const }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: 'enum', values: schema.enum }
  }

  // oneOf and anyOf differ: oneOf must match exactly one variant, anyOf at
  // least one. Only this module can preserve the distinction, so `mode` carries
  // it — a validator built on `classify` cannot recover it any other way.
  const variants = schema.oneOf ?? schema.anyOf
  if (Array.isArray(variants) && variants.length > 0) {
    return {
      kind: 'union',
      variants,
      mode: schema.oneOf ? 'one' : 'any',
      discriminator: schema.discriminator?.propertyName
    }
  }

  const names = typeNames(schema).filter((name) => name !== 'null')
  const primary = names[0]

  if (primary === 'object' || (primary === undefined && schema.properties)) {
    const additional =
      schema.additionalProperties === false
        ? false
        : typeof schema.additionalProperties === 'object'
          ? schema.additionalProperties
          : {}
    return {
      kind: 'object',
      properties: schema.properties ?? {},
      required: schema.required ?? [],
      additional
    }
  }

  if (primary === 'array' || (primary === undefined && schema.items)) {
    return { kind: 'array', items: schema.items ?? {} }
  }

  if (primary === 'string') return { kind: 'string' }
  if (primary === 'integer') return { kind: 'integer' }
  if (primary === 'number') return { kind: 'number' }
  if (primary === 'boolean') return { kind: 'boolean' }
  if (typeNames(schema).length > 0 && names.length === 0) return { kind: 'null' }

  return { kind: 'unknown' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/schema/walk.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/schema/walk.ts test/schema/walk.test.ts
```

```sh
git commit -m 'feat: add the shared schema interpretation' -m 'classify is the single point where a schema is interpreted; generation and the later zod compiler both consume it, so the two can never diverge. Merges allOf, folds 3.0 nullable and 3.1 type arrays together.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 7: Constraint handling

**Files:**
- Create: `src/generate/constraints.ts`
- Test: `test/generate/constraints.test.ts`

**Interfaces:**
- Consumes: `Schema` from Task 1.
- Produces: `numberBounds(schema: Schema): { min: number; max: number }`, `applyMultipleOf(value: number, schema: Schema): number`, `stringLength(schema: Schema): { min: number; max: number }`, `arrayLength(schema: Schema): { min: number; max: number }`. Defaults when unconstrained: numbers `0..1000`, strings `5..12`, arrays `1..3`.

- [ ] **Step 1: Write the failing test**

Create `test/generate/constraints.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMultipleOf, arrayLength, numberBounds, stringLength
} from '../../src/generate/constraints.ts'

test('number bounds default when unconstrained', () => {
  assert.deepEqual(numberBounds({}), { min: 0, max: 1000 })
})

test('number bounds honor minimum and maximum', () => {
  assert.deepEqual(numberBounds({ minimum: 5, maximum: 9 }), { min: 5, max: 9 })
})

test('number bounds honor numeric exclusive bounds', () => {
  assert.deepEqual(
    numberBounds({ exclusiveMinimum: 5, exclusiveMaximum: 9 }),
    { min: 6, max: 8 }
  )
})

test('number bounds honor boolean exclusive bounds from 3.0', () => {
  assert.deepEqual(
    numberBounds({ minimum: 5, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: true }),
    { min: 6, max: 8 }
  )
})

test('applyMultipleOf snaps up into range', () => {
  assert.equal(applyMultipleOf(7, { multipleOf: 5 }), 5)
  assert.equal(applyMultipleOf(7, { multipleOf: 5, minimum: 6 }), 10)
  assert.equal(applyMultipleOf(7, {}), 7)
})

test('string length defaults and honors bounds', () => {
  assert.deepEqual(stringLength({}), { min: 5, max: 12 })
  assert.deepEqual(stringLength({ minLength: 2, maxLength: 4 }), { min: 2, max: 4 })
})

test('string length keeps max at or above min', () => {
  assert.deepEqual(stringLength({ minLength: 20 }), { min: 20, max: 20 })
})

test('array length defaults and honors bounds', () => {
  assert.deepEqual(arrayLength({}), { min: 1, max: 3 })
  assert.deepEqual(arrayLength({ minItems: 4, maxItems: 6 }), { min: 4, max: 6 })
})

test('array length keeps max at or above min', () => {
  assert.deepEqual(arrayLength({ minItems: 8 }), { min: 8, max: 8 })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/generate/constraints.test.ts`
Expected: FAIL — cannot find module `../../src/generate/constraints.ts`.

- [ ] **Step 3: Implement `src/generate/constraints.ts`**

```ts
import type { Schema } from '../spec/types.ts'

const DEFAULT_NUMBER_MIN = 0
const DEFAULT_NUMBER_MAX = 1000
const DEFAULT_STRING_MIN = 5
const DEFAULT_STRING_MAX = 12
const DEFAULT_ARRAY_MIN = 1
const DEFAULT_ARRAY_MAX = 3

export function numberBounds(schema: Schema): { min: number; max: number } {
  let min = schema.minimum ?? DEFAULT_NUMBER_MIN
  let max = schema.maximum ?? DEFAULT_NUMBER_MAX

  // A numeric exclusive bound (3.1) and a plain bound may both be present, and
  // both must hold — so take whichever is tighter rather than letting the last
  // branch win. The boolean form (3.0) only modifies its own plain bound.
  if (typeof schema.exclusiveMinimum === 'number') {
    min = Math.max(min, schema.exclusiveMinimum + 1)
  } else if (schema.exclusiveMinimum === true && schema.minimum !== undefined) {
    min = schema.minimum + 1
  }

  if (typeof schema.exclusiveMaximum === 'number') {
    max = Math.min(max, schema.exclusiveMaximum - 1)
  } else if (schema.exclusiveMaximum === true && schema.maximum !== undefined) {
    max = schema.maximum - 1
  }

  if (max < min) max = min
  return { min, max }
}

export function applyMultipleOf(value: number, schema: Schema): number {
  const step = schema.multipleOf
  if (step === undefined || step <= 0) return value
  const { min, max } = numberBounds(schema)
  const snapped = Math.floor(value / step) * step
  if (snapped >= min && snapped <= max) return snapped
  const raised = Math.ceil(min / step) * step
  if (raised <= max) return raised
  // No multiple of `step` exists anywhere in [min, max]. Staying inside the
  // declared range matters more than the multiple, so the bounds win.
  return min
}

/**
 * Resolves an optional min/max pair against defaults, guaranteeing `max >= min`.
 *
 * An explicitly declared bound is never violated. When only one is given, the
 * default on the other side yields to it — including when a lone `max` sits
 * below the default minimum, which is the case that silently corrupted output
 * before: `maxLength: 2` must not resolve to a minimum of 5.
 */
function bounded(
  min: number | undefined,
  max: number | undefined,
  fallbackMin: number,
  fallbackMax: number
): { min: number; max: number } {
  if (min !== undefined && max !== undefined) {
    return { min, max: max < min ? min : max }
  }
  if (min !== undefined) return { min, max: Math.max(fallbackMax, min) }
  if (max !== undefined) return { min: Math.min(fallbackMin, max), max }
  return { min: fallbackMin, max: fallbackMax }
}

export function stringLength(schema: Schema): { min: number; max: number } {
  return bounded(
    schema.minLength, schema.maxLength, DEFAULT_STRING_MIN, DEFAULT_STRING_MAX
  )
}

export function arrayLength(schema: Schema): { min: number; max: number } {
  return bounded(
    schema.minItems, schema.maxItems, DEFAULT_ARRAY_MIN, DEFAULT_ARRAY_MAX
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/generate/constraints.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/generate/constraints.ts test/generate/constraints.test.ts
```

```sh
git commit -m 'feat: resolve schema constraints into generation bounds' -m 'Handles both the 3.1 numeric and 3.0 boolean forms of exclusiveMinimum and exclusiveMaximum, and keeps max at or above min so bounds are always satisfiable.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 8: Leaf value producers

**Files:**
- Create: `src/generate/values.ts`
- Test: `test/generate/values.test.ts`

**Interfaces:**
- Consumes: `Rng` from Task 5; the constraint helpers from Task 7; `Schema` from Task 1.
- Produces: `generateString(schema: Schema, rng: Rng): string`, `generateNumber(schema: Schema, rng: Rng): number`, `generateInteger(schema: Schema, rng: Rng): number`, `generateBoolean(rng: Rng): boolean`.
  `generateString` is format-aware: `email`, `uuid`, `uri`, `hostname`, `ipv4`, `date`, `date-time`. Unknown formats fall back to a plain word. **`pattern` is not supported** — when present with no `example` or `default`, the plain word is returned; the caller warns.

- [ ] **Step 1: Write the failing test**

Create `test/generate/values.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../src/generate/rng.ts'
import {
  generateBoolean, generateInteger, generateNumber, generateString
} from '../../src/generate/values.ts'

test('strings respect length bounds', () => {
  const rng = createRng('strings')
  for (let i = 0; i < 200; i++) {
    const value = generateString({ minLength: 3, maxLength: 6 }, rng)
    assert.ok(value.length >= 3 && value.length <= 6, `bad length: ${value}`)
  }
})

test('email format produces a plausible address', () => {
  const value = generateString({ type: 'string', format: 'email' }, createRng('e'))
  assert.match(value, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/)
})

test('uuid format produces a v4-shaped uuid', () => {
  const value = generateString({ type: 'string', format: 'uuid' }, createRng('u'))
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
})

test('date-time format parses as a date', () => {
  const value = generateString({ type: 'string', format: 'date-time' }, createRng('d'))
  assert.ok(!Number.isNaN(Date.parse(value)))
})

test('date format is calendar-only', () => {
  const value = generateString({ type: 'string', format: 'date' }, createRng('d2'))
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/)
})

test('ipv4 format produces four octets in range', () => {
  const value = generateString({ type: 'string', format: 'ipv4' }, createRng('ip'))
  const octets = value.split('.').map(Number)
  assert.equal(octets.length, 4)
  for (const octet of octets) assert.ok(octet >= 0 && octet <= 255)
})

test('generation is deterministic for a given seed', () => {
  const schema = { type: 'string', format: 'email' }
  const first = generateString(schema, createRng('same'))
  const second = generateString(schema, createRng('same'))
  assert.equal(first, second)
})

test('integers respect bounds and are whole numbers', () => {
  const rng = createRng('ints')
  for (let i = 0; i < 200; i++) {
    const value = generateInteger({ minimum: 10, maximum: 12 }, rng)
    assert.ok(Number.isInteger(value))
    assert.ok(value >= 10 && value <= 12, `out of range: ${value}`)
  }
})

test('integers respect multipleOf', () => {
  const rng = createRng('multiples')
  for (let i = 0; i < 100; i++) {
    const value = generateInteger({ minimum: 0, maximum: 100, multipleOf: 5 }, rng)
    assert.equal(value % 5, 0)
  }
})

test('numbers respect bounds', () => {
  const rng = createRng('numbers')
  for (let i = 0; i < 200; i++) {
    const value = generateNumber({ minimum: 1.5, maximum: 2.5 }, rng)
    assert.ok(value >= 1.5 && value <= 2.5, `out of range: ${value}`)
  }
})

test('booleans are booleans', () => {
  assert.equal(typeof generateBoolean(createRng('b')), 'boolean')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/generate/values.test.ts`
Expected: FAIL — cannot find module `../../src/generate/values.ts`.

- [ ] **Step 3: Implement `src/generate/values.ts`**

Note the fixed epoch constant — invariant 2 forbids `Date.now()` in a generation path, because it would make output non-reproducible across runs.

```ts
import type { Schema } from '../spec/types.ts'
import type { Rng } from './rng.ts'
import { applyMultipleOf, numberBounds, stringLength } from './constraints.ts'

const WORDS = [
  'alder', 'basalt', 'cedar', 'dune', 'ember', 'fjord', 'gale', 'harbor',
  'ivory', 'juniper', 'kelp', 'larch', 'marsh', 'nimbus', 'onyx', 'pine',
  'quarry', 'ridge', 'slate', 'thicket', 'umber', 'vale', 'willow', 'zephyr'
] as const

const GIVEN = ['cara', 'neil', 'ada', 'omar', 'ines', 'raul', 'thea', 'yuki'] as const
const FAMILY = ['whitfield', 'ashford', 'nakamura', 'olsen', 'pereira', 'quinn'] as const
const TLDS = ['com', 'io', 'dev', 'eu'] as const
const HEX = '0123456789abcdef'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Fixed epoch so generated dates are reproducible across runs. */
const EPOCH_MS = Date.parse('2024-01-01T00:00:00.000Z')
const YEAR_MS = 365 * 24 * 60 * 60 * 1000

function word(rng: Rng): string {
  return rng.pick(WORDS)
}

function hex(rng: Rng, count: number): string {
  let out = ''
  for (let i = 0; i < count; i++) out += HEX[rng.int(0, 15)]
  return out
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function fitLength(value: string, schema: Schema, rng: Rng): string {
  const { min, max } = stringLength(schema)
  let out = value
  while (out.length < min) out += `-${word(rng)}`
  if (out.length > max) out = out.slice(0, max)
  return out
}

function generateDate(rng: Rng): Date {
  return new Date(EPOCH_MS + rng.int(0, YEAR_MS))
}

export function generateString(schema: Schema, rng: Rng): string {
  switch (schema.format) {
    case 'email':
      return `${rng.pick(GIVEN)}.${rng.pick(FAMILY)}@${word(rng)}.${rng.pick(TLDS)}`
    case 'uuid':
      return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${
        HEX[rng.int(8, 11)]
      }${hex(rng, 3)}-${hex(rng, 12)}`
    case 'uri':
    case 'url':
      return `https://${word(rng)}.${rng.pick(TLDS)}/${word(rng)}`
    case 'hostname':
      return `${word(rng)}.${rng.pick(TLDS)}`
    case 'ipv4':
      return `${rng.int(1, 254)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`
    case 'ipv6':
      return `${hex(rng, 4)}:${hex(rng, 4)}:${hex(rng, 4)}:${hex(rng, 4)}`
    case 'date':
      return generateDate(rng).toISOString().slice(0, 10)
    case 'date-time':
      return generateDate(rng).toISOString()
    case 'time':
      return `${pad(rng.int(0, 23), 2)}:${pad(rng.int(0, 59), 2)}:${pad(rng.int(0, 59), 2)}`
    case 'duration':
      return `P${rng.int(1, 30)}D`
    case 'byte': {
      let out = ''
      for (let i = 0; i < 12; i++) out += B64[rng.int(0, 63)]
      return `${out}==`
    }
    case 'password':
      return `${word(rng)}-${hex(rng, 6)}`
    default:
      return fitLength(word(rng), schema, rng)
  }
}

export function generateInteger(schema: Schema, rng: Rng): number {
  const { min, max } = numberBounds(schema)
  return applyMultipleOf(rng.int(Math.ceil(min), Math.floor(max)), schema)
}

export function generateNumber(schema: Schema, rng: Rng): number {
  const { min, max } = numberBounds(schema)
  const raw = min + rng.next() * (max - min)
  const rounded = Math.round(raw * 100) / 100
  return applyMultipleOf(rounded, schema)
}

export function generateBoolean(rng: Rng): boolean {
  return rng.bool()
}
```

> **Note for the implementer:** this file must use no Node globals and no `node:` imports — it is reachable from the pure core (invariant 3). That is why `byte` builds a base64-shaped string from an alphabet rather than reaching for `Buffer`. The output is well-formed base64 characters, not an encoding of anything meaningful, which is all a mock needs.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/generate/values.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/generate/values.ts test/generate/values.test.ts
```

```sh
git commit -m 'feat: add format-aware leaf value producers' -m 'Covers email, uuid, uri, hostname, ipv4, ipv6, date, date-time, time, duration, byte and password. Dates derive from a fixed epoch so output stays reproducible across runs.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 9: Recursive value generation

**Files:**
- Create: `src/generate/generate.ts`
- Test: `test/generate/generate.test.ts`

**Interfaces:**
- Consumes: `classify`/`isNullable` from Task 6; the producers from Task 8; `arrayLength` from Task 7; `Rng` from Task 5.
- Produces: `generateValue(schema: Schema, rng: Rng, options?: GenerateOptions): unknown`, where `GenerateOptions` is `{ maxDepth?: number; preferExamples?: boolean }`. Defaults: `maxDepth` 3, `preferExamples` true.
- Precedence implemented here (spec §3): `example` → `default` → `enum` → generated. Overrides and fixtures slot in above `example` in plan 2.

- [ ] **Step 1: Write the failing test**

Create `test/generate/generate.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../src/generate/rng.ts'
import { generateValue } from '../../src/generate/generate.ts'
import type { Schema } from '../../src/spec/types.ts'

test('generates an object with all required properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      tag: { type: 'string' }
    }
  }
  const value = generateValue(schema, createRng('obj')) as Record<string, unknown>
  assert.equal(typeof value.id, 'number')
  assert.equal(typeof value.name, 'string')
})

test('generates arrays within item bounds', () => {
  const schema: Schema = { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 }
  const value = generateValue(schema, createRng('arr')) as unknown[]
  assert.ok(Array.isArray(value))
  assert.ok(value.length >= 2 && value.length <= 4)
  for (const item of value) assert.equal(typeof item, 'string')
})

test('prefers a spec example over generation', () => {
  const schema: Schema = { type: 'string', example: 'fixed-value' }
  assert.equal(generateValue(schema, createRng('ex')), 'fixed-value')
})

test('preferExamples false ignores the example', () => {
  const schema: Schema = { type: 'string', example: 'fixed-value' }
  const value = generateValue(schema, createRng('ex'), { preferExamples: false })
  assert.notEqual(value, 'fixed-value')
})

test('uses default when no example is present', () => {
  assert.equal(generateValue({ type: 'string', default: 'dflt' }, createRng('d')), 'dflt')
})

test('picks from enum', () => {
  const schema: Schema = { type: 'string', enum: ['a', 'b', 'c'] }
  const value = generateValue(schema, createRng('en'))
  assert.ok(['a', 'b', 'c'].includes(value as string))
})

test('returns const verbatim', () => {
  assert.equal(generateValue({ const: 42 }, createRng('c')), 42)
})

test('picks a variant for a union', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  const value = generateValue(schema, createRng('un'))
  assert.ok(typeof value === 'string' || typeof value === 'number')
})

test('terminates on a recursive schema at maxDepth', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  const value = generateValue(node, createRng('rec'), { maxDepth: 2 })
  assert.equal(typeof value, 'object')
})

test('is deterministic for a given seed', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } }
  }
  const first = generateValue(schema, createRng('stable'))
  const second = generateValue(schema, createRng('stable'))
  assert.deepEqual(first, second)
})

test('an unknown schema generates null', () => {
  assert.equal(generateValue({}, createRng('unk')), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/generate/generate.test.ts`
Expected: FAIL — cannot find module `../../src/generate/generate.ts`.

- [ ] **Step 3: Implement `src/generate/generate.ts`**

```ts
import type { Schema } from '../spec/types.ts'
import { classify } from '../schema/walk.ts'
import { arrayLength } from './constraints.ts'
import type { Rng } from './rng.ts'
import {
  generateBoolean, generateInteger, generateNumber, generateString
} from './values.ts'

export interface GenerateOptions {
  maxDepth?: number
  preferExamples?: boolean
}

const DEFAULT_MAX_DEPTH = 3

export function generateValue(
  schema: Schema,
  rng: Rng,
  options: GenerateOptions = {}
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const preferExamples = options.preferExamples ?? true

  function walk(current: Schema, depth: number): unknown {
    if (preferExamples && current.example !== undefined) return current.example
    if (current.default !== undefined) return current.default

    const kind = classify(current)

    switch (kind.kind) {
      case 'const':
        return kind.value
      case 'enum':
        return rng.pick(kind.values)
      case 'string':
        return generateString(current, rng)
      case 'integer':
        return generateInteger(current, rng)
      case 'number':
        return generateNumber(current, rng)
      case 'boolean':
        return generateBoolean(rng)
      case 'null':
        return null
      case 'union':
        return depth >= maxDepth ? null : walk(rng.pick(kind.variants), depth + 1)
      case 'array': {
        if (depth >= maxDepth) return []
        const { min, max } = arrayLength(current)
        const count = rng.int(min, max)
        const items: unknown[] = []
        for (let i = 0; i < count; i++) items.push(walk(kind.items, depth + 1))
        return items
      }
      case 'object': {
        if (depth >= maxDepth) return {}
        const out: Record<string, unknown> = {}
        for (const [name, property] of Object.entries(kind.properties)) {
          out[name] = walk(property, depth + 1)
        }
        return out
      }
      default:
        return null
    }
  }

  return walk(schema, 0)
}
```

> **Note for the implementer:** every optional property is generated, not just required ones. That is deliberate — a client written against the mock should see the full shape. Selective omission arrives with overrides in plan 2.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/generate/generate.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/generate/generate.ts test/generate/generate.test.ts
```

```sh
git commit -m 'feat: compose schemas into whole generated values' -m 'Implements the example, default, enum, generated precedence and bounds recursion at maxDepth so cyclic schemas terminate.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 10: The pure request handler

**Files:**
- Create: `src/server/handler.ts`
- Test: `test/server/handler.test.ts`

**Interfaces:**
- Consumes: `createRouter` from Task 4; `generateValue` from Task 9; `createRng`/`fnv1a` from Task 5; `Api` from Task 1.
- Produces: `createHandler(api: Api, options?: HandlerOptions): (request: Request) => Promise<Response>`, where `HandlerOptions` is `{ seed?: string; maxDepth?: number; preferExamples?: boolean; debugHeaders?: boolean }`.
- Behavior: 404 for an unmatched path, 405 with an `Allow` header for a known path with the wrong method, the lowest declared 2xx otherwise. `Prefer: status=NNN` selects a declared status. Response headers declared in the spec are generated. With `debugHeaders`, adds `x-mock-seed` and `x-mock-operation`.

**Invariant 3 applies:** this file and everything it imports must not import a `node:` module.

- [ ] **Step 1: Write the failing test**

Create `test/server/handler.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createHandler } from '../../src/server/handler.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)
const handler = createHandler(api, { seed: 'test' })

test('serves a generated object for a matched route', async () => {
  const res = await handler(new Request('http://x/pets/42'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const body = await res.json()
  assert.equal(typeof body.id, 'number')
  assert.equal(typeof body.name, 'string')
})

test('serves a generated array', async () => {
  const res = await handler(new Request('http://x/pets'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body))
  assert.equal(typeof body[0].name, 'string')
})

test('is deterministic for the same request', async () => {
  const first = await (await handler(new Request('http://x/pets/42'))).json()
  const second = await (await handler(new Request('http://x/pets/42'))).json()
  assert.deepEqual(first, second)
})

test('differs across different path parameters', async () => {
  const a = await (await handler(new Request('http://x/pets/42'))).json()
  const b = await (await handler(new Request('http://x/pets/43'))).json()
  assert.notDeepEqual(a, b)
})
// If this assertion fails it is NOT flaky — generation is deterministic, so
// these two seeds genuinely collided on every field. Change 42/43 to two other
// ids and it will stay passing. Do not weaken the assertion.

test('returns 404 for an unknown path', async () => {
  const res = await handler(new Request('http://x/nope'))
  assert.equal(res.status, 404)
})

test('returns 405 with an Allow header for a known path', async () => {
  const res = await handler(new Request('http://x/pets/42', { method: 'DELETE' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET')
})

test('selects the lowest declared 2xx', async () => {
  const res = await handler(new Request('http://x/pets', { method: 'POST' }))
  assert.equal(res.status, 201)
})

test('honors Prefer: status', async () => {
  const res = await handler(
    new Request('http://x/pets/42', { headers: { prefer: 'status=404' } })
  )
  assert.equal(res.status, 404)
})

test('generates spec-declared response headers', async () => {
  const res = await handler(new Request('http://x/pets'))
  assert.equal(typeof res.headers.get('x-next'), 'string')
})

test('emits debug headers when enabled', async () => {
  const debug = createHandler(api, { seed: 'test', debugHeaders: true })
  const res = await debug(new Request('http://x/pets/42'))
  assert.equal(res.headers.get('x-mock-operation'), 'showPetById')
  assert.ok(res.headers.get('x-mock-seed'))
})

test('a response with no content yields 204-style empty body', async () => {
  const res = await handler(new Request('http://x/pets', { method: 'POST' }))
  assert.equal(res.status, 201)
  assert.equal(await res.text(), '')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/server/handler.test.ts`
Expected: FAIL — cannot find module `../../src/server/handler.ts`.

- [ ] **Step 3: Implement `src/server/handler.ts`**

```ts
import { createRouter } from '../spec/routes.ts'
import type { Api, Operation, ResponseSpec } from '../spec/types.ts'
import { generateValue } from '../generate/generate.ts'
import { createRng, fnv1a } from '../generate/rng.ts'

export interface HandlerOptions {
  seed?: string
  maxDepth?: number
  preferExamples?: boolean
  debugHeaders?: boolean
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

function preferredStatus(request: Request): number | undefined {
  const header = request.headers.get('prefer')
  if (!header) return undefined
  const matched = /status=(\d{3})/.exec(header)
  return matched ? Number.parseInt(matched[1] as string, 10) : undefined
}

function selectResponse(
  operation: Operation,
  request: Request
): ResponseSpec | undefined {
  const wanted = preferredStatus(request)
  if (wanted !== undefined) {
    const found = operation.responses.find((r) => r.status === wanted)
    if (found) return found
  }
  const success = operation.responses.find((r) => r.status >= 200 && r.status < 300)
  return success ?? operation.responses[0]
}

export function createHandler(
  api: Api,
  options: HandlerOptions = {}
): (request: Request) => Promise<Response> {
  const router = createRouter(api.operations)
  const seed = options.seed ?? 'mockingham'
  const generateOptions = {
    maxDepth: options.maxDepth,
    preferExamples: options.preferExamples
  }

  return async function handle(request: Request): Promise<Response> {
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
        { error: { code: 'MOCK_NOT_FOUND', message: `No operation for ${url.pathname}` } },
        { status: 404 }
      )
    }

    const { operation, params } = matched
    const spec = selectResponse(operation, request)
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

    const key = requestKey(operation, params, seed)
    const headers = new Headers()

    for (const [name, schema] of Object.entries(spec.headers)) {
      const value = generateValue(schema, createRng(`${key}|header|${name}`), generateOptions)
      if (value !== null && value !== undefined) headers.set(name, String(value))
    }

    if (options.debugHeaders) {
      headers.set('x-mock-seed', String(fnv1a(key)))
      if (operation.operationId) headers.set('x-mock-operation', operation.operationId)
    }

    const media = spec.content[JSON_TYPE]
    if (!media) {
      return new Response(null, { status: spec.status, headers })
    }

    const body = generateValue(
      media.schema,
      createRng(`${key}|${spec.status}`),
      generateOptions
    )
    headers.set('content-type', JSON_TYPE)
    return new Response(JSON.stringify(body), { status: spec.status, headers })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/handler.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify the core imports no Node modules**

Run: `grep -rn "from 'node:" src/spec src/schema src/generate src/server/handler.ts`
Expected: no matches. Any match violates invariant 3 and must be moved to `src/server/node.ts`.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/server/handler.ts test/server/handler.test.ts
```

```sh
git commit -m 'feat: add the pure request handler' -m 'Matches a route, selects a status, generates body and declared headers from a seed derived from request identity. Returns 404 for unknown paths and 405 with Allow for known ones. Imports no node: modules.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

### Task 11: Node adapter and public surface

**Files:**
- Create: `src/server/node.ts`
- Create: `src/index.ts`
- Test: `test/server/node.test.ts`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `createHandler` from Task 10; `loadApi` from Task 3.
- Produces: `createMock(doc: Record<string, unknown>, options?: MockOptions): Mock`, where `MockOptions` extends `HandlerOptions` and `Mock` is `{ fetch(request: Request): Promise<Response>; listen(port?: number): Promise<{ url: string; port: number }>; close(): Promise<void>; api: Api }`. Passing port `0` binds an ephemeral port; the resolved value reports the real one.

- [ ] **Step 1: Write the failing tests**

Create `test/server/node.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { petstore } from '../fixtures/petstore.ts'

test('listens on an ephemeral port and serves over real HTTP', async () => {
  const mock = createMock(petstore, { seed: 'node' })
  const { url, port } = await mock.listen(0)
  assert.ok(port > 0)

  try {
    const res = await fetch(`${url}/pets/7`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.name, 'string')
  } finally {
    await mock.close()
  }
})

test('propagates status and headers over the wire', async () => {
  const mock = createMock(petstore, { seed: 'node' })
  const { url } = await mock.listen(0)

  try {
    const res = await fetch(`${url}/pets/7`, { method: 'DELETE' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'GET')
  } finally {
    await mock.close()
  }
})

test('close is idempotent', async () => {
  const mock = createMock(petstore)
  await mock.listen(0)
  await mock.close()
  await mock.close()
})
```

Create `test/integration.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../src/index.ts'
import { petstore } from './fixtures/petstore.ts'

test('in-process fetch needs no socket', async () => {
  const mock = createMock(petstore, { seed: 'integration' })
  const res = await mock.fetch(new Request('http://mock/pets/1'))
  assert.equal(res.status, 200)
})

test('the same request is byte-identical across separate instances', async () => {
  const a = createMock(petstore, { seed: 'stable' })
  const b = createMock(petstore, { seed: 'stable' })
  const left = await (await a.fetch(new Request('http://mock/pets/99'))).text()
  const right = await (await b.fetch(new Request('http://mock/pets/99'))).text()
  assert.equal(left, right)
})

test('a different root seed changes the output', async () => {
  const a = createMock(petstore, { seed: 'one' })
  const b = createMock(petstore, { seed: 'two' })
  const left = await (await a.fetch(new Request('http://mock/pets/99'))).text()
  const right = await (await b.fetch(new Request('http://mock/pets/99'))).text()
  assert.notEqual(left, right)
})

test('exposes the loaded api', () => {
  const mock = createMock(petstore)
  assert.equal(mock.api.operations.length, 4)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server/node.test.ts test/integration.test.ts`
Expected: FAIL — cannot find module `../../src/index.ts`.

- [ ] **Step 3: Implement `src/server/node.ts`**

```ts
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FetchHandler = (request: Request) => Promise<Response>

function toRequest(incoming: IncomingMessage, body: Buffer): Request {
  const host = incoming.headers.host ?? 'localhost'
  const url = `http://${host}${incoming.url ?? '/'}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  const method = incoming.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0
  return new Request(url, { method, headers, body: hasBody ? body : undefined })
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  outgoing.writeHead(response.status, headers)
  const text = await response.text()
  outgoing.end(text)
}

export interface NodeServer {
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
}

export function createNodeServer(handler: FetchHandler): NodeServer {
  let server: Server | undefined

  return {
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        const created = createServer((incoming, outgoing) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('end', () => {
            handler(toRequest(incoming, Buffer.concat(chunks)))
              .then((response) => send(response, outgoing))
              .catch(() => {
                outgoing.writeHead(500, { 'content-type': 'application/json' })
                outgoing.end('{"error":{"code":"MOCK_INTERNAL"}}')
              })
          })
        })

        created.once('error', reject)
        created.listen(port, () => {
          server = created
          const address = created.address() as AddressInfo
          resolve({ url: `http://127.0.0.1:${address.port}`, port: address.port })
        })
      })
    },

    close() {
      return new Promise((resolve) => {
        if (!server) return resolve()
        server.close(() => {
          server = undefined
          resolve()
        })
      })
    }
  }
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { loadApi } from './spec/load.ts'
import type { Api } from './spec/types.ts'
import { createHandler } from './server/handler.ts'
import type { HandlerOptions } from './server/handler.ts'
import { createNodeServer } from './server/node.ts'

export type MockOptions = HandlerOptions

export interface Mock {
  fetch(request: Request): Promise<Response>
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
  api: Api
}

export function createMock(
  doc: Record<string, unknown>,
  options: MockOptions = {}
): Mock {
  const api = loadApi(doc)
  const handler = createHandler(api, options)
  const server = createNodeServer(handler)

  return {
    fetch: handler,
    listen: (port) => server.listen(port),
    close: () => server.close(),
    api
  }
}

export { loadApi } from './spec/load.ts'
export type { Api, Operation, Schema } from './spec/types.ts'
export type { HandlerOptions } from './server/handler.ts'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/server/node.test.ts test/integration.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests across all files. No open handles keeping the process alive.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/server/node.ts src/index.ts test/server/node.test.ts test/integration.test.ts
```

```sh
git commit -m 'feat: add node:http adapter and createMock surface' -m 'Wraps the pure handler in a node:http server with ephemeral port support and idempotent close. createMock is the public entry point.' -m 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>'
```

---

## Definition of Done

All of these must hold before this plan is considered complete:

- [ ] `npm test` passes with every test file green.
- [ ] `npx tsc --noEmit` reports no errors.
- [ ] `grep -rn "from 'node:" src/spec src/schema src/generate src/server/handler.ts` returns nothing.
- [ ] `grep -rn "Math.random\|Date.now()" src/` returns nothing.
- [ ] Pointing `createMock` at the petstore fixture and requesting the same path twice in separate processes yields byte-identical bodies.

## What plan 2 picks up

Spec phases 4–6: the override layering engine (`resolve/layer.ts`), the request context, response callbacks, the OpenAPI-to-zod compiler, request validation, spec-driven auth, and on-contract error construction. The first thing plan 2 does is add `overrides` above `example` in the precedence chain implemented in Task 9.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMock,
  createMemoryFixtureStore,
  createDiskFixtureStore,
  createRecordedSource
} from '../../src/index.ts'
import type { ContentSource, FixtureRequest, FixtureResult, McpOptions, McpServerHandle } from '../../src/index.ts'

/**
 * The bake-commit-serve loop is what this subsystem exists for, and until now
 * none of the pieces needed to drive it were reachable from the package root -
 * only the types were exported, never the factories. These tests fail if any of
 * them stops being part of the public surface, which is otherwise invisible:
 * deep imports into `src/fixtures/...` keep working regardless.
 */

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/u': {
      get: {
        operationId: 'u',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { bio: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

test('the whole bake-then-serve loop runs on package-root exports alone', async () => {
  // This is the loop the subsystem exists for, driven entirely by what the
  // package root exposes: build a store, build a source, bake, serve. Every
  // import in this file comes from src/index.ts, so if any piece stops being
  // public this test stops compiling rather than silently regressing.
  const store = createMemoryFixtureStore()
  const source = createRecordedSource([
    { operationId: 'u', status: 200, value: { bio: 'recorded upstream' } }
  ])
  const mock = createMock(doc, {
    fixtures: { store },
    llm: { mode: 'bake', source }
  })

  const summary = await mock.bake()
  assert.equal(summary.generated, 1)

  const response = await mock.fetch(new Request('https://x/u'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { bio: 'recorded upstream' })
})

test('a caller can build a recorded source without deep imports', async () => {
  const source = createRecordedSource([
    { operationId: 'u', status: 200, value: { bio: 'recorded' } }
  ])

  assert.equal(typeof source.generate, 'function')
})

test('a caller can write a source against the exported types alone', async () => {
  // The provider-neutrality goal, expressed through the public surface: this
  // compiles using only what the package root exports.
  const source: ContentSource = {
    generate: async (reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]> =>
      reqs.map((request) => ({ value: { bio: request.operationId } }))
  }

  const [result] = await source.generate([
    {
      operationId: 'u',
      method: 'get',
      path: '/u',
      status: 200,
      key: 'k',
      params: {},
      jsonSchema: { type: 'object' },
      zodSchema: { safeParse: () => ({ success: true, data: {} }) } as never
    }
  ])

  assert.deepEqual(result?.value, { bio: 'u' })
})

test('the disk store factory is reachable from the package root', () => {
  assert.equal(typeof createDiskFixtureStore, 'function')
})

test('the package exposes the MCP server surface', () => {
  const mock = createMock(doc)
  assert.equal(typeof mock.mcp, 'function')

  const handle = mock.mcp({ transport: 'inline' })
  assert.equal(typeof handle.handleRequest, 'function')
  assert.equal(typeof handle.connectStdio, 'function')
  assert.equal(handle.path, undefined, 'inline transport mounts nothing')
})

const unsupportedPatternDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/lookahead': {
      get: {
        operationId: 'lookahead',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['secret'],
                  // A lookahead - outside the generator's subset, so it warns
                  // and falls back rather than emitting a wrong value silently.
                  properties: { secret: { type: 'string', pattern: '^(?=.*\\d)[a-z]+$' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

test('an unsupported pattern warns once, not once per request', async () => {
  const warnings: string[] = []
  const mock = createMock(unsupportedPatternDoc, {
    seed: 'warn-once',
    onWarn: (message: string) => warnings.push(message)
  })

  await mock.fetch(new Request('http://mock/lookahead'))
  await mock.fetch(new Request('http://mock/lookahead'))
  await mock.fetch(new Request('http://mock/lookahead'))

  assert.equal(warnings.length, 1, warnings.join(' | '))
  // The message must name the pattern, or it cannot be acted on. Asserted on
  // content rather than order: dedupe is keyed per pattern and warning order
  // follows request order, which no test should depend on.
  assert.match(warnings[0] as string, /\(\?=/)
})

test('a document with no unsupported pattern warns not at all', () => {
  const warnings: string[] = []
  createMock(doc, { seed: 'quiet', onWarn: (message: string) => warnings.push(message) })
  assert.deepEqual(warnings, [])
})

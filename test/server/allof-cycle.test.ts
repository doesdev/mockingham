import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { fixtureKey } from '../../src/fixtures/key.ts'

/**
 * A document whose component composes itself through `allOf`. Ref resolution
 * makes both references the same object, so the resolved schema genuinely
 * contains itself. Redundant rather than invalid - the mock must serve it.
 */
function selfComposingDoc(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: { id: { type: 'string' } },
          allOf: [{ $ref: '#/components/schemas/Node' }]
        }
      }
    },
    paths: {
      '/n': {
        get: {
          operationId: 'getNode',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Node' } }
              }
            }
          }
        }
      }
    }
  }
}

test('a self-composing schema serves a generated body instead of a 500', async () => {
  const mock = createMock(selfComposingDoc())

  const response = await mock.fetch(new Request('https://x/n'))

  assert.equal(response.status, 200)
  const body = (await response.json()) as { id?: unknown }
  assert.equal(typeof body.id, 'string')
})

test('a self-composing request body validates instead of failing the request', async () => {
  const doc = selfComposingDoc()
  const paths = doc.paths as Record<string, Record<string, unknown>>
  paths['/n'] = {
    post: {
      operationId: 'postNode',
      requestBody: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Node' } }
        }
      },
      responses: { '200': { description: 'ok' } }
    }
  }
  const mock = createMock(doc)

  const response = await mock.fetch(
    new Request('https://x/n', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'given' })
    })
  )

  assert.notEqual(response.status, 500)
})

test('constructing a mock does not throw when a fixture forces a schema hash', async () => {
  // The staleness check hashes each operation's response schema at construction,
  // which reaches classify(). Only a fixture carrying meta triggers it, so this
  // is the path that turns a per-request failure into no mock at all.
  const store = createMemoryFixtureStore()
  store.set('getNode', 200, fixtureKey({ method: 'get', path: '/n', params: {} }), {
    value: { id: 'baked' },
    meta: { schemaHash: 'deliberately-stale' }
  })

  const mock = createMock(selfComposingDoc(), { fixtures: { store } })

  const response = await mock.fetch(new Request('https://x/n'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 'baked' })
})

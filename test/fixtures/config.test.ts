import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLlm } from '../../src/fixtures/config.ts'
import { createMock } from '../../src/index.ts'

test('no config resolves to undefined', () => {
  assert.equal(resolveLlm(undefined, {}), undefined)
})

test('off mode needs no provider configuration', () => {
  const resolved = resolveLlm({ mode: 'off' }, {})
  assert.equal(resolved?.mode, 'off')
  assert.equal(resolved?.source, undefined)
})

test('off mode short-circuits before the provider branch, even when a provider is named', () => {
  // If 'off' fell through to the provider branch, naming 'anthropic' here
  // would throw the "requires @anthropic-ai/sdk" error unconditionally —
  // that branch throws regardless of any other config. Not throwing proves
  // the mode==='off' return happens first.
  const resolved = resolveLlm({ mode: 'off', provider: 'anthropic' }, {})
  assert.equal(resolved?.mode, 'off')
  assert.equal(resolved?.source, undefined)
})

test('an llm mode without a base url fails loudly, with an instruction naming a concrete next step', () => {
  // A bare /baseUrl/ regex is satisfied even by an unguarded
  // `parsed.openai.baseUrl` throwing "Cannot read properties of undefined
  // (reading 'baseUrl')" once the explicit guard is removed — that
  // TypeError happens to contain the literal word "baseUrl" too, so it
  // would pass a substring check for the wrong reason (verified: this
  // exact mutation left the brief's original assertion green). Requiring
  // the actual next-step wording distinguishes an intentional, instructive
  // throw from an accidental crash that merely mentions the same field name.
  assert.throws(
    () => resolveLlm({ mode: 'bake' }, {}),
    /llm\.openai\.baseUrl is required.*llm\.source directly/s
  )
})

test('the default provider is openai-compatible', () => {
  const resolved = resolveLlm(
    { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm' } },
    {}
  )
  assert.ok(resolved?.source)
})

test('an explicit source wins over the provider', () => {
  const source = { generate: async () => [] }
  const resolved = resolveLlm({ mode: 'bake', source }, {})
  assert.equal(resolved?.source, source)
})

test('an explicit source bypasses the provider branch entirely, even a provider that always throws', () => {
  // provider: 'anthropic' with no source would throw ("requires
  // @anthropic-ai/sdk") unconditionally — see the previous test file's
  // provider throw. Supplying a source alongside it and getting no throw is
  // direct proof the provider branch was never reached, not just that the
  // returned source happens to match.
  const source = { generate: async () => [] }
  const resolved = resolveLlm({ mode: 'bake', provider: 'anthropic', source }, {})
  assert.equal(resolved?.source, source)
})

test('an unknown key fails validation', () => {
  assert.throws(
    () => resolveLlm({ mode: 'bake', bassUrl: 'typo' } as never, {}),
    /bassUrl|unrecognized/i
  )
})

test('an anthropic option in the openai block fails validation', () => {
  assert.throws(
    () =>
      resolveLlm(
        { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm', batchThreshold: 10 } } as never,
        {}
      ),
    /batchThreshold|unrecognized/i
  )
})

test('an unrecognized key inside the anthropic block fails validation too', () => {
  // The audit's own example scenario: a key that belongs to no provider
  // block at all, placed inside anthropic. This is a distinct .strict() call
  // from the openai block's — proving it independently rather than assuming
  // one nested-strict test stands in for both.
  //
  // mode: 'off' is deliberate, not incidental. With mode: 'bake' (tried
  // first), this test stayed green even after deleting the anthropic
  // block's .strict() — because with no `provider` given, resolution still
  // falls into the openai-compatible branch by default, which then throws
  // its own unrelated "openai.baseUrl is required" error (that message also
  // happens to contain the word "baseUrl", satisfying the regex for the
  // wrong reason). configSchema.parse() itself runs before any mode check,
  // so mode: 'off' lets the config fail validation for the right reason
  // while guaranteeing no other branch is left to throw a masking error
  // once that validation is removed.
  assert.throws(
    () => resolveLlm({ mode: 'off', anthropic: { baseUrl: 'http://x/v1' } } as never, {}),
    /baseUrl|unrecognized/i
  )
})

test('openai.strict is accepted and does not fail validation', () => {
  // Correction 1 in the task brief: createOpenAiSource gained a `strict`
  // option after the brief snippet was written. This proves the config
  // schema actually admits it in the openai block, rather than rejecting it
  // as unrecognized the way batchThreshold is rejected above.
  const resolved = resolveLlm(
    { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm', strict: true } },
    {}
  )
  assert.ok(resolved?.source)
})

test('budget defaults are filled in', () => {
  const resolved = resolveLlm(
    { mode: 'bake', openai: { baseUrl: 'http://x/v1', model: 'm' } },
    {}
  )
  assert.equal(resolved?.budget.maxConcurrency, 4)
  assert.equal(resolved?.budget.timeoutMs, 30_000)
})

test('explicit budget values override the defaults rather than being ignored', () => {
  const resolved = resolveLlm(
    {
      mode: 'bake',
      openai: { baseUrl: 'http://x/v1', model: 'm' },
      budget: { maxCalls: 7, maxConcurrency: 2, timeoutMs: 5_000 }
    },
    {}
  )
  assert.equal(resolved?.budget.maxCalls, 7)
  assert.equal(resolved?.budget.maxConcurrency, 2)
  assert.equal(resolved?.budget.timeoutMs, 5_000)
})

// --- Beyond resolveLlm: Mock.bake() wiring ------------------------------

// No path parameters, deliberately: bake() walks operations with an EMPTY
// params map (it has no concrete request to draw params from), while a real
// request supplies whatever params the URL contains. On a parameterized
// path those two fixture keys diverge and a baked fixture would never be
// read back by fetch() — that divergence is real bake.ts behavior, not a
// test bug, so this end-to-end proof deliberately uses a param-free
// operation where the two keys coincide.
const bakeDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/profile': {
      get: {
        operationId: 'getProfile',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, bio: { type: 'string' } },
                  required: ['id', 'bio']
                }
              }
            }
          }
        }
      }
    }
  }
}

test('Mock.bake() fills the store through the public surface: a baked fixture is served on request, not just reported generated', async () => {
  const instance = createMock(bakeDoc, {
    llm: {
      mode: 'bake',
      source: {
        generate: async (reqs) => reqs.map(() => ({ value: { id: 'baked-id', bio: 'baked-bio' } }))
      }
    }
  })
  const summary = await instance.bake()
  assert.equal(summary.generated, 1)
  // Proof the store was actually filled, read through fetch() — the public
  // request path — rather than only trusting the summary count. A
  // freshly-seed-generated body would never coincidentally match these
  // literal strings.
  const response = await instance.fetch(new Request('http://mock/profile'))
  assert.deepEqual(await response.json(), { id: 'baked-id', bio: 'baked-bio' })
})

test('Mock.bake() throws a clear error when no llm source is configured', async () => {
  const instance = createMock(bakeDoc)
  await assert.rejects(() => instance.bake(), /llm source/)
})

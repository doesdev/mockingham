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
    // `as any` because this project has no DOM lib, so Response.json() resolves
    // to undici-types' Promise<unknown> rather than DOM's Promise<any>.
    const body = (await res.json()) as any
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

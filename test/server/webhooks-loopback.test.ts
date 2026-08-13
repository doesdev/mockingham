import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMock } from '../../src/index.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId'],
                properties: { orderId: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {}
}

interface Received {
  body: string
  signature?: string
}

/** A throwaway receiver. `failFirst` makes the first attempt a 500. */
function receiver(failFirst: boolean): Promise<{
  url: string
  received: Received[]
  close(): Promise<void>
  server: Server
}> {
  const received: Received[] = []
  let calls = 0
  return new Promise((resolve) => {
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString(),
          signature: incoming.headers['x-mockingham-signature'] as string | undefined
        })
        calls += 1
        outgoing.writeHead(failFirst && calls === 1 ? 500 : 200)
        outgoing.end()
      })
    })
    server.listen(0, () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}/hook`,
        received,
        server,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

async function verify(secret: string, header: string, body: string): Promise<boolean> {
  const [rawTs, rawSig] = header.split(',')
  const timestamp = rawTs!.slice('t='.length)
  const expected = rawSig!.slice('v1='.length)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const mac = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)
  )
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return hex === expected
}

test('a real delivery arrives signed and verifiable', async () => {
  const hook = await receiver(false)
  const mock = createMock(doc, {
    seed: 'loopback',
    webhooks: { onOrderShipped: { url: hook.url, secret: 'topsecret' } }
  })

  const delivery = await mock.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.status, 200)
  assert.equal(hook.received.length, 1)
  assert.equal(hook.received[0]!.body, delivery.body)

  // The signature the receiver got verifies against the body it got — the
  // security-critical path a consumer will implement.
  const header = hook.received[0]!.signature
  assert.ok(header, 'no signature header arrived')
  assert.equal(await verify('topsecret', header, hook.received[0]!.body), true)
  assert.equal(await verify('wrong', header, hook.received[0]!.body), false)

  await mock.close()
  await hook.close()
})

test('a real delivery retries a 500 and succeeds on the second attempt', async () => {
  const hook = await receiver(true)
  const slept: number[] = []
  const mock = createMock(doc, {
    seed: 'loopback',
    sleep: async (ms) => { slept.push(ms) },
    webhooks: { onOrderShipped: { url: hook.url, retry: { attempts: 3 } } }
  })

  const delivery = await mock.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.attempts, 2)
  assert.equal(hook.received.length, 2)
  assert.equal(slept.length, 1)

  await mock.close()
  await hook.close()
})

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

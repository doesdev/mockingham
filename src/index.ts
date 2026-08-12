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

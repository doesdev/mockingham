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

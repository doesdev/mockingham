export const HTTP_METHODS = [
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch'
] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

/** An OpenAPI Schema Object, after $ref resolution. May contain cycles. */
export interface Schema {
  type?: string | string[]
  format?: string
  /**
   * A property position may hold a boolean schema: `true` allows anything,
   * `false` allows nothing - which is how `else: { properties: { x: false } }`
   * says "x must be absent on this branch".
   */
  properties?: Record<string, Schema | boolean>
  required?: string[]
  items?: Schema
  enum?: unknown[]
  const?: unknown
  default?: unknown
  example?: unknown
  nullable?: boolean
  allOf?: Schema[]
  /**
   * `if`/`then`/`else` conditional application. Read through
   * `conditionalOf()` in `src/schema/walk.ts` - the one place either half of
   * the mock interprets them.
   */
  if?: Schema
  then?: Schema
  else?: Schema
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
  /**
   * A mock-only format override, honored when `format` itself must keep a
   * value another consumer validates against. Today only `"uuid7"` is read.
   */
  'x-mock-format'?: string
}

export interface SecurityScheme {
  type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect'
  /** For `http`: `bearer`, `basic`, and so on. */
  scheme?: string
  /** For `apiKey`: where the credential travels. */
  location?: 'header' | 'query' | 'cookie'
  /** For `apiKey`: the header, query parameter, or cookie name. */
  name?: string
}

/**
 * One requirement object. Every scheme named inside it must be satisfied
 * together; a list of them is satisfied when ANY one object is.
 */
export type SecurityRequirement = Record<string, string[]>

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
  /**
   * For a range key (`4XX`) this is the range's LOWER BOUND - 400, not 4 - so
   * that every `response.status === x` comparison keeps its meaning and only
   * code that must distinguish a range reads `range`.
   */
  status: number
  /** True when the document spelled this response as a `1XX`-`5XX` range. */
  range?: boolean
  description?: string
  headers: Record<string, Schema>
  content: Record<string, MediaType>
}

/**
 * One outbound request the document says the API can make - a 3.1 top-level
 * `webhooks` entry, or a per-operation `callbacks` entry contributing its
 * payload schema under its own name.
 */
export interface WebhookSpec {
  name: string
  method: HttpMethod
  body?: Record<string, MediaType>
  /** Header parameters only; nothing else can travel on an outbound request. */
  headers: Parameter[]
}

/**
 * A per-operation `callbacks` entry. `expression` is the OpenAPI runtime
 * expression exactly as written - it can only be resolved against a live
 * request, so it stays text until then.
 */
export interface CallbackSpec {
  name: string
  expression: string
  method: HttpMethod
  body?: Record<string, MediaType>
}

export interface Operation {
  method: HttpMethod
  path: string
  operationId?: string
  summary?: string
  description?: string
  /** Free-form OpenAPI tags. Always present; `[]` when the document declares none. */
  tags: string[]
  parameters: Parameter[]
  requestBody?: Record<string, MediaType>
  requestBodyRequired?: boolean
  responses: ResponseSpec[]
  defaultResponse?: ResponseSpec
  security?: SecurityRequirement[]
  callbacks: CallbackSpec[]
}

export interface Api {
  version: string
  operations: Operation[]
  /** Maps a resolved component schema object to the name it was declared under. */
  schemaNames: Map<Schema, string>
  securitySchemes: Record<string, SecurityScheme>
  webhooks: Record<string, WebhookSpec>
}

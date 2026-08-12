import type { Operation } from '../spec/types.ts'
import type { Rng } from '../generate/rng.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { generateValue } from '../generate/generate.ts'
import { responseForStatus } from './select.ts'

const JSON_TYPE = 'application/json'

export interface ErrorEnvelope {
  error: { code: string; message: string }
}

export function envelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
}

export interface ErrorDetail {
  code: string
  message: string
  errors?: Array<{ path: string; message: string }>
}

export type ErrorBodyMode =
  | 'contract'
  | 'diagnostic'
  | ((ctx: unknown, error: ErrorDetail) => unknown)

export interface ErrorInput {
  operation: Operation | undefined
  status: number
  code: string
  message: string
  errors?: Array<{ path: string; message: string }>
  mode: ErrorBodyMode
  rng: Rng
  generateOptions: GenerateOptions
  ctx?: unknown
  debugHeaders?: boolean
}

/**
 * Builds the body for a status mockingham emits itself.
 *
 * In `contract` mode it first looks for the status among the operation's own
 * declared responses — falling back to the operation's `default` — and generates
 * from that schema, so a client's error-path parsing is exercised too. Only when
 * the operation declares nothing usable does the built-in envelope appear.
 *
 * 404 always lands here with no operation, because no route matched and there is
 * therefore no contract to be on.
 */
export async function buildError(input: ErrorInput): Promise<Response> {
  const detail: ErrorDetail = {
    code: input.code,
    message: input.message,
    errors: input.errors
  }

  const headers = new Headers()
  if (input.debugHeaders) {
    headers.set(
      'x-mock-error',
      `${input.code}: ${input.message}`.replace(/[\r\n]+/g, ' ')
    )
  }

  if (typeof input.mode === 'function') {
    const body = input.mode(input.ctx, detail)
    headers.set('content-type', JSON_TYPE)
    return new Response(JSON.stringify(body), { status: input.status, headers })
  }

  if (input.mode === 'contract' && input.operation) {
    const declared = responseForStatus(input.operation, input.status)
    const media = declared?.content[JSON_TYPE]
    if (media) {
      const body = generateValue(media.schema, input.rng, input.generateOptions)
      headers.set('content-type', JSON_TYPE)
      return new Response(JSON.stringify(body), {
        status: input.status,
        headers
      })
    }
  }

  const body = envelope(input.code, input.message) as unknown as Record<string, unknown>
  if (input.errors) {
    ;(body['error'] as Record<string, unknown>)['errors'] = input.errors
  }
  headers.set('content-type', JSON_TYPE)
  return new Response(JSON.stringify(body), { status: input.status, headers })
}

/**
 * Distinguishes a failure inside a user-supplied callback from a genuine bug in
 * mockingham. Both reach the same boundary catch, but reporting an internal
 * defect as `MOCK_CALLBACK_FAILED` sends whoever is debugging in exactly the
 * wrong direction.
 *
 * A symbol keyed on the error object rather than a subclass: user callbacks
 * throw whatever they like, including non-Errors, and a wrapper would hide the
 * original stack.
 */
const CALLBACK = Symbol.for('mockingham.callback-error')

export function markCallback(error: unknown): unknown {
  if (error !== null && typeof error === 'object') {
    ;(error as Record<symbol, unknown>)[CALLBACK] = true
  }
  return error
}

export function isCallbackError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as Record<symbol, unknown>)[CALLBACK] === true
  )
}

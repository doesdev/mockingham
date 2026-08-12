export interface ErrorEnvelope {
  error: { code: string; message: string }
}

export function envelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
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

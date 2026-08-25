import type { ExprInput } from '../webhooks/expr.ts'
import { resolveExpression } from '../webhooks/expr.ts'
import { callbackKey } from '../webhooks/emit.ts'
import type { Store } from './store.ts'

/**
 * The post-response capture pass.
 *
 * The webhook destination registry, response linking, and the callback
 * destination tier the handler has always had are the same three steps:
 * evaluate a runtime expression against a final request/response pair, store
 * the resolved value under a derived key, and read it back later on a
 * different request or emission. This module owns that pass so those readers
 * cannot drift apart, and so the ordering between two captures is decided by
 * rule order rather than by which feature's block happens to run first.
 *
 * No `node:` imports here, ever: `server/handler.ts` calls this, and the core
 * is pure.
 *
 * Invariant 6 still holds at the call site, not here — the handler calls this
 * inside the single exit's `try`/`catch`, so a throw reaches `onError` and
 * never the caller.
 */

export type CaptureRule =
  | { kind: 'callback'; name: string; expression: string }
  | { kind: 'register'; webhook: string; url: string; scope?: string }
  | { kind: 'unregister'; webhook: string; scope?: string }
  | { kind: 'link'; index: number; keyExpr: string; remember: string }

export interface CaptureInput {
  rules: CaptureRule[]
  expr: ExprInput
  store: Store
  /** The parsed response body, for a whole-body `remember`. */
  responseBody: unknown
  /** The parsed request body, for a whole-body `remember`. */
  requestBody: unknown
}

export async function runCapture(input: CaptureInput): Promise<void> {
  for (const rule of input.rules) {
    if (rule.kind === 'callback') {
      const resolved = resolveExpression(rule.expression, input.expr)
      if (resolved.ok) await input.store.set(callbackKey(rule.name), resolved.value)
      continue
    }
    // `register`, `unregister`, and `link` are declared so the union is stable
    // for the tasks that implement them. They are a deliberate no-op rather
    // than a throw: a throw would make an unimplemented kind a landmine for
    // the next implementer, and would fail a whole capture pass over a rule
    // this build simply does not act on yet.
  }
}

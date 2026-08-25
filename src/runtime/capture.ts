import type { ExprInput } from '../webhooks/expr.ts'
import { normalizeExpression, resolveExpression } from '../webhooks/expr.ts'
import { callbackKey } from '../webhooks/emit.ts'
import type { Registry } from '../webhooks/registry.ts'
import type { Store } from './store.ts'
import type { LinkTable } from './link.ts'
import { REMEMBER_REQUEST_BODY, REMEMBER_RESPONSE_BODY } from './link.ts'

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
 * Invariant 6 still holds at the call site, not here - the handler calls this
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
  /**
   * Where a `register`/`unregister` rule writes. Absent when no webhook has a
   * registry configured, in which case those rules are not built either.
   */
  registry?: Registry
  /** Where a `link` rule records. Absent when no `link` rule is configured. */
  link?: LinkTable
}

/**
 * What a `link` rule's `remember` actually records.
 *
 * The sharp edge design §4.2 records: `{$response.body}` does NOT survive
 * `resolveExpression`. `resolveToken` funnels every body value through
 * `scalar()`, which returns `undefined` for an object - so a whole-body
 * template resolves to a FAILURE, not to the body. The two whole-body forms are
 * therefore taken directly from the parsed values the caller already has, and
 * only pointer forms addressing a scalar go through `resolveExpression`. This
 * is why `remember` has a default: most callers never write it.
 *
 * A bare `$response.body` is accepted alongside the braced spelling, because
 * OpenAPI's own `callbacks` keys are written bare and a reader coming from the
 * spec will type it that way. That acceptance is `normalizeExpression`, the one
 * shared spelling - and the NORMALIZED string is what goes on to
 * `resolveExpression`, not the original. Passing the original on was the defect:
 * a bare pointer matched no token, came back `ok` with its own literal text,
 * and that text was recorded and served as the recalled value.
 */
function remembered(remember: string, input: CaptureInput): unknown {
  const normalized = normalizeExpression(remember)
  if (normalized === REMEMBER_RESPONSE_BODY) return input.responseBody
  if (normalized === REMEMBER_REQUEST_BODY) return input.requestBody
  const resolved = resolveExpression(normalized, input.expr)
  return resolved.ok ? resolved.value : undefined
}

export async function runCapture(input: CaptureInput): Promise<void> {
  for (const rule of input.rules) {
    if (rule.kind === 'callback') {
      const resolved = resolveExpression(rule.expression, input.expr)
      if (resolved.ok) await input.store.set(callbackKey(rule.name), resolved.value)
      continue
    }

    if (rule.kind === 'register' || rule.kind === 'unregister') {
      if (input.registry === undefined) continue
      // A configured scope expression that does not resolve SKIPS the rule
      // rather than falling back to the unscoped key. Writing a tenant's
      // registration into the shared slot is precisely the cross-tenant
      // redirect scopeBy exists to prevent (design §3.4).
      let scope = ''
      if (rule.scope !== undefined) {
        const resolvedScope = resolveExpression(rule.scope, input.expr)
        if (!resolvedScope.ok) continue
        scope = resolvedScope.value
      }
      if (rule.kind === 'unregister') {
        await input.registry.unregister(rule.webhook, scope)
        continue
      }
      const url = resolveExpression(rule.url, input.expr)
      // An unresolvable destination stores NOTHING, so a later emit falls
      // through to the next tier rather than to an empty string - the same
      // rule the callback branch above follows.
      if (url.ok) await input.registry.register(rule.webhook, url.value, scope)
      continue
    }
    if (rule.kind === 'link') {
      if (input.link === undefined) continue
      const key = resolveExpression(rule.keyExpr, input.expr)
      // A key that does not resolve records nothing, so the read side falls
      // through to ordinary generation rather than recalling under an empty
      // string - the same fall-through a missing fixture gets.
      if (!key.ok) continue
      const value = remembered(rule.remember, input)
      if (value === undefined) continue
      await input.link.record(rule.index, key.value, value)
      continue
    }
    // Every kind in the union is handled above. An unrecognized one is a
    // deliberate no-op rather than a throw: a throw would fail a whole capture
    // pass - and with it every other rule at this exit - over one rule this
    // build does not act on.
  }
}

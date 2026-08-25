import type { SecurityRequirement, SecurityScheme } from '../spec/types.ts'
import { markCallback } from './errors.ts'
import type { Ctx, Fail, Stage } from './types.ts'

export type Principal = { sub?: string; scopes?: string[] } & Record<string, unknown>

export interface AuthSchemeConfig {
  verify?(
    credential: string,
    ctx: Ctx
  ): Principal | Response | Promise<Principal | Response>
}

export type AuthConfig = Record<string, true | AuthSchemeConfig>

export type AuthOutcome =
  | { ok: true; principal?: Principal }
  | { ok: false; status: number; code: string; message: string; response?: Response }

export interface AuthInput {
  security: SecurityRequirement[] | undefined
  schemes: Record<string, SecurityScheme>
  config: AuthConfig
  ctx: Ctx
}

/**
 * Reads one cookie out of a `Cookie` header. Exported because request
 * validation needs exactly the same reading for `in: cookie` parameters -
 * two parsers disagreeing about a cookie would be its own defect class.
 */
export function cookieValue(
  header: string | undefined,
  name: string
): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

const KNOWN_SCHEME_TYPES: ReadonlySet<string> = new Set([
  'apiKey',
  'http',
  'oauth2',
  'openIdConnect'
])

/**
 * Returned for a scheme whose credential this mock cannot inspect. Distinct
 * from `undefined`, which means "the scheme is enforceable and the credential
 * is missing" and produces a 401.
 */
const UNENFORCEABLE = Symbol('mockingham.unenforceable-scheme')

/** Pulls the credential a scheme describes out of the request. */
export function credentialFor(
  scheme: SecurityScheme,
  ctx: Ctx
): string | undefined | typeof UNENFORCEABLE {
  if (scheme.type === 'apiKey') {
    const name = scheme.name ?? ''
    if (scheme.location === 'query') {
      const found = ctx.query[name]
      return Array.isArray(found) ? found[0] : found
    }
    if (scheme.location === 'cookie') return cookieValue(ctx.headers['cookie'], name)
    return ctx.headers[name.toLowerCase()]
  }

  // A type this build does not know how to read a credential for. `mutualTLS`
  // is the real case - it is valid OpenAPI 3.1 and carries its credential in
  // the TLS handshake, which a mock never sees - and a typo'd or invented type
  // lands here too, since `toSecuritySchemes` casts rather than validates
  // (deferred item 13).
  //
  // Treated as unenforceable rather than as bearer. Falling through to the
  // bearer branch demanded an `Authorization: Bearer` header the document
  // never asked for, so a document declaring mutualTLS got a 401 on every
  // request with no way to satisfy it.
  if (!KNOWN_SCHEME_TYPES.has(scheme.type)) return UNENFORCEABLE

  // http basic/bearer, and oauth2/openIdConnect which are bearer in practice.
  const header = ctx.headers['authorization']
  if (header === undefined) return undefined
  const want = scheme.type === 'http' ? (scheme.scheme ?? 'bearer') : 'bearer'
  const [word, ...rest] = header.split(' ')
  if ((word ?? '').toLowerCase() !== want.toLowerCase()) return undefined
  const value = rest.join(' ').trim()
  return value.length > 0 ? value : undefined
}

function missing(scheme: string): AuthOutcome {
  return {
    ok: false,
    status: 401,
    code: 'MOCK_UNAUTHORIZED',
    message: `Missing or malformed credential for security scheme "${scheme}"`
  }
}

/**
 * OpenAPI security semantics, which are easy to invert:
 *  - the `security` array is OR - any ONE requirement object satisfied is enough
 *  - within one object it is AND - every scheme named must be satisfied
 *  - `security: []` means auth is explicitly NOT required, which is different
 *    from an absent `security` field
 */
export async function checkAuth(input: AuthInput): Promise<AuthOutcome> {
  const { security } = input
  if (security === undefined || security.length === 0) return { ok: true }

  let firstFailure: AuthOutcome | undefined
  let principal: Principal | undefined

  for (const requirement of security) {
    let satisfied = true
    let failure: AuthOutcome | undefined
    let found: Principal | undefined

    for (const [name, scopes] of Object.entries(requirement)) {
      const scheme = input.schemes[name]
      if (!scheme) {
        // A requirement naming a scheme the document never declared cannot be
        // satisfied. Failing closed is the safe reading.
        satisfied = false
        failure = missing(name)
        break
      }

      const credential = credentialFor(scheme, input.ctx)
      // Nothing to check and nothing to verify against, so the requirement is
      // treated as met rather than as permanently failing. A `verify` hook
      // needs a credential to receive, so it is skipped too.
      if (credential === UNENFORCEABLE) continue
      if (credential === undefined) {
        satisfied = false
        failure = missing(name)
        break
      }

      const entry = input.config[name]
      const verify = entry !== undefined && entry !== true ? entry.verify : undefined
      if (!verify) continue

      // `verify` is user code, so a throw or rejection is tagged: without this
      // the boundary reports someone else's bug as MOCK_INTERNAL.
      let verified: Principal | Response
      try {
        verified = await verify(credential, input.ctx)
      } catch (error) {
        throw markCallback(error)
      }
      if (verified instanceof Response) {
        satisfied = false
        failure = {
          ok: false,
          status: verified.status,
          code: 'MOCK_UNAUTHORIZED',
          message: 'Credential rejected',
          response: verified
        }
        break
      }

      const granted = verified.scopes ?? []
      const unmet = scopes.filter((scope) => !granted.includes(scope))
      if (unmet.length > 0) {
        satisfied = false
        failure = {
          ok: false,
          status: 403,
          code: 'MOCK_FORBIDDEN',
          message: `Missing required scope(s): ${unmet.join(', ')}`
        }
        break
      }

      found = { ...(found ?? {}), ...verified }
    }

    if (satisfied) {
      principal = found
      return { ok: true, principal }
    }
    // Report the first requirement's failure: it is the one the API author
    // listed first, and so the one a client most likely intended to satisfy.
    if (!firstFailure) firstFailure = failure
  }

  return firstFailure ?? missing(Object.keys(security[0] ?? {})[0] ?? 'unknown')
}

export interface AuthStageInput {
  security: SecurityRequirement[] | undefined
  schemes: Record<string, SecurityScheme>
  config: AuthConfig
  fail: Fail
}

/** Pipeline stage 3. */
export function createAuthStage(input: AuthStageInput): Stage {
  return async function authStage(ctx) {
    const outcome = await checkAuth({
      security: input.security,
      schemes: input.schemes,
      config: input.config,
      ctx
    })
    if (outcome.ok) {
      ctx.auth = outcome.principal
      // 'anonymous' is a real outcome, not a missing one: the operation declared
      // no security, or declared it optional and the caller sent nothing.
      ctx.decisions.auth = outcome.principal ? 'ok' : 'anonymous'
      return undefined
    }
    ctx.decisions.auth = 'denied'
    // A scheme may hand back a fully formed response (a WWW-Authenticate
    // challenge, say); that wins over the generic on-contract error.
    if (outcome.response) return outcome.response
    return await input.fail(outcome.status, outcome.code, outcome.message, ctx)
  }
}

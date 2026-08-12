import type { SecurityRequirement, SecurityScheme } from '../spec/types.ts'
import type { Ctx } from './types.ts'

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

function cookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

/** Pulls the credential a scheme describes out of the request. */
export function credentialFor(
  scheme: SecurityScheme,
  ctx: Ctx
): string | undefined {
  if (scheme.type === 'apiKey') {
    const name = scheme.name ?? ''
    if (scheme.location === 'query') {
      const found = ctx.query[name]
      return Array.isArray(found) ? found[0] : found
    }
    if (scheme.location === 'cookie') return cookie(ctx.headers['cookie'], name)
    return ctx.headers[name.toLowerCase()]
  }

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
 *  - the `security` array is OR — any ONE requirement object satisfied is enough
 *  - within one object it is AND — every scheme named must be satisfied
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
      if (credential === undefined) {
        satisfied = false
        failure = missing(name)
        break
      }

      const entry = input.config[name]
      const verify = entry !== undefined && entry !== true ? entry.verify : undefined
      if (!verify) continue

      const verified = await verify(credential, input.ctx)
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

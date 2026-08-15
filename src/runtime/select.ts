import type { Operation, ResponseSpec } from '../spec/types.ts'

export type StatusSource = 'prefer' | 'config' | 'default'

export interface Selection {
  spec: ResponseSpec
  source: StatusSource
}

/**
 * A `default` response carries a schema but no status of its own — in OpenAPI it
 * means "any status not otherwise declared". When it is all an operation has,
 * the mock must still choose something, and 200 is the only sensible success.
 */
const DEFAULT_STATUS = 200

/** The lowest status `new Response` accepts. Below this there is nothing to serve. */
const MIN_SERVABLE_STATUS = 200

/**
 * A range response (`4XX`) carries its bucket's lower bound in `status`, which
 * for 2XX-5XX is already the status it should go on the wire as — 400 for
 * `4XX`, and so on. So no restamping is needed, and only one case has to be
 * excluded: `1XX`, whose bound of 100 is below the 200 floor `new Response`
 * enforces. Selecting it threw a RangeError and surfaced the document's own
 * valid OpenAPI as MOCK_INTERNAL.
 */
function servable(spec: ResponseSpec): boolean {
  return !spec.range || spec.status >= MIN_SERVABLE_STATUS
}

/** Reads one `Prefer` directive, e.g. `status=201` or `example=empty-list`. */
export function preferred(request: Request, key: string): string | undefined {
  const header = request.headers.get('prefer')
  if (header === null) return undefined
  const matched = new RegExp(`${key}=([^;,\\s]+)`).exec(header)
  return matched?.[1]
}

export function selectResponse(
  operation: Operation,
  request: Request,
  staticStatus: number | undefined
): Selection | undefined {
  const wanted = preferred(request, 'status')
  if (wanted !== undefined) {
    const found = operation.responses.find(
      (response) =>
        response.status === Number.parseInt(wanted, 10) && servable(response)
    )
    // An undeclared Prefer status falls through to the normal choice rather
    // than failing: the client asked for something this operation cannot do.
    if (found) return { spec: found, source: 'prefer' }
  }

  if (staticStatus !== undefined) {
    const found = operation.responses.find(
      (response) => response.status === staticStatus && servable(response)
    )
    if (found) return { spec: found, source: 'config' }
  }

  const success = operation.responses.find(
    (response) =>
      response.status >= 200 && response.status < 300 && servable(response)
  )
  if (success) return { spec: success, source: 'default' }

  const first = operation.responses.find(servable)
  if (first) return { spec: first, source: 'default' }

  if (operation.defaultResponse) {
    return {
      spec: { ...operation.defaultResponse, status: DEFAULT_STATUS },
      source: 'default'
    }
  }

  return undefined
}

/**
 * The response an operation declares for one specific status, falling back to
 * its `default` restamped with that status. This is what on-contract error
 * construction needs: a 401 body should come from the operation's own 401
 * schema, or from its `default` schema, before any built-in envelope.
 */
export function responseForStatus(
  operation: Operation,
  status: number
): ResponseSpec | undefined {
  const declared = operation.responses.find(
    (response) => response.status === status && !response.range
  )
  if (declared) return declared
  // OpenAPI precedence: an exact status, then the range whose bucket contains
  // it, then `default`. Restamped with the REQUESTED status, not the bucket's
  // bound — a 422 served from a `4XX` contract is a 422.
  const ranged = operation.responses.find(
    (response) =>
      response.range === true &&
      status >= response.status &&
      status < response.status + 100
  )
  if (ranged) return { ...ranged, status }
  if (operation.defaultResponse) {
    return { ...operation.defaultResponse, status }
  }
  return undefined
}

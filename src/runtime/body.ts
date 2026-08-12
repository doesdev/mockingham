import type { MediaType, Operation } from '../spec/types.ts'

export interface ParsedBody {
  value: unknown
  mediaType?: string
  raw: Uint8Array
}

export type BodyResult =
  | { ok: true; body: ParsedBody }
  | { ok: false; status: number; code: string; message: string; raw: Uint8Array }

export function baseMediaType(header: string | null): string | undefined {
  if (header === null) return undefined
  const base = header.split(';')[0]
  return base === undefined ? undefined : base.trim().toLowerCase()
}

/**
 * Finds the media entry a request's content type should be validated against.
 *
 * `body.ts` parses any `+json` suffix type as JSON, so validation has to match
 * the same way — otherwise a parsed `application/vnd.api+json` body is silently
 * never validated. An exact match always wins; a `+json` type falls back to the
 * plain JSON entry.
 */
export function pickMedia(
  content: Record<string, MediaType>,
  mediaType?: string
): MediaType | undefined {
  const base = mediaType === undefined ? undefined : baseMediaType(mediaType)
  if (base !== undefined) {
    const exact = content[base]
    if (exact) return exact
    if (base.endsWith('+json')) return content['application/json']
    return undefined
  }
  return content['application/json']
}

export async function parseBody(
  request: Request,
  operation: Operation
): Promise<BodyResult> {
  const raw = new Uint8Array(await request.arrayBuffer())
  const mediaType = baseMediaType(request.headers.get('content-type'))

  if (raw.length === 0) {
    return { ok: true, body: { value: undefined, mediaType, raw } }
  }

  const declared = operation.requestBody
    ? Object.keys(operation.requestBody)
    : []
  if (
    declared.length > 0 &&
    mediaType !== undefined &&
    pickMedia(operation.requestBody ?? {}, mediaType) === undefined
  ) {
    return {
      ok: false,
      status: 415,
      code: 'MOCK_UNSUPPORTED_MEDIA_TYPE',
      message:
        `Operation ${operation.method.toUpperCase()} ${operation.path} does not ` +
        `declare "${mediaType}". Declared: ${declared.join(', ')}.`,
      raw
    }
  }

  const text = new TextDecoder().decode(raw)

  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
    try {
      return { ok: true, body: { value: JSON.parse(text), mediaType, raw } }
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'MOCK_BODY_MALFORMED',
        message: 'Request body is not valid JSON.',
        raw
      }
    }
  }

  if (mediaType === 'application/x-www-form-urlencoded') {
    const value: Record<string, string> = {}
    for (const [key, entry] of new URLSearchParams(text)) value[key] = entry
    return { ok: true, body: { value, mediaType, raw } }
  }

  if (mediaType?.startsWith('text/')) {
    return { ok: true, body: { value: text, mediaType, raw } }
  }

  // Anything else stays bytes. Validation skips it rather than guessing.
  return { ok: true, body: { value: raw, mediaType, raw } }
}

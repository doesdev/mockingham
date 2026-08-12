import type { Operation } from '../spec/types.ts'

export interface ParsedBody {
  value: unknown
  mediaType?: string
  raw: Uint8Array
}

export type BodyResult =
  | { ok: true; body: ParsedBody }
  | { ok: false; status: number; code: string; message: string }

function baseMediaType(header: string | null): string | undefined {
  if (header === null) return undefined
  const base = header.split(';')[0]
  return base === undefined ? undefined : base.trim().toLowerCase()
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
    !declared.includes(mediaType)
  ) {
    return {
      ok: false,
      status: 415,
      code: 'MOCK_UNSUPPORTED_MEDIA_TYPE',
      message:
        `Operation ${operation.method.toUpperCase()} ${operation.path} does not ` +
        `declare "${mediaType}". Declared: ${declared.join(', ')}.`
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
        message: 'Request body is not valid JSON.'
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

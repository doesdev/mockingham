import { HTTP_METHODS } from './types.ts'
import { asRecord, toContent, toParameter } from './raw.ts'
import type { CallbackSpec, HttpMethod, WebhookSpec } from './types.ts'

/**
 * 3.1's top-level `webhooks`: a map of name to path item. Each entry is ONE
 * outbound request. A path item declaring several methods is unusual; the
 * first in `HTTP_METHODS` order wins, so the choice is stable rather than
 * dependent on key order in the source document - invariant 2 forbids letting
 * an unordered iteration decide anything observable.
 */
export function toWebhooks(raw: unknown): Record<string, WebhookSpec> {
  const out: Record<string, WebhookSpec> = {}
  for (const [name, rawItem] of Object.entries(asRecord(raw))) {
    const item = asRecord(rawItem)
    for (const method of HTTP_METHODS) {
      const rawOp = item[method]
      if (rawOp === undefined) continue
      const op = asRecord(rawOp)
      const declared = Array.isArray(op['parameters'])
        ? (op['parameters'] as unknown[]).map(toParameter)
        : []
      out[name] = {
        name,
        method: method as HttpMethod,
        body: op['requestBody']
          ? toContent(asRecord(op['requestBody'])['content'])
          : undefined,
        headers: declared.filter((parameter) => parameter.location === 'header')
      }
      break
    }
  }
  return out
}

/** One operation's `callbacks`: name → runtime expression → path item. */
export function toCallbacks(raw: unknown): CallbackSpec[] {
  const out: CallbackSpec[] = []
  for (const [name, rawEntry] of Object.entries(asRecord(raw))) {
    for (const [expression, rawItem] of Object.entries(asRecord(rawEntry))) {
      const item = asRecord(rawItem)
      for (const method of HTTP_METHODS) {
        const rawOp = item[method]
        if (rawOp === undefined) continue
        out.push({
          name,
          expression,
          method: method as HttpMethod,
          body: asRecord(rawOp)['requestBody']
            ? toContent(asRecord(asRecord(rawOp)['requestBody'])['content'])
            : undefined
        })
        break
      }
    }
  }
  return out
}

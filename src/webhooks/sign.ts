/**
 * HMAC-SHA256 over `timestamp + '.' + rawBody`, per master spec §13.
 *
 * `crypto.subtle` rather than `node:crypto` - see the webhooks design §2.1.
 * Emission is reachable from `src/server/handler.ts`, and invariant 3 says the
 * handler and everything it imports must not touch Node APIs. `crypto.subtle`
 * is a web global like `Request` and `TextEncoder`, which the core already
 * depends on. It is async, which costs nothing because delivery already is.
 *
 * This exists so the client's signature-verification path - the
 * security-critical one - is exercised before production rather than after.
 */

export const SIGNATURE_HEADER = 'x-mockingham-signature'

export interface Signature {
  /** The full header value: `t=<timestamp>,v1=<hex>`. */
  header: string
  timestamp: number
  hex: string
}

const encoder = new TextEncoder()

export async function sign(
  secret: string,
  body: string,
  timestamp: number
): Promise<Signature> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`))
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return { header: `t=${timestamp},v1=${hex}`, timestamp, hex }
}

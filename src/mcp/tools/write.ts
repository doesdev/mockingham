import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'
import type { RuntimeOverride } from '../../runtime/overrides.ts'

const failNext: McpTool = {
  name: 'fail_next',
  description:
    'Make the next request(s) to a target fail, so you can exercise your error ' +
    'handling without waiting for a real outage. Target is a control-plane ' +
    'string: "POST /orders", an operationId, or "* /**" for every operation.',
  inputSchema: {
    target: z.string(),
    times: z.number().int().positive().optional().describe('Default 1'),
    status: z.number().int().optional().describe('Default 503')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.failNext(String(args.target), {
      times: args.times as number | undefined,
      status: args.status as number | undefined
    })
    return { armed: args.target, times: args.times ?? 1, status: args.status ?? 503 }
  }
}

const outage: McpTool = {
  name: 'outage',
  description:
    'Fail every request to a target for a window of time. Use this for retry ' +
    'and circuit-breaker behavior; use fail_next for a single failure.',
  inputSchema: {
    target: z.string(),
    forMs: z.number().int().positive().optional(),
    status: z.number().int().optional().describe('Default 503')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.outage(String(args.target), {
      forMs: args.forMs as number | undefined,
      status: args.status as number | undefined
    })
    return { target: args.target, forMs: args.forMs, status: args.status ?? 503 }
  }
}

const emitWebhook: McpTool = {
  name: 'emit_webhook',
  description:
    'Fire a declared webhook now, optionally at a URL you choose — so you can ' +
    'test your receiver without provoking the flow that would trigger it. ' +
    'Returns the delivery, including outcome "unresolved" when nothing ' +
    'supplied a destination.',
  inputSchema: {
    webhook: z.string(),
    to: z.string().optional().describe('Destination URL; wins over any configured one'),
    scope: z
      .string()
      .optional()
      .describe(
        'Which registration to deliver to, when destinations are registered ' +
          'per tenant or environment. Omit to address the unscoped one. See ' +
          'list_registrations for what exists. Ignored when no registry is ' +
          'configured — the emission then falls through to the captured ' +
          'callback URL or the configured one, as if no scope were given. ' +
          'list_webhooks says whether a registry exists.'
      ),
    body: z.unknown().optional().describe('Layered over the generated payload')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    // Returned as-is. Invariant 6: an unresolved emit is a captured outcome,
    // never an error, and must not be converted into one here.
    return ctx.emit(String(args.webhook), {
      to: args.to as string | undefined,
      scope: args.scope as string | undefined,
      body: args.body as never
    })
  }
}

const setSeed: McpTool = {
  name: 'set_seed',
  description:
    'Reshuffle every generated value. The mock stays deterministic — the same ' +
    'seed always produces the same content.',
  inputSchema: { seed: z.string() },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.setSeed(String(args.seed))
    return { seed: args.seed }
  }
}

const reset: McpTool = {
  name: 'reset',
  description:
    'Restore the configured baseline: clears armed failures, idempotency keys, ' +
    'counters, and captured deliveries. Never touches your config file.',
  inputSchema: {},
  async handler(ctx: McpContext) {
    await ctx.reset()
    return { reset: true }
  }
}

const setOverride: McpTool = {
  name: 'set_override',
  description:
    'Pin what an operation returns, without editing config. The override ' +
    'layers over any configured one, so a partial body refines rather than ' +
    'replaces it. Target is a control-plane string: "POST /orders", an ' +
    'operationId, or "* /**" for every operation. JSON data only. An ' +
    'object-shaped body against an operation that returns an array is a ' +
    'silent no-op — use { "*": { ... } } to reach every element, or a ' +
    'literal JSON array.',
  inputSchema: {
    target: z.string(),
    value: z
      .record(z.string(), z.unknown())
      .describe('{ status?, [status]: { body?, headers? } }')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.override(String(args.target), args.value as RuntimeOverride)
    return { target: args.target, value: args.value }
  }
}

const clearOverrides: McpTool = {
  name: 'clear_overrides',
  description:
    'Remove runtime overrides. With no target, clears them for every ' +
    'operation. Never touches the overrides in your config file.',
  inputSchema: {
    target: z.string().optional().describe('Omit to clear every operation')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    const target = args.target === undefined ? undefined : String(args.target)
    await ctx.clearOverrides(target)
    // `null` rather than a placeholder like '*' for the no-target case: '*'
    // alone is not a valid target (resolveTarget reads a spaceless target as
    // an operationId, so it throws), and echoing it back would teach a caller
    // a string that fails on its next call.
    return { cleared: target ?? null }
  }
}

const setVariant: McpTool = {
  name: 'set_variant',
  description:
    'Pin which branch of a union (oneOf/anyOf) an operation generates, so a ' +
    'response that could come back several shapes comes back the one you want ' +
    'to exercise. The name is matched against each branch discriminator, or ' +
    'against any const-valued property when the schema declares no ' +
    'discriminator; a name matching no branch falls through to the seeded ' +
    'pick rather than failing. A "Prefer: variant=" header on a request ' +
    'outranks this stored preference. Target is a control-plane string: ' +
    '"POST /orders", an operationId, or "* /**" for every operation.',
  inputSchema: {
    target: z.string(),
    name: z.string().describe('The branch name, e.g. "conflict"')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.setVariant(String(args.target), String(args.name))
    return { target: args.target, variant: args.name }
  }
}

const clearVariants: McpTool = {
  name: 'clear_variants',
  description:
    'Remove variant preferences set by set_variant, returning those operations ' +
    'to the seeded branch pick. With no target, clears them for every ' +
    'operation. Does not affect a "Prefer: variant=" header, which is a ' +
    'statement about a single request.',
  inputSchema: {
    target: z.string().optional().describe('Omit to clear every operation')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    const target = args.target === undefined ? undefined : String(args.target)
    await ctx.clearVariants(target)
    // `null` rather than '*', for the reason spelled out on clear_overrides:
    // '*' alone is not a valid target and echoing it teaches a caller a string
    // that throws on its next call.
    return { cleared: target ?? null }
  }
}

const redeliverWebhook: McpTool = {
  name: 'redeliver_webhook',
  description:
    'Send a delivery that already happened a second time, byte for byte — same ' +
    'payload, same signature header, same destination, same delivery id — so ' +
    'you can check your receiver deduplicates a repeat rather than processing ' +
    'it twice. Nothing is regenerated and no destination is re-resolved. Take ' +
    'the id from emit_webhook or list_deliveries. An id that is not in the ' +
    'delivery log, because it never existed or has aged out of the bounded ' +
    'log, is an error.',
  inputSchema: {
    id: z.string().describe('A delivery id from emit_webhook or list_deliveries')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    // Returned as-is, exactly as emit_webhook is. Invariant 6: a delivery that
    // FAILS is a recorded outcome and must not become an error here. Only an
    // unknown or aged-out id throws, and that is a caller error rather than a
    // delivery outcome.
    return ctx.redeliver(String(args.id))
  }
}

const registerWebhookDestination: McpTool = {
  name: 'register_webhook_destination',
  description:
    'Point a declared webhook at a URL of yours, the way a subscription ' +
    'operation on the API would — so emissions reach your receiver without ' +
    'you first driving whatever flow registers a subscriber. Outranks a ' +
    'captured callback URL and the configured one, and is beaten only by an ' +
    'explicit "to" on emit_webhook. Give a scope to register per tenant (or ' +
    'per whatever the webhook is scoped by); omit it for the unscoped ' +
    'destination, which is the one an emission with no scope looks up. ' +
    'Registering the same webhook and scope again replaces the URL.',
  inputSchema: {
    webhook: z.string().describe('A webhook name declared in the document'),
    url: z.string(),
    scope: z.string().optional().describe('Omit for the unscoped registration')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    const scope = args.scope === undefined ? undefined : String(args.scope)
    await ctx.register(String(args.webhook), String(args.url), scope)
    return { webhook: args.webhook, url: args.url, scope: scope ?? '' }
  }
}

const unregisterWebhookDestination: McpTool = {
  name: 'unregister_webhook_destination',
  description:
    'Remove a destination registered for a webhook, so you can watch what ' +
    'happens once a subscriber goes away — an emission with nothing left to ' +
    'resolve is captured with outcome "unresolved", never an error. Removes ' +
    'one scope: pass the same scope you registered under, or omit it to ' +
    'remove the unscoped registration. Other scopes are left alone. Removing ' +
    'a registration that is not there is not an error.',
  inputSchema: {
    webhook: z.string(),
    scope: z.string().optional().describe('Omit for the unscoped registration')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    const scope = args.scope === undefined ? undefined : String(args.scope)
    await ctx.unregister(String(args.webhook), scope)
    return { webhook: args.webhook, scope: scope ?? '' }
  }
}

export const WRITE_TOOLS: McpTool[] = [
  failNext,
  outage,
  emitWebhook,
  setSeed,
  reset,
  setOverride,
  clearOverrides,
  setVariant,
  clearVariants,
  redeliverWebhook,
  registerWebhookDestination,
  unregisterWebhookDestination
]

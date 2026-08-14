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
    body: z.unknown().optional().describe('Layered over the generated payload')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    // Returned as-is. Invariant 6: an unresolved emit is a captured outcome,
    // never an error, and must not be converted into one here.
    return ctx.emit(String(args.webhook), {
      to: args.to as string | undefined,
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
    'operationId, or "* /**" for every operation. JSON data only.',
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
    await ctx.clearOverrides(args.target === undefined ? undefined : String(args.target))
    return { cleared: args.target ?? '*' }
  }
}

export const WRITE_TOOLS: McpTool[] = [
  failNext,
  outage,
  emitWebhook,
  setSeed,
  reset,
  setOverride,
  clearOverrides
]

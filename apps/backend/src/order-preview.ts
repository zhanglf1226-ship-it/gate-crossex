import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { CreateOrderInputSchema } from './trading-runtime.js';

export interface OrderPreview {
  previewId: string;
  createdAt: string;
  expiresAt: string;
  mode: 'preview_only';
  executionAllowed: false;
  requestHash: string;
  canonicalOrder: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET';
    timeInForce: 'GTC' | 'IOC' | 'FOK' | 'POC';
    quantity: string;
    price: string | null;
    reduceOnly: boolean;
    positionSide: 'NONE' | 'LONG' | 'SHORT';
  };
  estimated: {
    notional: string | null;
  };
  riskChecks: Array<{ rule: string; result: 'allow' | 'deny'; reason: string }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildOrderPreview(raw: unknown, now: Date = new Date()): OrderPreview {
  const input = CreateOrderInputSchema.parse(raw);
  const canonicalOrder: OrderPreview['canonicalOrder'] = {
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    timeInForce: input.timeInForce,
    quantity: new Decimal(input.quantity).toFixed(),
    price: input.price ? new Decimal(input.price).toFixed() : null,
    reduceOnly: input.reduceOnly,
    positionSide: input.positionSide,
  };
  const requestHash = `sha256:${createHash('sha256').update(canonicalJson(canonicalOrder)).digest('hex')}`;
  const notional = canonicalOrder.price
    ? new Decimal(canonicalOrder.quantity).mul(canonicalOrder.price).toFixed()
    : null;
  return {
    previewId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    mode: 'preview_only',
    executionAllowed: false,
    requestHash,
    canonicalOrder,
    estimated: { notional },
    riskChecks: [
      {
        rule: 'live_execution_disabled',
        result: 'deny',
        reason: 'Cloud platform phase 1 is preview-only and cannot submit orders.',
      },
    ],
  };
}

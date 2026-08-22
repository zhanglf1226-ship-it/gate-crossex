import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const ContractName = 'gate-crossex-target-state';
const VenueSchema = z.enum(['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT']);
const DecimalSchema = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d+(?:\.\d+)?$/)]);
const RawSymbolSchema = z.string().trim().toUpperCase().refine((value) =>
  /^[A-Z0-9]{2,30}$/.test(value)
  || /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/.test(value),
  'unsupported target-state symbol format',
);

const RouteSchema = z.object({
  mode: z.enum(['AUTO', 'FIXED']).default('AUTO'),
  allowed_exchanges: z.array(VenueSchema).min(1).max(7).default(['GATE', 'BINANCE', 'OKX', 'BYBIT']),
  max_slippage_bps: z.number().finite().nonnegative().max(10_000).default(25),
  min_depth_notional: z.number().finite().nonnegative().default(500),
  max_venue_count: z.number().int().min(1).max(7).default(2),
  split_allowed: z.boolean().default(true),
  prefer_exchange: VenueSchema.optional(),
}).default({
  mode: 'AUTO',
  allowed_exchanges: ['GATE', 'BINANCE', 'OKX', 'BYBIT'],
  max_slippage_bps: 25,
  min_depth_notional: 500,
  max_venue_count: 2,
  split_allowed: true,
});

const TargetPositionSchema = z.object({
  symbol: RawSymbolSchema,
  target_side: z.enum(['BUY', 'SELL']),
  target_quote_qty: DecimalSchema,
  strategy_tag: z.string().trim().max(100).default(''),
  valid_until_ms: z.number().int().positive().optional(),
  risk: z.record(z.string(), z.unknown()).default({}),
  route: RouteSchema,
});

export const TargetStateSchema = z.object({
  meta: z.object({
    contract: z.literal(ContractName),
    contract_version: z.literal(1),
    strategy_tag: z.string().trim().max(100).optional(),
  }).passthrough(),
  positions: z.array(TargetPositionSchema).max(100),
});

export interface TargetStatePreview {
  previewId: string;
  createdAt: string;
  expiresAt: string;
  contract: typeof ContractName;
  contractVersion: 1;
  mode: 'preview_only';
  executionAllowed: false;
  requestHash: string;
  targets: Array<{
    symbol: string;
    targetSide: 'BUY' | 'SELL';
    targetQuoteQuantity: string;
    flatten: boolean;
    routeMode: 'AUTO' | 'FIXED';
    routeCandidates: string[];
    maxSlippageBps: number;
    minDepthNotional: number;
    maxVenueCount: number;
    splitAllowed: boolean;
    preferredVenue: string | null;
    strategyTag: string;
    risk: Record<string, unknown>;
  }>;
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

function targetSymbol(symbol: string, venue: string): string {
  if (/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_/.test(symbol)) return symbol;
  const quote = ['USDT', 'USDC', 'USD'].find((item) => symbol.endsWith(item));
  if (!quote) throw new Error(`unsupported target-state symbol: ${symbol}`);
  const base = symbol.slice(0, -quote.length);
  if (!base) throw new Error(`unsupported target-state symbol: ${symbol}`);
  return `${venue}_FUTURE_${base}_${quote}`;
}

export function buildTargetStatePreview(raw: unknown, now: Date = new Date()): TargetStatePreview {
  const state = TargetStateSchema.parse(raw);
  const targets = state.positions.map((position) => {
    const targetQuoteQuantity = String(position.target_quote_qty);
    const allowed = position.route.allowed_exchanges;
    return {
      symbol: position.symbol,
      targetSide: position.target_side,
      targetQuoteQuantity,
      flatten: Number(targetQuoteQuantity) === 0,
      routeMode: position.route.mode,
      routeCandidates: allowed.map((venue) => targetSymbol(position.symbol, venue)),
      maxSlippageBps: position.route.max_slippage_bps,
      minDepthNotional: position.route.min_depth_notional,
      maxVenueCount: position.route.max_venue_count,
      splitAllowed: position.route.split_allowed,
      preferredVenue: position.route.prefer_exchange ?? null,
      strategyTag: position.strategy_tag || state.meta.strategy_tag || '',
      risk: position.risk,
    };
  });
  const requestHash = `sha256:${createHash('sha256').update(canonicalJson({ meta: state.meta, targets })).digest('hex')}`;
  return {
    previewId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    contract: ContractName,
    contractVersion: 1,
    mode: 'preview_only',
    executionAllowed: false,
    requestHash,
    targets,
    riskChecks: [{
      rule: 'live_execution_disabled',
      result: 'deny',
      reason: 'Target-state preview can produce route plans but cannot submit orders.',
    }],
  };
}

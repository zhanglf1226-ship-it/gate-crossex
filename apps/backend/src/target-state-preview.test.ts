import { describe, expect, it } from 'vitest';
import { buildTargetStatePreview } from './target-state-preview.js';

const state = {
  meta: {
    contract: 'gate-crossex-target-state',
    contract_version: 1,
    strategy_tag: 'mainline',
  },
  positions: [{
    symbol: 'BTCUSDT',
    target_side: 'BUY',
    target_quote_qty: 100,
    route: {
      mode: 'AUTO',
      allowed_exchanges: ['GATE', 'BINANCE'],
      max_slippage_bps: 20,
      min_depth_notional: 1000,
      max_venue_count: 2,
      split_allowed: true,
      prefer_exchange: 'GATE',
    },
    risk: { stop_price: 60000 },
  }],
} as const;

describe('buildTargetStatePreview', () => {
  it('turns a versioned target state into a non-executable route preview', () => {
    const preview = buildTargetStatePreview(state, new Date('2026-08-21T05:00:00.000Z'));
    expect(preview.executionAllowed).toBe(false);
    expect(preview.contractVersion).toBe(1);
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]?.routeCandidates).toEqual([
      'GATE_FUTURE_BTC_USDT',
      'BINANCE_FUTURE_BTC_USDT',
    ]);
    expect(preview.targets[0]?.preferredVenue).toBe('GATE');
  });

  it('represents target zero as an explicit flatten plan', () => {
    const preview = buildTargetStatePreview({
      ...state,
      positions: [{ ...state.positions[0], target_quote_qty: 0 }],
    });
    expect(preview.targets[0]?.flatten).toBe(true);
  });

  it('rejects unknown contract versions', () => {
    expect(() => buildTargetStatePreview({
      ...state,
      meta: { ...state.meta, contract_version: 2 },
    })).toThrow();
  });
});

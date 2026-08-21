import { describe, expect, it } from 'vitest';
import { buildOrderPreview } from './order-preview.js';

const order = {
  symbol: 'BINANCE_FUTURE_BTC_USDT',
  side: 'BUY',
  type: 'LIMIT',
  timeInForce: 'GTC',
  quantity: '0.01',
  price: '64000',
  reduceOnly: false,
  positionSide: 'LONG',
} as const;

describe('buildOrderPreview', () => {
  it('returns a deterministic request hash and never allows execution', () => {
    const now = new Date('2026-08-21T03:00:00.000Z');
    const first = buildOrderPreview(order, now);
    const second = buildOrderPreview({ ...order }, now);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.executionAllowed).toBe(false);
    expect(first.mode).toBe('preview_only');
    expect(first.estimated.notional).toBe('640');
    expect(first.riskChecks).toContainEqual(expect.objectContaining({ rule: 'live_execution_disabled', result: 'deny' }));
  });

  it('changes the hash when a material order field changes', () => {
    const base = buildOrderPreview(order);
    const changed = buildOrderPreview({ ...order, quantity: '0.02' });
    expect(base.requestHash).not.toBe(changed.requestHash);
  });

  it('rejects limit orders without price', () => {
    expect(() => buildOrderPreview({ ...order, price: undefined })).toThrow();
  });
});

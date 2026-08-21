import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { ExecutionRiskGuard } from './execution-risk.js';

const directories: string[] = [];
const order = {
  symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
  quantity: '0.01', price: '64000', reduceOnly: false, positionSide: 'LONG',
} as const;
function guard() {
  const directory = mkdtempSync(join(tmpdir(), 'gct-risk-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
  return { database, risk: new ExecutionRiskGuard(database) };
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ExecutionRiskGuard', () => {
  it('defaults fail-closed with kill switch and close-only enabled', () => {
    const { database, risk } = guard();
    expect(risk.read()).toMatchObject({ killSwitch: true, closeOnly: true, allowedSymbols: [] });
    expect(() => risk.assertOrderAllowed(order, 'gate-main')).toThrow('execution_kill_switch_active');
    database.close();
  });

  it('enforces close-only, symbol, quantity and notional limits', () => {
    const { database, risk } = guard();
    risk.update({ killSwitch: false, closeOnly: true, maxOrderNotional: '1000', maxOrderQuantity: '1',
      maxDailyNotional: '5000', allowedSymbols: [order.symbol] }, 'admin');
    expect(() => risk.assertOrderAllowed(order, 'gate-main')).toThrow('execution_close_only');
    risk.update({ killSwitch: false, closeOnly: false, maxOrderNotional: '500', maxOrderQuantity: '0.005',
      maxDailyNotional: '5000', allowedSymbols: [order.symbol] }, 'admin');
    expect(() => risk.assertOrderAllowed(order, 'gate-main')).toThrow('order_quantity_limit_exceeded');
    expect(() => risk.assertOrderAllowed({ ...order, quantity: '0.005' }, 'gate-main')).not.toThrow();
    expect(() => risk.assertOrderAllowed({ ...order, symbol: 'OKX_FUTURE_BTC_USDT' }, 'gate-main')).toThrow('symbol_not_allowed');
    database.close();
  });

  it('prices only risk-reducing market orders from a conservative position mark', () => {
    const { database, risk } = guard();
    expect(() => risk.priceOrder({ ...order, type: 'MARKET', price: null })).toThrow('market_order_notional_unavailable');
    database.prepare(`INSERT INTO live_positions
      (position_id, symbol, venue, quantity, entry_price, mark_price, realized_pnl, updated_at)
      VALUES ('position-1', ?, 'BINANCE', '0.1', '60000', '64000', '0', '2026-08-21T08:00:00.000Z')`)
      .run(order.symbol);
    expect(risk.priceOrder({ ...order, type: 'MARKET', price: null, reduceOnly: true })).toMatchObject({ price: '65920' });
    database.close();
  });

  it('counts consumed previews against the UTC daily notional limit', () => {
    const { database, risk } = guard();
    risk.update({ killSwitch: false, closeOnly: false, maxOrderNotional: '1000', maxOrderQuantity: '1',
      maxDailyNotional: '1000', allowedSymbols: [order.symbol] }, 'admin');
    database.prepare(`INSERT INTO order_previews
      (id, request_hash, signature, canonical_order_json, created_at, expires_at, status, updated_at, account_id)
      VALUES ('used', 'hash', 'sig', ?, ?, ?, 'PENDING', ?, 'gate-main')`)
      .run(JSON.stringify({ ...order, quantity: '0.01' }), '2026-08-21T01:00:00.000Z',
        '2026-08-21T01:00:30.000Z', '2026-08-21T01:00:00.000Z');
    risk.reserveDailyNotional('preview:used', 'preview', order, 'gate-main', new Date('2026-08-21T08:00:00.000Z'));
    database.prepare(`INSERT INTO order_previews
      (id, request_hash, signature, canonical_order_json, created_at, expires_at, status, updated_at, account_id)
      VALUES ('next', 'hash2', 'sig2', ?, ?, ?, 'PENDING', ?, 'gate-main')`)
      .run(JSON.stringify(order), '2026-08-21T02:00:00.000Z', '2026-08-21T02:00:30.000Z',
        '2026-08-21T02:00:00.000Z');
    expect(() => risk.reserveDailyNotional('preview:next', 'preview', order, 'gate-main', new Date('2026-08-21T08:00:00.000Z')))
      .toThrow('daily_notional_limit_exceeded');
    expect(() => risk.reserveDailyNotional('preview:next', 'preview', order, 'gate-main', new Date('2026-08-22T08:00:00.000Z')))
      .not.toThrow();
    database.close();
  });
});

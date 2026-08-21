import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { OrderPreview } from './order-preview.js';

const positiveDecimal = z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => new Decimal(value).gt(0));
export const ExecutionRiskPolicySchema = z.object({
  killSwitch: z.boolean(),
  closeOnly: z.boolean(),
  maxOrderNotional: positiveDecimal,
  maxOrderQuantity: positiveDecimal,
  maxDailyNotional: positiveDecimal,
  allowedSymbols: z.array(z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/)).max(500),
});
export type ExecutionRiskPolicy = z.infer<typeof ExecutionRiskPolicySchema>;

interface RiskRow {
  kill_switch: number;
  close_only: number;
  max_order_notional: string;
  max_order_quantity: string;
  max_daily_notional: string;
  allowed_symbols_json: string;
}

export class ExecutionRiskError extends Error {
  constructor(readonly code: string, readonly statusCode = 403) {
    super(code);
    this.name = 'ExecutionRiskError';
  }
}

export class ExecutionRiskGuard {
  constructor(private readonly database: Database.Database) {}

  read(): ExecutionRiskPolicy {
    const row = this.database.prepare('SELECT * FROM execution_risk_guard WHERE id = 1').get() as RiskRow;
    return ExecutionRiskPolicySchema.parse({
      killSwitch: row.kill_switch === 1,
      closeOnly: row.close_only === 1,
      maxOrderNotional: row.max_order_notional,
      maxOrderQuantity: row.max_order_quantity,
      maxDailyNotional: row.max_daily_notional,
      allowedSymbols: JSON.parse(row.allowed_symbols_json),
    });
  }

  update(raw: unknown, actorUserId: string, now: Date = new Date()): ExecutionRiskPolicy {
    const policy = ExecutionRiskPolicySchema.parse(raw);
    this.database.prepare(`UPDATE execution_risk_guard SET kill_switch = ?, close_only = ?,
      max_order_notional = ?, max_order_quantity = ?, max_daily_notional = ?,
      allowed_symbols_json = ?, updated_by = ?, updated_at = ? WHERE id = 1`)
      .run(policy.killSwitch ? 1 : 0, policy.closeOnly ? 1 : 0, policy.maxOrderNotional,
        policy.maxOrderQuantity, policy.maxDailyNotional, JSON.stringify(policy.allowedSymbols),
        actorUserId, now.toISOString());
    return policy;
  }

  priceOrder(order: OrderPreview['canonicalOrder'], allowRiskReducingMarket = false): OrderPreview['canonicalOrder'] {
    if (order.price) return order;
    if (!order.reduceOnly && !allowRiskReducingMarket) throw new ExecutionRiskError('market_order_notional_unavailable');
    const position = this.database.prepare(`SELECT mark_price, updated_at FROM live_positions
      WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1`).get(order.symbol) as { mark_price: string; updated_at: string } | undefined;
    if (!position || new Decimal(position.mark_price).lte(0)) {
      throw new ExecutionRiskError('market_order_notional_unavailable');
    }
    return { ...order, price: new Decimal(position.mark_price).mul('1.03').toFixed() };
  }

  assertOrderAllowed(order: OrderPreview['canonicalOrder'], accountId: string): void {
    const policy = this.read();
    if (policy.killSwitch) throw new ExecutionRiskError('execution_kill_switch_active');
    if (policy.closeOnly && !order.reduceOnly) throw new ExecutionRiskError('execution_close_only');
    if (!policy.allowedSymbols.includes(order.symbol)) throw new ExecutionRiskError('symbol_not_allowed');
    if (new Decimal(order.quantity).gt(policy.maxOrderQuantity)) throw new ExecutionRiskError('order_quantity_limit_exceeded');
    if (!order.price) throw new ExecutionRiskError('market_order_notional_unavailable');
    const notional = new Decimal(order.quantity).mul(order.price);
    if (notional.gt(policy.maxOrderNotional)) throw new ExecutionRiskError('order_notional_limit_exceeded');
  }

  reserveDailyNotional(
    reservationId: string,
    sourceType: 'preview' | 'order',
    order: OrderPreview['canonicalOrder'],
    accountId: string,
    now: Date = new Date(),
  ): void {
    if (!order.price) throw new ExecutionRiskError('market_order_notional_unavailable');
    const notional = new Decimal(order.quantity).mul(order.price);
    const utcDay = now.toISOString().slice(0, 10);
    this.database.transaction(() => {
      const existing = this.database.prepare('SELECT reservation_id FROM execution_risk_reservations WHERE reservation_id = ?')
        .get(reservationId) as { reservation_id: string } | undefined;
      if (existing) return;
      const policy = this.read();
      const rows = this.database.prepare(`SELECT notional FROM execution_risk_reservations
        WHERE account_id = ? AND utc_day = ?`).all(accountId, utcDay) as Array<{ notional: string }>;
      const reserved = rows.reduce((total, row) => total.add(row.notional), new Decimal(0));
      if (reserved.add(notional).gt(policy.maxDailyNotional)) {
        throw new ExecutionRiskError('daily_notional_limit_exceeded');
      }
      this.database.prepare(`INSERT INTO execution_risk_reservations
        (reservation_id, source_type, account_id, notional, utc_day, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(reservationId, sourceType, accountId, notional.toFixed(), utcDay, now.toISOString());
    })();
  }
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { OrderConfirmationError, OrderConfirmationStore } from './order-confirmation.js';
import type { ExecutionOrder, TradingRuntime } from './trading-runtime.js';

const directories: string[] = [];
const rawOrder = {
  symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
  quantity: '0.01', price: '64000', reduceOnly: false, positionSide: 'LONG',
} as const;

function testStore() {
  const directory = mkdtempSync(join(tmpdir(), 'gct-confirmation-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
  return { database, store: new OrderConfirmationStore(database, Buffer.alloc(32, 7)) };
}

function order(id = 'execution-1'): ExecutionOrder {
  return {
    id, remoteOrderId: 'remote-1', clientOrderId: 'client-1', symbol: rawOrder.symbol,
    venue: 'BINANCE', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.01',
    price: '64000', reduceOnly: false, state: 'NEW', executedQuantity: '0',
    executedAveragePrice: null, failureReason: null, strategyId: null, strategyLeg: null,
    strategyClip: null, createdAt: '2026-08-21T07:00:00.000Z', updatedAt: '2026-08-21T07:00:00.000Z',
  };
}

function runtimeStub(database: Database.Database, result: ExecutionOrder): TradingRuntime {
  const createOrder = vi.fn(async () => {
    database.prepare(`INSERT INTO execution_orders
      (id, remote_order_id, client_order_id, environment, symbol, venue, side, order_type,
       time_in_force, quantity, price, reduce_only, state, executed_quantity, created_at, updated_at)
      VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(result.id, result.remoteOrderId, result.clientOrderId, result.symbol, result.venue,
        result.side, result.type, result.timeInForce, result.quantity, result.price,
        result.reduceOnly ? 1 : 0, result.state, result.executedQuantity, result.createdAt, result.updatedAt);
    return result;
  });
  return {
    createOrder,
    getOrder: vi.fn(() => result),
  } as unknown as TradingRuntime;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('OrderConfirmationStore', () => {
  it('persists a preview and returns the same result for an idempotent retry', async () => {
    const { database, store } = testStore();
    const preview = store.create(rawOrder, new Date('2026-08-21T07:00:00.000Z'));
    const result = order();
    const runtime = runtimeStub(database, result);

    const first = await store.confirm(preview.previewId, 'order-confirmation-0001', runtime, new Date('2026-08-21T07:00:10.000Z'));
    const second = await store.confirm(preview.previewId, 'order-confirmation-0001', runtime, new Date('2026-08-21T07:00:11.000Z'));

    expect(first).toEqual(result);
    expect(second).toEqual(result);
    expect(runtime.createOrder).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT status, execution_order_id FROM order_previews WHERE id = ?').get(preview.previewId))
      .toEqual({ status: 'SUCCEEDED', execution_order_id: result.id });
    database.close();
  });

  it('rejects expired previews without calling the runtime', async () => {
    const { database, store } = testStore();
    const preview = store.create(rawOrder, new Date('2026-08-21T07:00:00.000Z'));
    const runtime = { createOrder: vi.fn() } as unknown as TradingRuntime;

    await expect(store.confirm(preview.previewId, 'order-confirmation-0002', runtime, new Date('2026-08-21T07:00:31.000Z')))
      .rejects.toMatchObject({ code: 'order_preview_expired', statusCode: 410 } satisfies Partial<OrderConfirmationError>);
    expect(runtime.createOrder).not.toHaveBeenCalled();
    database.close();
  });

  it('detects a modified canonical order before execution', async () => {
    const { database, store } = testStore();
    const preview = store.create(rawOrder, new Date('2026-08-21T07:00:00.000Z'));
    database.prepare('UPDATE order_previews SET canonical_order_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...preview.canonicalOrder, quantity: '5' }), preview.previewId);
    const runtime = { createOrder: vi.fn() } as unknown as TradingRuntime;

    await expect(store.confirm(preview.previewId, 'order-confirmation-0003', runtime, new Date('2026-08-21T07:00:10.000Z')))
      .rejects.toMatchObject({ code: 'order_preview_tampered', statusCode: 409 } satisfies Partial<OrderConfirmationError>);
    expect(runtime.createOrder).not.toHaveBeenCalled();
    database.close();
  });

  it('recovers a processing confirmation from its reserved local order', async () => {
    const { database, store } = testStore();
    const preview = store.create(rawOrder, new Date('2026-08-21T07:00:00.000Z'));
    const result = order();
    const runtime = runtimeStub(database, result);
    await runtime.createOrder(rawOrder, undefined, { orderId: result.id, clientOrderId: result.clientOrderId });
    database.prepare(`UPDATE order_previews SET status = 'PROCESSING', idempotency_key = ?,
      planned_order_id = ?, planned_client_order_id = ?, consumed_at = ? WHERE id = ?`)
      .run('order-confirmation-0005', result.id, result.clientOrderId,
        '2026-08-21T07:00:10.000Z', preview.previewId);

    const recovered = await store.confirm(preview.previewId, 'order-confirmation-0005', runtime,
      new Date('2026-08-21T07:00:11.000Z'));

    expect(recovered).toEqual(result);
    expect(database.prepare('SELECT status, execution_order_id FROM order_previews WHERE id = ?').get(preview.previewId))
      .toEqual({ status: 'SUCCEEDED', execution_order_id: result.id });
    database.close();
  });

  it('binds previews to an account and prohibits self-approval', async () => {
    const { database, store } = testStore();
    const preview = store.create(rawOrder, new Date('2026-08-21T07:00:00.000Z'), {
      accountId: 'gate-main', creatorUserId: 'planner-user',
    });
    const runtime = { createOrder: vi.fn() } as unknown as TradingRuntime;

    await expect(store.confirm(preview.previewId, 'order-confirmation-0006', runtime,
      new Date('2026-08-21T07:00:10.000Z'), {
        accountId: 'gate-other', approverUserId: 'approver-user', enforceSeparation: true,
      })).rejects.toMatchObject({ code: 'order_preview_account_mismatch', statusCode: 403 });
    await expect(store.confirm(preview.previewId, 'order-confirmation-0007', runtime,
      new Date('2026-08-21T07:00:10.000Z'), {
        accountId: 'gate-main', approverUserId: 'planner-user', enforceSeparation: true,
      })).rejects.toMatchObject({ code: 'maker_checker_separation_required', statusCode: 403 });
    expect(runtime.createOrder).not.toHaveBeenCalled();
    database.close();
  });

  it('rejects reuse of an idempotency key for another preview', async () => {
    const { database, store } = testStore();
    const first = store.create(rawOrder, new Date('2026-08-21T07:00:00.000Z'));
    const second = store.create({ ...rawOrder, quantity: '0.02' }, new Date('2026-08-21T07:00:01.000Z'));
    const result = order();
    const runtime = runtimeStub(database, result);

    await store.confirm(first.previewId, 'order-confirmation-0004', runtime, new Date('2026-08-21T07:00:10.000Z'));
    await expect(store.confirm(second.previewId, 'order-confirmation-0004', runtime, new Date('2026-08-21T07:00:11.000Z')))
      .rejects.toMatchObject({ code: 'idempotency_key_conflict', statusCode: 409 } satisfies Partial<OrderConfirmationError>);
    database.close();
  });
});

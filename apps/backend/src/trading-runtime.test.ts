import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { TradingSession } from './trading-session.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault, type GateCredentials } from './credential-vault.js';
import {
  GateApiError,
  type CrossExOrderRequest,
  type GateCrossExAccount,
  type GateCrossExOrder,
  type GateCrossExPortfolio,
  type GateCrossExRiskLimit,
  type GateCrossExSymbol,
  type GateFeeRate,
  type GateOrderActionResponse,
  type TradingCrossExGateway,
} from './crossex-client.js';
import { CreateStrategyInputSchema, TradingRuntime, isTerminalOrderState, type TradingRuntimeOptions } from './trading-runtime.js';

function remoteOrder(overrides: Partial<GateCrossExOrder> & { order_id: string; state: string }): GateCrossExOrder {
  return {
    text: 'gct-unset', symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET',
    attribute: 'NORMAL', exchange_type: 'BINANCE', business_type: 'FUTURE', qty: '0.1', quote_qty: '0',
    price: '0', time_in_force: 'IOC', executed_qty: '0.1', executed_amount: '10000', executed_avg_price: '100000',
    fee_coin: 'USDT', fee: '0.5', reduce_only: 'false', leverage: '5', reason: '', last_executed_qty: '0.1',
    last_executed_price: '100000', last_executed_amount: '10000', position_side: 'NONE',
    create_time: '1783600000000', update_time: '1783600001000',
    ...overrides,
  };
}

interface GatewayScript {
  /** Runs while the exchange "processes" the submission, before the REST response returns. */
  duringCreate?: (order: CrossExOrderRequest, remoteId: string) => void;
  createError?: () => Error;
  queryOrder?: (orderId: string) => GateCrossExOrder;
}

class ScriptedGateway implements TradingCrossExGateway {
  readonly createRequests: CrossExOrderRequest[] = [];
  readonly queriedOrderIds: string[] = [];
  private sequence = 0;

  constructor(private readonly script: GatewayScript = {}) {}

  async queryAccount(): Promise<GateCrossExAccount> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async queryPositions(): Promise<GateCrossExPortfolio['positions']> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async queryPortfolio(): Promise<GateCrossExPortfolio> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async querySymbols(): Promise<GateCrossExSymbol[]> { return []; }
  async queryRiskLimits(): Promise<GateCrossExRiskLimit[]> { return []; }
  async queryLeverages(): Promise<Record<string, string>> { return {}; }
  async setLeverage(_credentials: GateCredentials, symbol: string, leverage: string): Promise<{ symbol: string; leverage: string }> { return { symbol, leverage }; }
  async queryFeeRates(): Promise<GateFeeRate[]> { return []; }

  async createOrder(_credentials: GateCredentials, order: CrossExOrderRequest): Promise<GateOrderActionResponse> {
    this.createRequests.push({ ...order });
    this.sequence += 1;
    const remoteId = `remote-${this.sequence}`;
    this.script.duringCreate?.(order, remoteId);
    if (this.script.createError) throw this.script.createError();
    return { order_id: remoteId, text: order.text ?? '' };
  }

  async cancelOrder(_credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    return { order_id: orderId, text: '' };
  }

  async queryOrder(_credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    this.queriedOrderIds.push(orderId);
    if (!this.script.queryOrder) throw new GateApiError(0, 'ORDER_QUERY_UNSCRIPTED');
    return this.script.queryOrder(orderId);
  }
}

interface Harness {
  database: Database.Database;
  runtime: TradingRuntime;
  gateway: ScriptedGateway;
  directory: string;
}

const harnesses: Harness[] = [];

async function createHarness(script: GatewayScript = {}, options: TradingRuntimeOptions & { liveTradingEnabled?: boolean } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-runtime-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  if (options.liveTradingEnabled !== false) session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'runtime-key', apiSecret: 'runtime-secret' });
  const gateway = new ScriptedGateway(script);
  const runtime = new TradingRuntime(database, session, vault, gateway, {
    submitResolvePollMs: options.submitResolvePollMs ?? 10,
    submitResolveMaxAttempts: options.submitResolveMaxAttempts ?? 50,
    beforeCreateOrder: options.beforeCreateOrder,
  });
  const harness = { database, runtime, gateway, directory };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const marketOrderInput = {
  symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', timeInForce: 'IOC', quantity: '0.1',
} as const;

const pairedStrategyInput = {
  kind: 'position', asset: 'HYPE', leftVenue: 'HYPERLIQUID', rightVenue: 'BYBIT',
  leftSide: 'SELL', rightSide: 'BUY', entryBps: '-5', totalAmount: '100',
  perOrderQuantity: '10', reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;

describe('strategy input validation', () => {
  it('allows a negative opening-cost threshold for paired funding arbitrage', () => {
    expect(CreateStrategyInputSchema.parse(pairedStrategyInput).entryBps).toBe('-5');
  });

  it('keeps the continuous price-difference bot threshold positive', () => {
    const result = CreateStrategyInputSchema.safeParse({
      ...pairedStrategyInput,
      kind: 'auto',
      maxPosition: '100',
      takeProfitBps: '1',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['entryBps'], message: 'entry threshold must be greater than zero for auto strategies' }),
    ]));
  });
});

function fillEvents(runtime: TradingRuntime, remoteId: string, clientOrderId?: string): void {
  runtime.ingestPrivateEvent({ channel: 'order', payload: {
    order_id: remoteId, ...(clientOrderId ? { text: clientOrderId } : {}), state: 'FILLED',
    executed_qty: '0.1', executed_avg_price: '100000', update_time: '1783600001000',
  } });
  runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
    transaction_id: `txn-${remoteId}`, order_id: remoteId, symbol: 'BINANCE_FUTURE_BTC_USDT',
    exchange_type: 'BINANCE', side: 'BUY', qty: '0.1', price: '100000', fee: '0.5', rpnl: '0',
    match_role: 'TAKER', create_time: '1783600001000',
  } });
}

describe('trading runtime order submission', () => {
  it('records the local row before submission so a fill push racing the REST response is never dropped', async () => {
    const { runtime, gateway } = await createHarness({
      duringCreate: (order, remoteId) => fillEvents(runtime, remoteId, order.text),
    });
    const order = await runtime.createOrder(marketOrderInput);
    expect(order.state).toBe('FILLED');
    expect(order.remoteOrderId).toBe('remote-1');
    expect(order.executedQuantity).toBe('0.1');
    const fills = runtime.snapshot().fills as Array<{ id: string }>;
    expect(fills).toHaveLength(1);
    expect(gateway.createRequests).toHaveLength(1);
  });

  it('buffers pushes that carry only the remote id and replays them once acceptance records it', async () => {
    const { runtime } = await createHarness({
      duringCreate: (_order, remoteId) => fillEvents(runtime, remoteId),
    });
    const order = await runtime.createOrder(marketOrderInput);
    expect(order.state).toBe('FILLED');
    expect(order.remoteOrderId).toBe('remote-1');
    expect(order.executedQuantity).toBe('0.1');
    expect((runtime.snapshot().fills as unknown[])).toHaveLength(1);
  });

  it('keeps a definitive Gate rejection as a terminal FAIL audit row', async () => {
    const { runtime } = await createHarness({
      createError: () => new GateApiError(400, 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR'),
    });
    await expect(runtime.createOrder(marketOrderInput)).rejects.toMatchObject({ label: 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR' });
    const [order] = runtime.listOrders();
    expect(order?.state).toBe('FAIL');
    expect(order?.remoteOrderId).toBeNull();
    expect(isTerminalOrderState(order?.state ?? '')).toBe(true);
  });

  it('resolves an ambiguous submit failure from the order-details endpoint', async () => {
    const { runtime, gateway } = await createHarness({
      createError: () => new GateApiError(0, 'NETWORK_ERROR'),
      queryOrder: (orderId) => remoteOrder({ order_id: 'remote-77', state: 'FILLED', text: orderId }),
    });
    await expect(runtime.createOrder(marketOrderInput)).rejects.toMatchObject({ label: 'NETWORK_ERROR' });
    const [pending] = runtime.listOrders();
    expect(pending?.state).toBe('PENDING_SUBMIT');
    expect(isTerminalOrderState(pending?.state ?? '')).toBe(false);
    await waitFor(() => runtime.listOrders()[0]?.state === 'FILLED');
    const [settled] = runtime.listOrders();
    expect(settled?.remoteOrderId).toBe('remote-77');
    expect(settled?.executedQuantity).toBe('0.1');
    // The lookup must have used the client order id, the only identifier we hold pre-acceptance.
    expect(gateway.queriedOrderIds[0]).toBe(settled?.clientOrderId);
  });

  it('marks an ambiguous submit failure FAIL when Gate reports the order never existed', async () => {
    const { runtime } = await createHarness({
      createError: () => new GateApiError(0, 'NETWORK_ERROR'),
      queryOrder: () => { throw new GateApiError(404, 'ORDER_NOT_FOUND'); },
    });
    await expect(runtime.createOrder(marketOrderInput)).rejects.toMatchObject({ label: 'NETWORK_ERROR' });
    await waitFor(() => runtime.listOrders()[0]?.state === 'FAIL');
    expect(runtime.listOrders()[0]?.remoteOrderId).toBeNull();
  });

  it('creates no local rows while live trading is locked', async () => {
    const { runtime } = await createHarness({}, { liveTradingEnabled: false });
    await expect(runtime.createOrder(marketOrderInput)).rejects.toMatchObject({ code: 'live_trading_locked' });
    expect(runtime.listOrders()).toHaveLength(0);
  });

  it('applies the injected execution guard before creating a local row or calling the gateway', async () => {
    const denied = Object.assign(new Error('execution_kill_switch_active'), { code: 'execution_kill_switch_active' });
    const { runtime, gateway } = await createHarness({}, {
      beforeCreateOrder: () => { throw denied; },
    });
    await expect(runtime.createOrder(marketOrderInput)).rejects.toMatchObject({ code: 'execution_kill_switch_active' });
    expect(runtime.listOrders()).toHaveLength(0);
    expect(gateway.createRequests).toHaveLength(0);
  });
});

describe('private event ingestion guards', () => {
  it('persists terminal order rejection reasons for strategy recovery and diagnostics', async () => {
    const { runtime } = await createHarness();
    const order = await runtime.createOrder(marketOrderInput);
    const reason = JSON.stringify({
      label: 'NOT_BEST_ACCOUNT_ROUTER',
      message: 'All trading channels are currently busy.',
    });
    runtime.ingestPrivateEvent({ channel: 'order', payload: {
      order_id: 'remote-1', state: 'FAIL', executed_qty: '0', executed_avg_price: '0', reason,
      update_time: '1783600002000',
    } });

    expect(runtime.getOrder(order.id)).toMatchObject({ state: 'FAIL', failureReason: reason });
  });

  it('fetches a terminal rejection reason when the private push omits it', async () => {
    const reason = JSON.stringify({
      label: 'NOT_BEST_ACCOUNT_ROUTER',
      message: 'All trading channels are currently busy.',
    });
    const { runtime, gateway } = await createHarness({
      queryOrder: (orderId) => remoteOrder({
        order_id: orderId, state: 'FAIL', executed_qty: '0', executed_avg_price: '0', reason,
      }),
    });
    const order = await runtime.createOrder(marketOrderInput);
    const settlement = runtime.awaitTerminalOrder(order.id, 500, 10);
    runtime.ingestPrivateEvent({ channel: 'order', payload: {
      order_id: 'remote-1', state: 'FAIL', executed_qty: '0', executed_avg_price: '0',
      update_time: '1783600002000',
    } });

    await expect(settlement).resolves.toMatchObject({ state: 'FAIL', failureReason: reason });
    expect(gateway.queriedOrderIds).toContain('remote-1');
  });

  it('never regresses a terminal order on replayed pushes and keeps executed quantity monotonic', async () => {
    const { runtime } = await createHarness();
    const order = await runtime.createOrder(marketOrderInput);
    runtime.ingestPrivateEvent({ channel: 'order', payload: {
      order_id: 'remote-1', state: 'FILLED', executed_qty: '0.1', executed_avg_price: '100000', update_time: '1783600002000',
    } });
    expect(runtime.getOrder(order.id).state).toBe('FILLED');

    // A reconnect replay delivers a stale open-state push with a lower executed quantity.
    runtime.ingestPrivateEvent({ channel: 'order', payload: {
      order_id: 'remote-1', state: 'OPEN', executed_qty: '0.05', executed_avg_price: '99000', update_time: '1783600000500',
    } });
    const replayed = runtime.getOrder(order.id);
    expect(replayed.state).toBe('FILLED');
    expect(replayed.executedQuantity).toBe('0.1');
    expect(replayed.executedAveragePrice).toBe('100000');
  });

  it('still allows a terminal-to-terminal correction when a cancel raced a fill', async () => {
    const { runtime } = await createHarness();
    const order = await runtime.createOrder(marketOrderInput);
    runtime.ingestPrivateEvent({ channel: 'order', payload: { order_id: 'remote-1', state: 'CANCELLED', update_time: '1783600002000' } });
    runtime.ingestPrivateEvent({ channel: 'order', payload: {
      order_id: 'remote-1', state: 'FILLED', executed_qty: '0.1', executed_avg_price: '100000', update_time: '1783600002500',
    } });
    const corrected = runtime.getOrder(order.id);
    expect(corrected.state).toBe('FILLED');
    expect(corrected.executedQuantity).toBe('0.1');
  });

  it('merges partial balance pushes instead of zeroing omitted fields', async () => {
    const { runtime } = await createHarness();
    const emitted: Array<Record<string, string>> = [];
    runtime.subscribe((event) => {
      if (event.type === 'balance.update') emitted.push(event.payload as Record<string, string>);
    });
    runtime.ingestPrivateEvent({ channel: 'asset', payload: {
      coin: 'USDT', exchange_type: 'GATE', balance: '1000', available_balance: '900', equity: '1005', upnl: '5',
    } });
    // A partial push carrying only equity must not reset the other fields.
    runtime.ingestPrivateEvent({ channel: 'asset', payload: { coin: 'USDT', exchange_type: 'GATE', equity: '1010' } });

    const [balance] = runtime.listBalances();
    expect(balance).toMatchObject({ venue: 'GATE', coin: 'USDT', balance: '1000', availableBalance: '900', equity: '1010', unrealizedPnl: '5' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ balance: '1000', availableBalance: '900', equity: '1010', unrealizedPnl: '5' });
  });

  it('idempotently recovers local execution fills from REST portfolio history', async () => {
    const { runtime, database } = await createHarness();
    const order = await runtime.createOrder(marketOrderInput);
    const snapshots: unknown[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'execution.snapshot') snapshots.push(event.payload);
    });
    const recoveredFill = {
      transactionId: 'rest-fill-1',
      orderId: 'remote-1',
      clientOrderId: order.clientOrderId,
      symbol: 'BINANCE_FUTURE_BTC_USDT',
      venue: 'BINANCE',
      product: 'FUTURE',
      side: 'SELL',
      quantity: '0.1',
      price: '101000',
      fee: '0.505',
      feeCoin: 'USDT',
      feeRate: '0.0005',
      matchRole: 'TAKER',
      realizedPnl: '100',
      positionMode: 'BOTH',
      positionSide: 'LONG',
      createdAt: '2026-07-28T12:00:00.000Z',
    };

    expect(runtime.reconcileExecutionFills([recoveredFill])).toBe(1);
    expect(runtime.reconcileExecutionFills([recoveredFill])).toBe(0);
    expect(database.prepare(`SELECT order_id, fee, realized_pnl FROM execution_fills WHERE id = 'rest-fill-1'`).get())
      .toEqual({ order_id: order.id, fee: '0.505', realized_pnl: '100' });
    expect(snapshots).toHaveLength(1);
  });
});

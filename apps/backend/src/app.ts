import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { PublicMarketDataError, type PublicMarketDataGateway } from '@gate-crossex/public-data';
import { reconcilePortfolioSnapshots, stalePortfolioReconciliation } from '@gate-crossex/domain';
import {
  CrossExTransferAccountSchema,
  CrossExTransferRequestSchema,
  canonicalizeCrossExTransfer,
  crossExTransferRouteError,
  UserPreferencesSchema,
  type UserPreferencesResponse,
} from '@gate-crossex/shared-types';
import type {
  CandleInterval,
  CandleSeriesResponse,
  CredentialConnectionStatus,
  CrossExInstrument,
  CrossExInstrumentCatalog,
  CrossExRiskLimit,
  CrossExRiskLimitResponse,
  CrossExPortfolioActivityResponse,
  CrossExTransferBalancesResponse,
  CrossExTransferCoinsResponse,
  CrossExTransferRecord,
  CrossExAccountBookRecord,
  FundingHistoryResponse,
  FundingHistorySeriesResponse,
  FundingOverviewResponse,
  MarketCatalogAsset,
  MarketCatalogResponse,
  MarketCatalogVenue,
  PortfolioFuturesPosition,
  PortfolioSnapshot,
  ReconciliationReportList,
  PublicMarketSnapshotResponse,
  ReadOnlyAccountSummary,
  VenueFeeRatesResponse,
} from '@gate-crossex/shared-types';
import type { BackendConfig } from './config.js';
import {
  CredentialVaultUnavailableError,
  DEFAULT_CREDENTIAL_PROFILE,
  type CredentialVault,
  type CredentialStorageProvider,
  type GateCredentials,
  type SelectableCredentialStorageProvider,
} from './credential-vault.js';
import { OneTimeCsrfTokens } from './csrf.js';
import { GateApiError, type GateCrossExAccount, type GateCrossExPortfolio, type GateCrossExPosition, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateTransferRecord, type GateAccountBookRecord, type PortfolioOperationsCrossExGateway, type ReadOnlyCrossExGateway, type TradingCrossExGateway } from './crossex-client.js';
import { CandleStore } from './candle-store.js';
import { FundingHistoryService } from './funding-history.js';
import { FundingOverviewService } from './funding-overview.js';
import { canonicalMarketAsset } from './market-asset-aliases.js';
import { CrossExMarketHub, CANDLE_INTERVALS, type MarketDefinition, type MarketHubMessage } from './market-hub.js';
import { StrategyEngine, StrategyEngineError } from './strategy-engine.js';
import { TradingSession } from './trading-session.js';
import { TradingRuntime, TradingRuntimeError } from './trading-runtime.js';
import { OrderConfirmationError, OrderConfirmationStore } from './order-confirmation.js';
import { CloudAuthError, CloudRequestAuthenticator, type CloudPrincipal, type CloudRole } from './cloud-auth.js';
import { AccountOwnershipError, AccountOwnershipStore } from './account-ownership.js';
import { ExecutionRiskError, ExecutionRiskGuard, ExecutionRiskPolicySchema } from './execution-risk.js';
import { buildTargetStatePreview } from './target-state-preview.js';
import { TargetShadowPlanError, TargetShadowPlanStore } from './target-shadow-plan.js';
import { readLatestBridgeAudit, TargetShadowComparisonStore } from './target-shadow-comparison.js';
import { ProtectionReconciliationStore } from './protection-reconciliation.js';
import { CrossExPrivateStream } from './private-stream.js';
import { LivePortfolioStore, type LivePortfolioSnapshot } from './live-portfolio.js';
import { readDatabaseStatus } from './database.js';
import { runDatabaseMaintenance } from './database-maintenance.js';
import {
  addAuditEvent,
  deleteCredentialMetadata,
  getCredentialMetadata,
  readInstrumentCatalog,
  readLatestPortfolioSnapshot,
  readPublicMarketSnapshot,
  readRiskLimit,
  readUserPreferences,
  saveUserPreferences,
  recordMarketDataFailure,
  replaceInstrumentCatalog,
  replaceRiskLimits,
  listReconciliationReports,
  savePortfolioSnapshot,
  saveReconciliationReport,
  upsertPublicMarketSnapshot,
  upsertCredentialMetadata,
} from './repositories.js';
import {
  renderCredentialDeletedPage,
  renderCredentialEntryPage,
  renderCredentialSuccessPage,
  type SecureCredentialLanguage,
} from './secure-credential-page.js';

const API_DOCS_RETRIEVED_AT = '2026-08-01';
const API_DOCS_VERSION = 'Gate CrossEx REST v1.0.2 / WebSocket v1.0.0';
const MARKET_REFERENCE_CACHE_MS = 5 * 60_000;
const STREAM_VOLATILE_EMIT_INTERVAL_MS = 200;
const STREAM_STATUS_INTERVAL_MS = 20_000;
const MAX_STREAM_TRADE_BATCH = 80;
const MARKET_CATALOG_FRESH_MS = 30 * 60_000;
const PUBLIC_SNAPSHOT_FRESH_MS = 4_000;

const CATALOG_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'] as const;
const QUOTE_PREFERENCE = ['USDT', 'USDC', 'USD'] as const;
const CROSSEX_FUTURE_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/;
const STRATEGY_ID = /^(AUTO|PAIR|PREM)-[A-Z0-9]{8}$/;
const FundingHistoryRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(50),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(30),
});
const FundingRankingRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(5_000),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});
const FundingHistorySeriesRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(7),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});

interface DerivedMarketCatalog {
  fetchedAt: string;
  assets: Map<string, MarketCatalogVenue[]>;
  liveSymbols: Set<string>;
}

/** Group live FUTURE instruments by asset with one venue entry each (preferred quote first). */
function deriveMarketCatalog(items: CrossExInstrument[], fetchedAt: string): DerivedMarketCatalog {
  const assets = new Map<string, Map<string, MarketCatalogVenue>>();
  const liveSymbols = new Set<string>();
  for (const item of items) {
    if (item.businessType !== 'FUTURE' || item.state !== 'live') continue;
    const match = CROSSEX_FUTURE_SYMBOL.exec(item.symbol);
    if (!match) continue;
    const [, venue, nativeAsset, quote] = match;
    if (!venue || !nativeAsset || !quote || !(CATALOG_VENUES as readonly string[]).includes(venue)) continue;
    const asset = canonicalMarketAsset(venue, item.businessType, nativeAsset);
    liveSymbols.add(item.symbol);
    const venues = assets.get(asset) ?? new Map<string, MarketCatalogVenue>();
    const existing = venues.get(venue);
    const rank = (value: string) => { const index = (QUOTE_PREFERENCE as readonly string[]).indexOf(value); return index === -1 ? QUOTE_PREFERENCE.length : index; };
    if (!existing || rank(quote) < rank(existing.quote)) {
      venues.set(venue, { venue, symbol: item.symbol, quote });
    }
    assets.set(asset, venues);
  }
  const ordered = new Map<string, MarketCatalogVenue[]>();
  for (const asset of [...assets.keys()].sort()) {
    const venues = assets.get(asset);
    if (!venues) continue;
    ordered.set(asset, [...venues.values()].sort((left, right) => (CATALOG_VENUES as readonly string[]).indexOf(left.venue) - (CATALOG_VENUES as readonly string[]).indexOf(right.venue)));
  }
  return { fetchedAt, assets: ordered, liveSymbols };
}

const CredentialContextSchema = z.object({
  intent: z.literal('live-trading').optional(),
  lang: z.enum(['en', 'zh']).optional(),
});
const CredentialFormSchema = CredentialContextSchema.extend({
  csrfToken: z.string().min(20).max(200),
  label: z.string().trim().min(1).max(80).refine(noControlCharacters),
  apiKey: z.string().min(8).max(256).refine(noControlCharacters),
  apiSecret: z.string().min(8).max(512).refine(noControlCharacters),
  storageProvider: z.enum(['os_keychain', 'env_file']).optional(),
});

function hasLiveTradingCredentialIntent(value: unknown): boolean {
  const parsed = CredentialContextSchema.safeParse(value);
  return parsed.success && parsed.data.intent === 'live-trading';
}

function secureCredentialLanguage(value: unknown): SecureCredentialLanguage {
  const parsed = CredentialContextSchema.safeParse(value);
  return parsed.success && parsed.data.lang === 'zh' ? 'zh' : 'en';
}

function credentialPageMessage(language: SecureCredentialLanguage, english: string, chinese: string): string {
  return language === 'zh' ? chinese : english;
}

const DeleteCredentialFormSchema = CredentialContextSchema.extend({
  csrfToken: z.string().min(20).max(200),
});

export interface BuildAppOptions {
  config: BackendConfig;
  database: Database.Database;
  credentialVault: CredentialVault;
  crossExGateway: ReadOnlyCrossExGateway;
  publicMarketGateway: PublicMarketDataGateway;
  marketHub?: CrossExMarketHub;
  tradingSession?: TradingSession;
  startMarketStream?: boolean;
  logger?: boolean;
  rateLimitMax?: number;
}

const cloudPrincipals = new WeakMap<object, CloudPrincipal>();

function noControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });
}

function storedCredentialProvider(value: string | undefined, fallback: CredentialStorageProvider): CredentialStorageProvider {
  return value === 'os_keychain' || value === 'env_file' || value === 'memory_test_only' || value === 'unavailable'
    ? value
    : fallback;
}

function hostnameFromHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    return closingBracket > 0 ? value.slice(1, closingBracket) : null;
  }
  return value.split(':', 1)[0] || null;
}

function isAllowedBrowserOrigin(origin: string, hostHeader: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  if (allowedOrigins.has(origin)) return true;
  if (!hostHeader) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

function isCsrfProtectedCredentialForm(method: string, url: string): boolean {
  if (method !== 'POST') return false;
  const pathname = url.split('?', 1)[0];
  return pathname === '/secure/credentials' || pathname === '/secure/credentials/delete';
}

function setSecureHtml(reply: FastifyReply, rendered: { html: string; csp: string }, statusCode = 200): FastifyReply {
  return reply
    .code(statusCode)
    .header('Cache-Control', 'no-store, max-age=0')
    .header('Pragma', 'no-cache')
    .header('Content-Security-Policy', rendered.csp)
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'DENY')
    .type('text/html; charset=utf-8')
    .send(rendered.html);
}

function summarizeAccount(account: GateCrossExAccount, verifiedAt: string): ReadOnlyAccountSummary {
  const remoteUpdateMilliseconds = Number(account.update_time);
  const remoteUpdatedAt = Number.isFinite(remoteUpdateMilliseconds)
    ? new Date(remoteUpdateMilliseconds).toISOString()
    : account.update_time;
  return {
    availableMargin: account.available_margin,
    marginBalance: account.margin_balance,
    initialMargin: account.initial_margin,
    maintenanceMargin: account.maintenance_margin,
    initialMarginRate: account.initial_margin_rate,
    maintenanceMarginRate: account.maintenance_margin_rate,
    positionMode: account.position_mode,
    accountMode: account.account_mode,
    exchangeType: account.exchange_type,
    venues: [...new Set(account.assets.map((asset) => asset.exchange_type))].sort(),
    assetCount: account.assets.length,
    remoteUpdatedAt,
    verifiedAt,
  };
}

function normalizeInstrument(symbol: GateCrossExSymbol): CrossExInstrument {
  return {
    symbol: symbol.symbol,
    exchangeType: symbol.exchange_type,
    businessType: symbol.business_type,
    state: symbol.state,
    minSize: symbol.min_size,
    minNotional: symbol.min_notional,
    lotSize: symbol.lot_size,
    tickSize: symbol.tick_size,
    maxNumOrders: symbol.max_num_orders,
    maxMarketSize: symbol.max_market_size,
    maxLimitSize: symbol.max_limit_size,
    contractSize: symbol.contract_size,
    liquidationFee: symbol.liquidation_fee,
    defaultLeverage: symbol.default_leverage ?? null,
    delistTime: symbol.delist_time,
  };
}

function normalizeRiskLimit(limit: GateCrossExRiskLimit): CrossExRiskLimit {
  return {
    symbol: limit.symbol,
    tiers: limit.tiers.map((tier) => ({
      tier: tier.tier,
      minRiskLimitValue: tier.min_risk_limit_value,
      maxRiskLimitValue: tier.max_risk_limit_value,
      quickCalAmount: tier.quick_cal_amount,
      leverageMax: tier.leverage_max,
      maintenanceRate: tier.maintenance_rate,
    })),
  };
}

function isFresh(timestamp: string, now: number): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && now - parsed < MARKET_REFERENCE_CACHE_MS;
}

function millisecondTimestamp(value: string | number): string {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : String(value);
}

function normalizeFuturesPositions(positions: GateCrossExPosition[]): PortfolioFuturesPosition[] {
  return positions.map((position) => ({
    positionId: position.position_id, symbol: position.symbol, positionSide: position.position_side,
    initialMargin: position.initial_margin, maintenanceMargin: position.maintenance_margin,
    quantity: position.position_qty, value: position.position_value, unrealizedPnl: position.upnl,
    unrealizedPnlRate: position.upnl_rate, entryPrice: position.entry_price, markPrice: position.mark_price,
    leverage: position.leverage, maxLeverage: position.max_leverage, riskLimit: position.risk_limit,
    fee: position.fee, fundingFee: position.funding_fee, fundingTime: position.funding_time,
    createdAt: millisecondTimestamp(position.create_time), updatedAt: millisecondTimestamp(position.update_time),
    realizedPnl: position.closed_pnl,
  }));
}

function normalizePortfolio(portfolio: GateCrossExPortfolio, fetchedAt: string): PortfolioSnapshot {
  const { account } = portfolio;
  return {
    account: {
      availableMargin: account.available_margin, marginBalance: account.margin_balance,
      initialMargin: account.initial_margin, maintenanceMargin: account.maintenance_margin,
      initialMarginRate: account.initial_margin_rate, maintenanceMarginRate: account.maintenance_margin_rate,
      positionMode: account.position_mode, accountMode: account.account_mode,
      exchangeType: account.exchange_type, remoteUpdatedAt: millisecondTimestamp(account.update_time),
    },
    balances: account.assets.map((asset) => ({
      venue: asset.exchange_type, coin: asset.coin, balance: asset.balance, unrealizedPnl: asset.upnl,
      equity: asset.equity, futuresInitialMargin: asset.futures_initial_margin,
      futuresMaintenanceMargin: asset.futures_maintenance_margin,
      borrowingInitialMargin: asset.borrowing_initial_margin,
      borrowingMaintenanceMargin: asset.borrowing_maintenance_margin,
      availableBalance: asset.available_balance, liability: asset.liability,
    })),
    futuresPositions: normalizeFuturesPositions(portfolio.positions),
    marginPositions: portfolio.marginPositions.map((position) => ({
      positionId: position.position_id, symbol: position.symbol, positionSide: position.position_side,
      initialMargin: position.initial_margin, maintenanceMargin: position.maintenance_margin,
      assetQuantity: position.asset_qty, assetCoin: position.asset_coin, value: position.position_value,
      liability: position.liability, liabilityCoin: position.liability_coin, interest: position.interest,
      maxPositionQuantity: position.max_position_qty, entryPrice: position.entry_price,
      indexPrice: position.index_price, unrealizedPnl: position.upnl, unrealizedPnlRate: position.upnl_rate,
      leverage: position.leverage, maxLeverage: position.max_leverage,
      createdAt: millisecondTimestamp(position.create_time), updatedAt: millisecondTimestamp(position.update_time),
    })),
    openOrders: portfolio.openOrders.map((order) => ({
      orderId: order.order_id, clientOrderId: order.client_order_id ?? order.text ?? '', state: order.state,
      symbol: order.symbol, side: order.side, type: order.type, attribute: order.attribute,
      venue: order.exchange_type, product: order.business_type, quantity: order.qty,
      quoteQuantity: order.quote_qty, price: order.price, timeInForce: order.time_in_force,
      executedQuantity: order.executed_qty, executedAmount: order.executed_amount,
      executedAveragePrice: order.executed_avg_price, feeCoin: order.fee_coin, fee: order.fee,
      reduceOnly: order.reduce_only, leverage: order.leverage, reason: order.reason,
      positionSide: order.position_side, createdAt: millisecondTimestamp(order.create_time),
      updatedAt: millisecondTimestamp(order.update_time),
    })),
    recentFills: portfolio.recentTrades.map((trade) => ({
      transactionId: trade.transaction_id, orderId: trade.order_id, clientOrderId: trade.text,
      symbol: trade.symbol, venue: trade.exchange_type, product: trade.business_type, side: trade.side,
      quantity: trade.qty, price: trade.price, fee: trade.fee, feeCoin: trade.fee_coin,
      feeRate: trade.fee_rate, matchRole: trade.match_role, realizedPnl: trade.rpnl,
      positionMode: trade.position_mode, positionSide: trade.position_side,
      createdAt: millisecondTimestamp(trade.create_time),
    })),
    fetchedAt,
    source: 'gate_crossex_authenticated_rest',
  };
}

function normalizeTransferRecords(records: GateTransferRecord[]): CrossExTransferRecord[] {
  return records.map((record) => ({
    id: record.id,
    text: record.text,
    from: record.from_account_type,
    to: record.to_account_type,
    coin: record.coin,
    amount: record.amount,
    actualReceive: record.actual_receive,
    status: record.status,
    failureReason: record.fail_reason,
    createdAt: millisecondTimestamp(record.create_time),
    updatedAt: millisecondTimestamp(record.update_time),
  }));
}

function normalizeAccountBook(records: GateAccountBookRecord[]): CrossExAccountBookRecord[] {
  return records.map((record) => ({
    id: record.id,
    businessId: record.business_id,
    statementType: record.statement_type,
    venue: record.exchange_type,
    coin: record.coin,
    symbol: record.symbol ?? null,
    change: record.change,
    balance: record.balance,
    createdAt: millisecondTimestamp(record.create_time),
  }));
}

function safeCredentialError(error: unknown, language: SecureCredentialLanguage): string {
  if (error instanceof CredentialVaultUnavailableError) {
    return credentialPageMessage(language, 'The selected credential store is unavailable.', '所选凭证存储方式不可用。');
  }
  if (error instanceof StrategyEngineError && error.code === 'credential_change_blocked_by_open_orders') {
    return credentialPageMessage(
      language,
      'The credential change was blocked because one or more live orders could not be confirmed canceled. The old credential remains configured and trading remains locked.',
      '由于一个或多个实盘订单无法确认已取消，API 密钥更改被阻止。旧 API 密钥仍保持配置，交易继续锁定。',
    );
  }
  if (error instanceof GateApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return credentialPageMessage(language, 'Gate rejected the credentials or required permissions are missing.', 'Gate 拒绝了该 API 密钥，或 API 密钥缺少所需权限。');
    }
    if (error.label === 'NETWORK_ERROR') {
      return credentialPageMessage(language, 'The local backend could not reach the Gate API. No credentials were stored.', '本地后端无法连接 Gate API。未存储任何 API 密钥。');
    }
    if (error.label === 'INVALID_ACCOUNT_RESPONSE') {
      return credentialPageMessage(language, 'Gate returned an account response that did not match the documented schema.', 'Gate 返回的账户响应与文档中的数据结构不符。');
    }
    return credentialPageMessage(language, `Gate rejected the account verification (${error.label}).`, `Gate 拒绝了账户验证（${error.label}）。`);
  }
  return credentialPageMessage(language, 'Credential verification failed. No credentials were stored.', 'API 密钥验证失败。未存储任何 API 密钥。');
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, database, credentialVault, crossExGateway, publicMarketGateway } = options;
  const marketHub = options.marketHub ?? new CrossExMarketHub(config.gatePublicWebSocketUrl);
  const tradingSession = options.tradingSession ?? new TradingSession();
  const accountOwnership = new AccountOwnershipStore(database);
  const executionRisk = new ExecutionRiskGuard(database);
  const shadowAccountId = config.cloudDefaultAccountId ?? '__cloud_account_unconfigured__';
  const targetShadowPlans = new TargetShadowPlanStore(database, shadowAccountId);
  const targetShadowComparisons = new TargetShadowComparisonStore(database, shadowAccountId);
  const protectionReconciliations = config.protectionBookPath ? new ProtectionReconciliationStore(database, shadowAccountId, config.protectionBookPath) : null;
  const tradingRuntime = new TradingRuntime(database, tradingSession, credentialVault, crossExGateway, {
    beforeCreateOrder: config.deploymentMode === 'cloud'
      ? (order, identity, metadata) => {
        const rawCanonicalOrder = { ...order, price: order.price ?? null };
        const canonicalOrder = executionRisk.priceOrder(rawCanonicalOrder, Boolean(metadata?.riskReducing));
        const accountId = config.cloudDefaultAccountId ?? '';
        executionRisk.assertOrderAllowed(canonicalOrder, accountId);
        if (!identity.riskReservationDone) {
          executionRisk.reserveDailyNotional(`order:${identity.orderId}`, 'order', canonicalOrder, accountId);
        }
      }
      : undefined,
  });
  const orderConfirmations = new OrderConfirmationStore(
    database,
    config.orderConfirmationSecret ? Buffer.from(config.orderConfirmationSecret, 'utf8') : undefined,
  );
  const cloudAuthenticator = config.deploymentMode === 'cloud' && config.cloudBffSecret
    ? new CloudRequestAuthenticator(config.cloudBffSecret, config.cloudAuthMaxSkewMs, config.cloudNonceTtlMs)
    : null;
  if (config.cloudDefaultAccountId && config.cloudBootstrapAdminUserId) {
    accountOwnership.seedAccount(
      config.cloudDefaultAccountId,
      'Default Gate CrossEx Account',
      DEFAULT_CREDENTIAL_PROFILE,
      config.cloudBootstrapAdminUserId,
    );
  }
  const privateStream = new CrossExPrivateStream(config.gatePrivateWebSocketUrl, credentialVault);
  const cachedPortfolioAtBoot = readLatestPortfolioSnapshot(database);
  const livePortfolio = new LivePortfolioStore(
    cachedPortfolioAtBoot ? {
      snapshot: cachedPortfolioAtBoot,
      dataStatus: 'stale',
      remoteStatus: 'unavailable',
      reconciliation: stalePortfolioReconciliation(randomUUID(), new Date().toISOString(), cachedPortfolioAtBoot),
    } : null,
    privateStream.snapshot(),
  );
  let triggerPortfolioRefresh: (() => void) | null = null;
  let previousPrivateStreamState = privateStream.snapshot().state;
  privateStream.subscribe((event) => {
    try {
      livePortfolio.ingest(event);
      tradingRuntime.ingestPrivateEvent(event);
    } catch (error) {
      app.log.error({ err: error, channel: event.channel }, 'failed to ingest private stream event');
    }
  });
  privateStream.subscribeStatus((status) => {
    livePortfolio.setStreamStatus(status);
    if (status.state === 'live' && previousPrivateStreamState !== 'live') triggerPortfolioRefresh?.();
    previousPrivateStreamState = status.state;
  });
  const csrfTokens = new OneTimeCsrfTokens();
  let feeCache: { fees: VenueFeeRatesResponse['fees']; fetchedAt: string } | null = null;
  let feeFetchInFlight: Promise<{ fees: VenueFeeRatesResponse['fees']; fetchedAt: string }> | null = null;
  let transferCoinCache: { items: CrossExTransferCoinsResponse['items']; fetchedAt: string } | null = null;
  let transferCoinFetchInFlight: Promise<{ items: CrossExTransferCoinsResponse['items']; fetchedAt: string }> | null = null;
  let sizeUnitCache: { units: Record<string, string>; fetchedAt: string; complete: boolean; marketCount: number } | null = null;
  let sizeUnitInFlight: Promise<void> | null = null;
  const selectableStorageProviders = credentialVault.availableProviders.filter(
    (provider): provider is SelectableCredentialStorageProvider => provider === 'os_keychain' || provider === 'env_file',
  );
  const recordedCredentialProvider = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE)?.provider;
  if (recordedCredentialProvider === 'os_keychain' || recordedCredentialProvider === 'env_file') {
    credentialVault.setPreferredProvider?.(DEFAULT_CREDENTIAL_PROFILE, recordedCredentialProvider);
  }
  let positionsRefreshInProgress = false;

  const fetchTransferCoins = async (): Promise<{ items: CrossExTransferCoinsResponse['items']; fetchedAt: string }> => {
    if (transferCoinCache && Date.now() - Date.parse(transferCoinCache.fetchedAt) < 10 * 60_000) return transferCoinCache;
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryTransferCoins) throw new GateApiError(503, 'TRANSFER_COINS_UNAVAILABLE');
    transferCoinFetchInFlight ??= (async () => {
      const coins = await operationsGateway.queryTransferCoins!();
      const refreshed = {
        items: coins
          .map((coin) => ({
            coin: coin.coin,
            minimumAmount: coin.min_trans_amount,
            estimatedFee: coin.est_fee,
            precision: coin.precision,
            disabled: coin.is_disabled !== 0,
          }))
          .sort((left, right) => left.coin.localeCompare(right.coin)),
        fetchedAt: new Date().toISOString(),
      };
      transferCoinCache = refreshed;
      return refreshed;
    })().finally(() => { transferCoinFetchInFlight = null; });
    return transferCoinFetchInFlight;
  };

  // --- Instrument catalog: one fetch path shared by /api/crossex/instruments and /api/markets/catalog.
  let instrumentFetchInFlight: Promise<{ items: CrossExInstrument[]; fetchedAt: string }> | null = null;
  const fetchInstrumentCatalog = () => {
    instrumentFetchInFlight ??= (async () => {
      const items = (await crossExGateway.querySymbols())
        .map(normalizeInstrument)
        .sort((left, right) => left.symbol.localeCompare(right.symbol));
      const fetchedAt = new Date().toISOString();
      replaceInstrumentCatalog(database, items, fetchedAt);
      return { items, fetchedAt };
    })().finally(() => { instrumentFetchInFlight = null; });
    return instrumentFetchInFlight;
  };
  const riskLimitFetches = new Map<string, Promise<{ item: CrossExRiskLimit; fetchedAt: string } | null>>();
  const fetchRiskLimit = (symbol: string) => {
    const existing = riskLimitFetches.get(symbol);
    if (existing) return existing;
    const pending = (async () => {
      const limits = (await crossExGateway.queryRiskLimits([symbol])).map(normalizeRiskLimit);
      const item = limits.find((limit) => limit.symbol === symbol) ?? null;
      if (!item) return null;
      const fetchedAt = new Date().toISOString();
      replaceRiskLimits(database, limits, fetchedAt);
      return { item, fetchedAt };
    })().finally(() => {
      if (riskLimitFetches.get(symbol) === pending) riskLimitFetches.delete(symbol);
    });
    riskLimitFetches.set(symbol, pending);
    return pending;
  };
  const publicSnapshotFetches = new Map<string, Promise<PublicMarketSnapshotResponse['snapshot']>>();
  const fetchPublicSnapshot = (symbol: string) => {
    const existing = publicSnapshotFetches.get(symbol);
    if (existing) return existing;
    const pending = (async () => {
      const snapshot = await publicMarketGateway.querySnapshot(symbol);
      upsertPublicMarketSnapshot(database, snapshot);
      return snapshot;
    })().finally(() => {
      if (publicSnapshotFetches.get(symbol) === pending) publicSnapshotFetches.delete(symbol);
    });
    publicSnapshotFetches.set(symbol, pending);
    return pending;
  };

  let derivedCatalog: DerivedMarketCatalog | null = null;
  const derivedMarketCatalog = (): DerivedMarketCatalog | null => {
    const cached = readInstrumentCatalog(database);
    if (!cached) return null;
    if (!derivedCatalog || derivedCatalog.fetchedAt !== cached.fetchedAt) {
      derivedCatalog = deriveMarketCatalog(cached.items, cached.fetchedAt);
    }
    return derivedCatalog;
  };

  /**
   * All venue legs to stream for the asset of `symbol`, from the cached catalog only — this runs
   * on the watch path and must never block on upstream. Includes the exact requested symbol when
   * it is a live instrument, even if its quote is not the venue-preferred one.
   */
  const marketDefinitionsFor = (symbol: string): MarketDefinition[] | null => {
    const match = CROSSEX_FUTURE_SYMBOL.exec(symbol);
    if (!match) return null;
    const [, venue, nativeAsset] = match;
    const catalog = derivedMarketCatalog();
    if (!catalog || !venue || !nativeAsset) return null;
    const asset = canonicalMarketAsset(venue, 'FUTURE', nativeAsset);
    const definitions: MarketDefinition[] = (catalog.assets.get(asset) ?? [])
      .map((entry) => ({ symbol: entry.symbol, venue: entry.venue as MarketDefinition['venue'], asset }));
    if (catalog.liveSymbols.has(symbol) && !definitions.some((definition) => definition.symbol === symbol)) {
      definitions.push({ symbol, venue: venue as MarketDefinition['venue'], asset });
    }
    return definitions.length > 0 ? definitions : null;
  };

  const ensureMarketKnown = (symbol: string): boolean => {
    if (marketHub.market(symbol)) return true;
    const definitions = marketDefinitionsFor(symbol);
    return definitions !== null && marketHub.ensureMarkets(definitions) && marketHub.market(symbol) !== null;
  };

  // Strategies may trade catalog-only tickers (e.g. stock perps) that nothing has watched yet, so
  // the engine's market source can register them on demand at launch.
  const strategyEngine = new StrategyEngine(database, tradingSession, tradingRuntime, {
    market: (symbol) => marketHub.market(symbol),
    ensureMarket: ensureMarketKnown,
    // Unit/injected hubs may deliberately supply static market objects without starting a socket.
    // Production passes startMarketStream=true, where stream health must gate every strategy.
    ...(options.startMarketStream ? { connectionState: () => marketHub.connectionState() } : {}),
  });

  const quiesceForCredentialMutation = async (): Promise<void> => {
    const previous = tradingSession.current;
    if (previous === 'live') {
      tradingSession.set('readonly');
    }
    const unresolved = await strategyEngine.suspendForTradingLock();
    if (previous === 'live') {
      addAuditEvent(database, 'trading_mode_changed', {
        from: previous,
        to: 'readonly',
        disclaimerAccepted: false,
        reason: 'credential_mutation',
        unresolvedOrderCount: unresolved.length,
      });
    }
    if (unresolved.length > 0) {
      throw new StrategyEngineError(
        'credential_change_blocked_by_open_orders',
        409,
        unresolved.map(({ order }) => order.id).join(','),
      );
    }
  };

  const invalidateAuthenticatedState = (): void => {
    feeCache = null;
    livePortfolio.clear();
    tradingRuntime.clearAuthenticatedAccountState();
  };

  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger:
      options.logger === false
        ? false
        : {
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers.key',
                'req.headers.sign',
                'req.headers.x-gate-sign',
                'req.headers.x-gate-key',
                'req.body.apiKey',
                'req.body.apiSecret',
                '*.apiKey',
                '*.apiSecret',
                '*.key',
                '*.secret',
                '*.signature',
              ],
              censor: '[REDACTED]',
            },
          },
  });

  const maintenanceResult = runDatabaseMaintenance(database);
  if (Object.values(maintenanceResult).some((deleted) => deleted > 0)) {
    app.log.info(maintenanceResult, 'pruned expired local database records');
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: options.rateLimitMax ?? 120, timeWindow: '1 minute' });
  await app.register(cors, { origin: [...config.allowedOrigins], credentials: false });
  await app.register(formbody, { bodyLimit: 16 * 1024 });
  await app.register(websocket);

  const frontendIndexPath = join(config.frontendDistPath, 'index.html');
  const frontendAssetsPath = join(config.frontendDistPath, 'assets');
  if (existsSync(frontendIndexPath) && existsSync(frontendAssetsPath)) {
    const frontendIndex = readFileSync(frontendIndexPath, 'utf8');
    await app.register(fastifyStatic, {
      root: frontendAssetsPath,
      prefix: '/assets/',
      wildcard: true,
      decorateReply: false,
      cacheControl: true,
      immutable: true,
      maxAge: '1y',
    });
    const sendFrontend = async (_request: unknown, reply: FastifyReply) => (
      reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(frontendIndex)
    );
    app.get('/', sendFrontend);
    app.get('/portfolio', sendFrontend);
    app.get('/funding-rates', sendFrontend);
    app.get('/funding-rates/:asset', async (request, reply) => {
      const parsed = z.object({ asset: z.string().regex(/^[A-Z0-9]{1,20}$/i) }).safeParse(request.params);
      if (!parsed.success) return reply.code(404).send({ error: 'frontend_route_not_found' });
      return sendFrontend(request, reply);
    });
    app.get('/strategies/paired-position', sendFrontend);
    app.get('/strategies/price-difference', sendFrontend);
    app.get('/strategies/sk-hynix-premium', sendFrontend);
  }

  const candleStore = new CandleStore(database, marketHub, publicMarketGateway, {
    warn: (details, message) => app.log.warn(details, message),
  });

  const fundingOverviewService = new FundingOverviewService(publicMarketGateway, {
    warn: (venue, reason) => app.log.warn({ venue, reason }, 'funding overview venue fetch failed'),
  });
  const fundingHistoryService = new FundingHistoryService(database, publicMarketGateway, {
    warn: (symbol, reason) => app.log.warn({ symbol, reason }, 'funding history fetch failed'),
  });

  let portfolioRefreshInFlight: Promise<LivePortfolioSnapshot> | null = null;
  const refreshPortfolio = (): Promise<LivePortfolioSnapshot> => {
    if (portfolioRefreshInFlight) return portfolioRefreshInFlight;
    portfolioRefreshInFlight = (async () => {
      let credentials: GateCredentials | null = null;
      try {
        credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
        if (!credentials) throw new TradingRuntimeError('credential_missing_from_vault', 409);
        const metadata = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);
        const previous = readLatestPortfolioSnapshot(database);
        const portfolioCheckpoint = livePortfolio.checkpoint();
        const portfolio = await crossExGateway.queryPortfolio(credentials);
        const fetchedAt = new Date().toISOString();
        const snapshot = normalizePortfolio(portfolio, fetchedAt);
        const recoveredExecutionFillCount = tradingRuntime.reconcileExecutionFills(snapshot.recentFills);
        tradingRuntime.reconcileLivePositions(snapshot.futuresPositions);
        tradingRuntime.reconcileLiveBalances(snapshot.balances.map((balance) => ({
          venue: balance.venue,
          coin: balance.coin,
          balance: balance.balance,
          availableBalance: balance.availableBalance,
          equity: balance.equity,
          unrealizedPnl: balance.unrealizedPnl,
        })), fetchedAt);
        const provider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE) ?? credentialVault.provider;
        upsertCredentialMetadata(database, {
          id: DEFAULT_CREDENTIAL_PROFILE,
          label: metadata?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
          provider,
          createdAt: metadata?.createdAt ?? fetchedAt,
          lastVerifiedAt: fetchedAt,
        });
        const reconciliation = reconcilePortfolioSnapshots(randomUUID(), fetchedAt, previous, snapshot);
        savePortfolioSnapshot(database, snapshot);
        saveReconciliationReport(database, reconciliation);
        addAuditEvent(database, 'portfolio_read_only_snapshot_refreshed', {
          balanceCount: snapshot.balances.length,
          futuresPositionCount: snapshot.futuresPositions.length,
          marginPositionCount: snapshot.marginPositions.length,
          openOrderCount: snapshot.openOrders.length,
          recentFillCount: snapshot.recentFills.length,
          recoveredExecutionFillCount,
          reconciliationStatus: reconciliation.status,
          reconciliationIssueCount: reconciliation.issues.length,
        });
        return livePortfolio.reconcile({
          snapshot,
          dataStatus: 'fresh',
          remoteStatus: 'healthy',
          reconciliation,
        }, 'rest', portfolioCheckpoint);
      } finally {
        credentials = null;
      }
    })().finally(() => {
      portfolioRefreshInFlight = null;
    });
    return portfolioRefreshInFlight;
  };

  triggerPortfolioRefresh = () => {
    void refreshPortfolio().catch((error) => {
      if (!(error instanceof TradingRuntimeError && error.code === 'credential_missing_from_vault')) {
        app.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'background portfolio reconciliation failed');
      }
      livePortfolio.markRemoteUnavailable();
    });
  };

  let portfolioReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let databaseMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  const schedulePortfolioReconciliation = () => {
    if (!options.startMarketStream) return;
    const interval = Math.round(5 * 60_000 * (0.9 + Math.random() * 0.2));
    portfolioReconcileTimer = setTimeout(() => {
      triggerPortfolioRefresh?.();
      schedulePortfolioReconciliation();
    }, interval);
    portfolioReconcileTimer.unref?.();
  };

  if (options.startMarketStream) {
    marketHub.start();
    privateStream.start();
    strategyEngine.start();
    fundingHistoryService.startBackground();
    databaseMaintenanceTimer = setInterval(() => {
      try {
        const result = runDatabaseMaintenance(database);
        if (Object.values(result).some((deleted) => deleted > 0)) {
          app.log.info(result, 'pruned expired local database records');
        }
      } catch (error) {
        app.log.warn({ err: error }, 'database retention maintenance failed');
      }
    }, 24 * 60 * 60_000);
    databaseMaintenanceTimer.unref?.();
    schedulePortfolioReconciliation();
    // Bootstrap once per backend process. Concurrent UI tabs and a private-stream ready event
    // join the same single-flight request instead of multiplying five authenticated REST reads.
    triggerPortfolioRefresh();
  }
  app.addHook('onClose', async () => {
    await fundingHistoryService.stopBackground();
    await strategyEngine.stop();
    if (portfolioReconcileTimer) clearTimeout(portfolioReconcileTimer);
    if (databaseMaintenanceTimer) clearInterval(databaseMaintenanceTimer);
    livePortfolio.stop();
    marketHub.stop();
    privateStream.stop();
  });

  app.addHook('onRequest', async (request, reply) => {
    const hostname = hostnameFromHeader(request.headers.host);
    if (!hostname || !config.allowedHosts.has(hostname)) {
      return reply.code(403).send({ error: 'non_local_host_rejected' });
    }

    const origin = request.headers.origin;
    if (origin
      && !isAllowedBrowserOrigin(origin, request.headers.host, config.allowedOrigins)
      // These two script-free forms carry a high-entropy, one-time CSRF token that their route
      // consumes before touching credentials. Some browsers report an opaque/re-written Origin
      // for the isolated page, so let the stronger per-form check make the decision here.
      && !isCsrfProtectedCredentialForm(request.method, request.url)) {
      request.log.warn({ origin, host: request.headers.host }, 'rejected unexpected browser origin');
      return reply.code(403).send({ error: 'unexpected_origin_rejected' });
    }
  });

  const authenticateCloudRequest = (request: FastifyRequest): CloudPrincipal | null => {
    if (!cloudAuthenticator) return null;
    const cached = cloudPrincipals.get(request);
    if (cached) return cached;
    const principal = cloudAuthenticator.authenticate({
      method: request.method,
      url: request.url,
      body: request.body,
      headers: request.headers,
    });
    cloudPrincipals.set(request, principal);
    return principal;
  };
  const requireCloudRoles = (allowedRoles: readonly CloudRole[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = authenticateCloudRequest(request);
      if (principal) {
        cloudAuthenticator?.authorize(principal, allowedRoles);
        accountOwnership.requireAccess(principal.userId, principal.role, principal.accountId);
        accountOwnership.requireCredentialProfile(principal.accountId, DEFAULT_CREDENTIAL_PROFILE);
      }
    } catch (error) {
      if (error instanceof CloudAuthError || error instanceof AccountOwnershipError) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      request.log.error({ error }, 'cloud identity verification failed');
      return reply.code(500).send({ error: 'cloud_identity_verification_failed' });
    }
  };
  const publicCloudPath = (url: string): boolean => {
    const path = url.split('?', 1)[0] ?? url;
    return path === '/health'
      || path === '/api/system/discovery'
      || path === '/api/markets'
      || path.startsWith('/api/markets/')
      || path === '/api/crossex/instruments'
      || /^\/api\/crossex\/instruments\/[^/]+\/(risk-limits|market-snapshot)$/.test(path);
  };
  const defaultCloudRoles = (request: FastifyRequest): readonly CloudRole[] => {
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (path.startsWith('/secure/')) return ['admin'];
    if (request.method === 'GET') return ['viewer', 'planner', 'approver', 'admin', 'auditor'];
    if (path === '/api/v1/trading/order-previews' || path === '/api/v1/strategies/target-state-previews'
      || path === '/api/v1/strategies/target-shadow-plans'
      || (path.startsWith('/api/v1/strategies/target-shadow-plans/') && path.endsWith('/comparisons'))) {
      return ['planner', 'admin'];
    }
    if (path.includes('/confirm') || path.includes('/transfers') || path.includes('/orders') || path.includes('/strategies')) {
      return ['approver', 'admin'];
    }
    return ['admin'];
  };
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? request.url;
    const protectedPath = path.startsWith('/api/') || path.startsWith('/secure/') || path === '/ws/stream';
    if (!cloudAuthenticator || !protectedPath || publicCloudPath(request.url)) return;
    return requireCloudRoles(defaultCloudRoles(request))(request, reply);
  });

  app.get('/health', async () => {
    const databaseStatus = readDatabaseStatus(database);
    return {
      ok: databaseStatus.state === 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: 'live',
      deploymentMode: config.deploymentMode,
      executionMode: config.executionMode,
      liveWritesAllowed: config.allowLiveWrites,
      database: databaseStatus.state,
      apiDocsRetrievedAt: API_DOCS_RETRIEVED_AT,
      connectionState: databaseStatus.state === 'ok' ? marketHub.snapshot().connectionState === 'disconnected' ? 'healthy' : marketHub.snapshot().connectionState : 'degraded',
    };
  });

  app.get('/api/system/discovery', async () => {
    const databaseStatus = readDatabaseStatus(database);
    return {
      product: config.deploymentMode === 'cloud' ? 'Gate CrossEx Cloud Preview Platform' : 'Gate CrossEx Local Trading Terminal',
      mode: 'live',
      authenticatedTradingEnabled: config.executionMode === 'live' && config.allowLiveWrites && tradingSession.liveTradingEnabled,
      tradingMode: tradingSession.current,
      deploymentMode: config.deploymentMode,
      executionMode: config.executionMode,
      liveWritesAllowed: config.allowLiveWrites,
      docs: { apiVersion: API_DOCS_VERSION, retrievedAt: API_DOCS_RETRIEVED_AT },
      database: {
        migrationCount: databaseStatus.migrationCount,
        currentMigration: databaseStatus.currentMigration,
      },
      security: {
        credentialStorage: storedCredentialProvider(getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE)?.provider, credentialVault.provider),
        credentialEntryPath: config.deploymentMode === 'cloud' ? null : '/secure/credentials',
        browserJavaScriptHandlesSecrets: false,
      },
    };
  });

  app.get('/api/onboarding/connection', async (): Promise<CredentialConnectionStatus> => {
    const metadata = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);
    const detectedProvider = metadata ? null : await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE);
    return {
      configured: metadata !== null || detectedProvider !== null,
      storage: storedCredentialProvider(metadata?.provider, detectedProvider ?? credentialVault.provider),
      label: metadata?.label ?? (detectedProvider === 'env_file' ? 'Gate CrossEx (.env)' : null),
      lastVerifiedAt: metadata?.lastVerifiedAt ?? null,
      secureEntryPath: '/secure/credentials',
      readOnly: !tradingSession.liveTradingEnabled,
    };
  });

  app.get('/api/trading-mode', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async () => ({ mode: tradingSession.current }));

  app.post('/api/trading-mode', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [requireCloudRoles(['admin']), async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'set-trading-mode') return reply.code(403).send({ error: 'missing_trading_intent' });
    }],
  }, async (request, reply) => {
    const parsed = z.object({ mode: z.enum(['readonly', 'live']), acceptDisclaimer: z.boolean().default(false) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_trading_mode' });
    if (parsed.data.mode === 'live' && (config.executionMode !== 'live' || !config.allowLiveWrites)) {
      addAuditEvent(database, 'live_execution_denied', { reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    // Leaving the boot-time 'unset' state in any direction, or arming live trading from any
    // state, requires a fresh human acknowledgement of the risk disclaimer. The one transition
    // that must never be gated is live → readonly: locking is the safety action.
    const requiresDisclaimer = parsed.data.mode === 'live' || tradingSession.current === 'unset';
    if (requiresDisclaimer && !parsed.data.acceptDisclaimer) {
      return reply.code(400).send({ error: 'disclaimer_not_accepted' });
    }
    const previous = tradingSession.current;
    if (parsed.data.mode === previous) return { mode: previous };

    if (parsed.data.mode === 'live') {
      const credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      try {
        const account = await crossExGateway.queryAccount(credentials);
        const verifiedAt = new Date().toISOString();
        const existing = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);
        const provider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE) ?? credentialVault.provider;
        upsertCredentialMetadata(database, {
          id: DEFAULT_CREDENTIAL_PROFILE,
          label: existing?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
          provider,
          createdAt: existing?.createdAt ?? verifiedAt,
          lastVerifiedAt: verifiedAt,
        });
        addAuditEvent(database, 'live_mode_credential_verified', {
          profile: DEFAULT_CREDENTIAL_PROFILE,
          accountMode: account.account_mode,
        });
        await strategyEngine.prepareForLiveActivation();
      } catch (error) {
        if (error instanceof StrategyEngineError || error instanceof TradingRuntimeError) {
          return reply.code(error.statusCode).send({ error: error.code, ...(error.label ? { label: error.label } : {}) });
        }
        const reason = error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR';
        request.log.warn({ reason }, 'live-mode credential verification failed');
        return reply.code(502).send({ error: 'credential_verification_failed' });
      }
    }

    // Lock first so no new order can pass createOrder while cancellation/quiescence is running.
    const mode = tradingSession.set(parsed.data.mode);
    let unresolvedOrderIds: string[] = [];
    if (mode === 'readonly') {
      const unresolved = await strategyEngine.suspendForTradingLock();
      unresolvedOrderIds = unresolved.map(({ order }) => order.id);
    } else {
      strategyEngine.activatePersistedStrategies();
    }
    if (mode !== previous) {
      addAuditEvent(database, 'trading_mode_changed', {
        from: previous,
        to: mode,
        disclaimerAccepted: parsed.data.acceptDisclaimer,
        unresolvedOrderCount: unresolvedOrderIds.length,
      });
      request.log.info({ from: previous, to: mode, unresolvedOrderCount: unresolvedOrderIds.length }, 'trading mode changed');
    }
    if (unresolvedOrderIds.length > 0) {
      return reply.code(202).send({
        mode,
        warning: 'readonly_quiesce_incomplete',
        unresolvedOrderIds,
      });
    }
    return { mode };
  });

  app.get('/api/preferences', async (): Promise<UserPreferencesResponse> => ({ preferences: readUserPreferences(database) }));

  app.put('/api/preferences', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = UserPreferencesSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_preferences' });
    saveUserPreferences(database, parsed.data);
    return { preferences: readUserPreferences(database) };
  });

  app.get('/api/markets', async () => marketHub.snapshot());

  app.get('/api/trading/snapshot', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async () => tradingRuntime.snapshot());

  app.get('/api/v1/risk/execution-policy', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async () => ({ policy: executionRisk.read() }));

  app.put('/api/v1/risk/execution-policy', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: requireCloudRoles(['admin']),
  }, async (request, reply) => {
    const parsed = ExecutionRiskPolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_execution_risk_policy' });
    const actor = cloudPrincipals.get(request);
    const policy = executionRisk.update(parsed.data, actor?.userId ?? 'local-admin');
    addAuditEvent(database, 'execution_risk_policy_changed', {
      actorUserId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      accountId: actor?.accountId ?? null,
      killSwitch: policy.killSwitch,
      closeOnly: policy.closeOnly,
      allowedSymbolCount: policy.allowedSymbols.length,
    });
    return { policy };
  });

  app.post('/api/v1/trading/order-previews', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: [requireCloudRoles(['planner', 'admin']), async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'preview-order') {
        return reply.code(403).send({ error: 'missing_preview_intent' });
      }
    }],
  }, async (request, reply) => {
    try {
      const actor = cloudPrincipals.get(request);
      const preview = orderConfirmations.create(request.body, new Date(), actor ? {
        accountId: actor.accountId,
        creatorUserId: actor.userId,
      } : undefined);
      addAuditEvent(database, 'order_preview_created', {
        previewId: preview.previewId,
        actorUserId: actor?.userId ?? null,
        actorRole: actor?.role ?? null,
        requestHash: preview.requestHash,
        symbol: preview.canonicalOrder.symbol,
        side: preview.canonicalOrder.side,
        executionAllowed: false,
      });
      return reply.code(201).send(preview);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'invalid_order_preview',
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      request.log.error({ error }, 'order preview failed');
      return reply.code(500).send({ error: 'order_preview_failed' });
    }
  });

  app.post('/api/v1/strategies/target-state-previews', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [requireCloudRoles(['planner', 'admin']), async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'preview-target-state') {
        return reply.code(403).send({ error: 'missing_preview_intent' });
      }
    }],
  }, async (request, reply) => {
    try {
      const preview = buildTargetStatePreview(request.body);
      addAuditEvent(database, 'target_state_preview_created', {
        previewId: preview.previewId,
        requestHash: preview.requestHash,
        targetCount: preview.targets.length,
        executionAllowed: false,
      });
      return reply.code(201).send(preview);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'invalid_target_state',
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      request.log.error({ error }, 'target-state preview failed');
      return reply.code(500).send({ error: 'target_state_preview_failed' });
    }
  });

  app.post('/api/v1/strategies/target-shadow-plans', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [requireCloudRoles(['planner', 'admin']), async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'shadow-target-state') {
        return reply.code(403).send({ error: 'missing_shadow_intent' });
      }
    }],
  }, async (request, reply) => {
    try {
      const actor = cloudPrincipals.get(request);
      if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
      const result = targetShadowPlans.create(request.body, actor.accountId, actor.userId);
      const plan = result.plan;
      addAuditEvent(database, result.reused ? 'target_shadow_plan_reused' : 'target_shadow_plan_created', {
        planId: plan.planId, accountId: actor.accountId, actorUserId: actor.userId,
        requestHash: plan.requestHash, positionFingerprint: plan.positionFingerprint,
        planFingerprint: plan.planFingerprint, actionCount: plan.actions.length, executionAllowed: false,
      });
      return reply.code(result.reused ? 200 : 201).send({ ...plan, reused: result.reused });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_target_state', issues: error.issues });
      if (error instanceof TargetShadowPlanError) return reply.code(409).send({ error: error.code });
      request.log.error({ error }, 'target shadow plan failed');
      return reply.code(500).send({ error: 'target_shadow_plan_failed' });
    }
  });

  app.get('/api/v1/strategies/target-shadow-plans', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    return { plans: targetShadowPlans.list(actor.accountId) };
  });

  app.get('/api/v1/strategies/target-shadow-plans/:planId', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    const parsed = z.object({ planId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_shadow_plan_id' });
    const plan = targetShadowPlans.get(parsed.data.planId, actor.accountId);
    return plan ?? reply.code(404).send({ error: 'target_shadow_plan_not_found' });
  });

  app.post('/api/v1/strategies/target-shadow-plans/:planId/comparisons', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [requireCloudRoles(['planner', 'admin']), async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'compare-shadow-plan') {
        return reply.code(403).send({ error: 'missing_comparison_intent' });
      }
    }],
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    const params = z.object({ planId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_shadow_comparison' });
    const plan = targetShadowPlans.get(params.data.planId, actor.accountId);
    if (!plan) return reply.code(404).send({ error: 'target_shadow_plan_not_found' });
    try {
      if (!config.bridgeAuditDir) return reply.code(503).send({ error: 'bridge_audit_directory_unconfigured' });
      const latestAudit = readLatestBridgeAudit(config.bridgeAuditDir);
      const result = targetShadowComparisons.create(plan, latestAudit.audit, latestAudit.path, latestAudit.mtimeMs);
      addAuditEvent(database, result.reused ? 'target_shadow_comparison_reused' : 'target_shadow_comparison_created', {
        comparisonId: result.comparison.comparisonId, shadowPlanId: plan.planId, accountId: actor.accountId,
        actorUserId: actor.userId, status: result.comparison.status, confidence: result.comparison.confidence,
        bridgeAuditFingerprint: result.comparison.bridgeAuditFingerprint,
      });
      return reply.code(result.reused ? 200 : 201).send({ ...result.comparison, reused: result.reused });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_bridge_audit', issues: error.issues });
      if (error instanceof Error && ['bridge_audit_unavailable', 'ENOENT'].some(code => error.message.includes(code))) {
        return reply.code(503).send({ error: 'bridge_audit_unavailable' });
      }
      request.log.error({ error }, 'target shadow comparison failed');
      return reply.code(500).send({ error: 'target_shadow_comparison_failed' });
    }
  });

  app.get('/api/v1/strategies/target-shadow-comparisons', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    return { comparisons: targetShadowComparisons.list(actor.accountId) };
  });

  app.get('/api/v1/strategies/target-shadow-acceptance-summary', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    return targetShadowComparisons.summary(actor.accountId);
  });

  app.post('/api/v1/reconciliation/protection-book', {
    preHandler: requireCloudRoles(['planner', 'admin']),
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    if (!protectionReconciliations) return reply.code(503).send({ error: 'protection_book_unconfigured' });
    const result = protectionReconciliations.create(actor.accountId);
    addAuditEvent(database, result.reused ? 'protection_reconciliation_reused' : 'protection_reconciliation_created', {
      reconciliationId: result.report.reconciliationId, accountId: actor.accountId, actorUserId: actor.userId,
      status: result.report.status, confidence: result.report.confidence,
    });
    return reply.code(result.reused ? 200 : 201).send({ ...result.report, reused: result.reused });
  });

  app.get('/api/v1/reconciliation/protection-book', {
    preHandler: requireCloudRoles(['viewer', 'planner', 'approver', 'admin', 'auditor']),
  }, async (request, reply) => {
    const actor = cloudPrincipals.get(request);
    if (!actor) return reply.code(401).send({ error: 'cloud_identity_required' });
    if (!protectionReconciliations) return reply.code(503).send({ error: 'protection_book_unconfigured' });
    return { reconciliations: protectionReconciliations.list(actor.accountId) };
  });

  app.get('/api/trading/leverage/:symbol', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'leverage') return reply.code(403).send({ error: 'missing_read_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ symbol: z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_leverage_symbol' });
    const tradingGateway = crossExGateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryLeverages) return reply.code(503).send({ error: 'leverage_unavailable' });
    try {
      const credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const leverages = await tradingGateway.queryLeverages(credentials, [parsed.data.symbol]);
      return { symbol: parsed.data.symbol, leverage: leverages[parsed.data.symbol] ?? null };
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'leverage query failed');
      return reply.code(502).send({ error: 'leverage_unavailable' });
    }
  });

  app.post('/api/trading/leverage/:symbol', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'set-leverage') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    if (config.executionMode !== 'live' || !config.allowLiveWrites) {
      addAuditEvent(database, 'live_execution_denied', { action: 'set_leverage', reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    const params = z.object({ symbol: z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/) }).safeParse(request.params);
    const body = z.object({ leverage: z.string().regex(/^(?:[1-9]\d*)(?:\.\d+)?$/).refine((value) => Number(value) <= 200) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_leverage' });
    if (!tradingSession.liveTradingEnabled) return reply.code(403).send({ error: 'live_trading_locked' });
    const tradingGateway = crossExGateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.setLeverage) return reply.code(503).send({ error: 'leverage_unavailable' });
    try {
      const credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const result = await tradingGateway.setLeverage(credentials, params.data.symbol, body.data.leverage);
      addAuditEvent(database, 'leverage_changed', { symbol: result.symbol, leverage: result.leverage });
      request.log.info({ symbol: result.symbol, leverage: result.leverage }, 'leverage changed');
      return result;
    } catch (error) {
      if (error instanceof GateApiError) return reply.code(error.statusCode >= 400 && error.statusCode < 500 ? 400 : 502).send({ error: 'leverage_rejected', label: error.label });
      request.log.error({ error }, 'leverage update failed');
      return reply.code(500).send({ error: 'leverage_update_failed' });
    }
  });

  app.post('/api/v1/trading/order-previews/:previewId/confirm', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [requireCloudRoles(['approver', 'admin']), async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'confirm-order') {
        return reply.code(403).send({ error: 'missing_confirmation_intent' });
      }
    }],
  }, async (request, reply) => {
    if (config.executionMode !== 'live' || !config.allowLiveWrites) {
      addAuditEvent(database, 'live_execution_denied', { action: 'confirm_order', reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    const params = z.object({ previewId: z.string().uuid() }).safeParse(request.params);
    const idempotencyKey = request.headers['idempotency-key'];
    if (!params.success || typeof idempotencyKey !== 'string') {
      return reply.code(400).send({ error: 'invalid_order_confirmation' });
    }
    try {
      const actor = cloudPrincipals.get(request);
      const order = await orderConfirmations.confirm(params.data.previewId, idempotencyKey, tradingRuntime,
        new Date(), actor ? {
          accountId: actor.accountId,
          approverUserId: actor.userId,
          enforceSeparation: true,
          assertOrderAllowed: (canonicalOrder, accountId) => executionRisk.assertOrderAllowed(canonicalOrder, accountId),
          reserveDailyNotional: (reservationId, sourceType, canonicalOrder, accountId, now) =>
            executionRisk.reserveDailyNotional(reservationId, sourceType, canonicalOrder, accountId, now),
        } : undefined);
      addAuditEvent(database, 'order_preview_confirmed', {
        previewId: params.data.previewId,
        actorUserId: actor?.userId ?? null,
        actorRole: actor?.role ?? null,
        executionOrderId: order.id,
        clientOrderId: order.clientOrderId,
      });
      return order;
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_idempotency_key' });
      if (error instanceof OrderConfirmationError || error instanceof ExecutionRiskError) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) return reply.code(error.statusCode > 0 ? 502 : 503).send({ error: 'gate_order_rejected', label: error.label });
      request.log.error({ error }, 'order confirmation failed');
      return reply.code(500).send({ error: 'order_confirmation_failed' });
    }
  });

  app.post('/api/trading/orders', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'place-order') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    if (config.deploymentMode === 'cloud') {
      return reply.code(428).send({
        error: 'order_preview_required',
        previewEndpoint: '/api/v1/trading/order-previews',
      });
    }
    if (config.executionMode !== 'live' || !config.allowLiveWrites) {
      addAuditEvent(database, 'live_execution_denied', { action: 'create_order', reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    try {
      return await tradingRuntime.createOrder(request.body);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_order', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) return reply.code(error.statusCode > 0 ? 502 : 503).send({ error: 'gate_order_rejected', label: error.label });
      request.log.error({ error }, 'order submission failed');
      return reply.code(500).send({ error: 'order_submission_failed' });
    }
  });

  app.delete('/api/trading/orders/:id', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'cancel-order') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    if (config.executionMode !== 'live' || !config.allowLiveWrites) {
      addAuditEvent(database, 'live_execution_denied', { action: 'cancel_order', reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_order_id' });
    try { return await tradingRuntime.cancelOrder(parsed.data.id); }
    catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof GateApiError) return reply.code(502).send({ error: 'gate_cancel_rejected', label: error.label });
      return reply.code(500).send({ error: 'order_cancel_failed' });
    }
  });

  app.get('/api/strategies', async () => ({ strategies: tradingRuntime.listStrategies() }));

  app.post('/api/strategies', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'start-strategy') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    if (config.executionMode !== 'live' || !config.allowLiveWrites) {
      addAuditEvent(database, 'live_execution_denied', { action: 'start_strategy', reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    try {
      // Strategy submission is an execution boundary: load exchange constraints here even when a
      // direct API client has not visited the instrument pages first.
      if (tradingSession.liveTradingEnabled && !readInstrumentCatalog(database)) {
        try { await fetchInstrumentCatalog(); }
        catch (error) {
          request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'strategy instrument preflight failed');
          return reply.code(503).send({ error: 'strategy_instrument_constraints_unavailable' });
        }
      }
      return await strategyEngine.startStrategy(request.body);
    }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_strategy', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error instanceof TradingRuntimeError) {
        if (error.label) request.log.warn({ code: error.code, label: error.label }, 'strategy start rejected by upstream');
        return reply.code(error.statusCode).send({ error: error.code, ...(error.label ? { label: error.label } : {}) });
      }
      request.log.error({ error }, 'strategy start failed');
      return reply.code(500).send({ error: 'strategy_start_failed' });
    }
  });

  app.post('/api/strategies/:id/stop', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'stop-strategy') return reply.code(403).send({ error: 'missing_trading_intent' });
    },
  }, async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    try { return await strategyEngine.stopStrategy(parsed.data.id); }
    catch (error) {
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(500).send({ error: 'strategy_stop_failed' });
    }
  });

  app.patch('/api/strategies/:id/take-profit', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'update-strategy-take-profit') {
        return reply.code(403).send({ error: 'missing_trading_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    try { return await strategyEngine.updatePremiumTakeProfit(parsed.data.id, request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_take_profit', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error instanceof TradingRuntimeError) return reply.code(error.statusCode).send({ error: error.code });
      request.log.error({ error }, 'strategy take-profit update failed');
      return reply.code(500).send({ error: 'strategy_take_profit_update_failed' });
    }
  });

  app.get('/api/strategies/:id/logs', async (request, reply) => {
    const parsed = z.object({ id: z.string().regex(STRATEGY_ID) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_strategy_id' });
    return { logs: tradingRuntime.strategyLogs(parsed.data.id) };
  });

  const MarketWatchSymbolSchema = z.string().regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/);
  const WatchMessageSchema = z.union([
    z.object({
      type: z.literal('watch.quotes'),
      symbols: z.array(MarketWatchSymbolSchema).max(20),
    }),
    z.object({
      type: z.literal('watch.market'),
      symbol: MarketWatchSymbolSchema,
      interval: z.enum(CANDLE_INTERVALS),
    }),
    z.object({ type: z.literal('watch.clear') }),
  ]);

  app.get('/ws/stream', { websocket: true }, (socket) => {
    const safeSend = (message: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      const type = typeof message === 'object' && message !== null && 'type' in message
        ? String((message as { type: unknown }).type)
        : '';
      const volatile = type.startsWith('market.')
        || type.startsWith('orderbook.')
        || type.startsWith('trade.')
        || type.startsWith('kline.');
      // A background tab can stop draining its socket. Coalesce/drop replaceable market data
      // before it consumes unbounded memory; critical account/execution state is retained unless
      // the connection is so far behind that a clean reconnect is safer.
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.terminate();
        return;
      }
      if (volatile && socket.bufferedAmount > 512 * 1024) return;
      socket.send(JSON.stringify(message));
    };
    const marketBatch = new Map<string, MarketHubMessage & { type: 'market.update' }>();
    let marketBatchTimer: ReturnType<typeof setTimeout> | null = null;
    let marketSymbols = new Set<string>();
    const tradeBatch: Array<Extract<MarketHubMessage, { type: 'trade.update' }>['payload']['trade']> = [];
    let tradeBatchSymbol: string | null = null;
    let tradeBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const klineBatch = new Map<string, Extract<MarketHubMessage, { type: 'kline.update' }>>();
    let klineBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const flushMarketBatch = () => {
      marketBatchTimer = null;
      if (marketBatch.size === 0) return;
      const markets = [...marketBatch.values()].map((message) => message.payload);
      marketBatch.clear();
      safeSend({ type: 'market.batch', payload: { markets } });
    };
    const queueMarketUpdate = (message: MarketHubMessage & { type: 'market.update' }) => {
      marketBatch.set(message.payload.symbol, message);
      if (marketBatchTimer) return;
      marketBatchTimer = setTimeout(flushMarketBatch, 250);
      marketBatchTimer.unref?.();
    };
    const clearMarketBatch = () => {
      if (marketBatchTimer) clearTimeout(marketBatchTimer);
      marketBatchTimer = null;
      marketBatch.clear();
    };
    const flushTradeBatch = () => {
      if (tradeBatchTimer) clearTimeout(tradeBatchTimer);
      tradeBatchTimer = null;
      const symbol = tradeBatchSymbol;
      const trades = tradeBatch.splice(0);
      tradeBatchSymbol = null;
      if (!symbol || trades.length === 0) return;
      safeSend({ type: 'trade.batch', payload: { symbol, trades } });
    };
    const queueTradeUpdate = (message: Extract<MarketHubMessage, { type: 'trade.update' }>) => {
      if (tradeBatchSymbol !== message.payload.symbol) {
        flushTradeBatch();
        tradeBatchSymbol = message.payload.symbol;
      }
      tradeBatch.push(message.payload.trade);
      if (tradeBatch.length > MAX_STREAM_TRADE_BATCH) tradeBatch.splice(0, tradeBatch.length - MAX_STREAM_TRADE_BATCH);
      if (tradeBatchTimer) return;
      tradeBatchTimer = setTimeout(flushTradeBatch, STREAM_VOLATILE_EMIT_INTERVAL_MS);
      tradeBatchTimer.unref?.();
    };
    const flushKlineBatch = () => {
      klineBatchTimer = null;
      const messages = [...klineBatch.values()];
      klineBatch.clear();
      for (const message of messages) safeSend(message);
    };
    const queueKlineUpdate = (message: Extract<MarketHubMessage, { type: 'kline.update' }>) => {
      klineBatch.set(`${message.payload.symbol}:${message.payload.interval}`, message);
      if (klineBatchTimer) return;
      klineBatchTimer = setTimeout(flushKlineBatch, STREAM_VOLATILE_EMIT_INTERVAL_MS);
      klineBatchTimer.unref?.();
    };
    const clearVolatileBatches = () => {
      if (tradeBatchTimer) clearTimeout(tradeBatchTimer);
      if (klineBatchTimer) clearTimeout(klineBatchTimer);
      tradeBatchTimer = null;
      klineBatchTimer = null;
      tradeBatch.length = 0;
      tradeBatchSymbol = null;
      klineBatch.clear();
    };
    // The hub broadcasts book/trade/kline messages for the union of every client's watches, so
    // relay only this connection's watched market: another tab watching a second symbol must not
    // leak into this client's single-slot book state.
    let watched: { symbol: string; interval: CandleInterval } | null = null;
    const scopedSend = (message: MarketHubMessage) => {
      if (message.type === 'market.snapshot') {
        safeSend({ type: 'market.status', payload: {
          connectionState: message.payload.connectionState,
          checkedAt: new Date().toISOString(),
        } });
        if (marketSymbols.size === 0) return;
        safeSend({
          type: 'market.snapshot',
          payload: { ...message.payload, markets: message.payload.markets.filter((market) => marketSymbols.has(market.symbol)) },
        });
        return;
      }
      if (message.type === 'market.update') {
        if (marketSymbols.has(message.payload.symbol)) queueMarketUpdate(message);
        return;
      }
      if (message.type === 'orderbook.update' && message.payload.symbol !== watched?.symbol) return;
      if (message.type === 'trade.update') {
        if (message.payload.symbol === watched?.symbol) queueTradeUpdate(message);
        return;
      }
      if (message.type === 'kline.update') {
        if (message.payload.symbol === watched?.symbol && message.payload.interval === watched?.interval) queueKlineUpdate(message);
        return;
      }
      if (message.type === 'kline.snapshot'
        && (message.payload.symbol !== watched?.symbol || message.payload.interval !== watched?.interval)) return;
      safeSend(message);
    };
    const unsubscribeMarkets = marketHub.subscribe(scopedSend);
    const unsubscribeRuntime = tradingRuntime.subscribe(safeSend);
    const unsubscribePortfolio = livePortfolio.subscribe(safeSend);
    const unsubscribeMode = tradingSession.subscribe(safeSend);
    const statusHeartbeat = setInterval(() => {
      safeSend({ type: 'market.status', payload: {
        connectionState: marketHub.connectionState(),
        checkedAt: new Date().toISOString(),
      } });
    }, STREAM_STATUS_INTERVAL_MS);
    statusHeartbeat.unref?.();
    let watchReleases: Array<() => void> = [];
    const clearWatch = () => { for (const release of watchReleases.splice(0)) release(); };
    safeSend({ type: 'mode.update', payload: { mode: tradingSession.current } });
    safeSend({ type: 'strategy.snapshot', payload: { strategies: tradingRuntime.listStrategies() } });
    safeSend({ type: 'execution.snapshot', payload: tradingRuntime.snapshot() });
    socket.on('message', (raw: { toString(): string }) => {
      let parsedMessage: unknown;
      try { parsedMessage = JSON.parse(raw.toString()); } catch { return; }
      const watch = WatchMessageSchema.safeParse(parsedMessage);
      if (!watch.success) return;
      if (watch.data.type === 'watch.quotes') {
        for (const symbol of watch.data.symbols) ensureMarketKnown(symbol);
        marketSymbols = new Set(watch.data.symbols);
        clearMarketBatch();
        if (marketSymbols.size > 0) {
          const snapshot = marketHub.snapshot();
          safeSend({
            type: 'market.snapshot',
            payload: { ...snapshot, markets: snapshot.markets.filter((market) => marketSymbols.has(market.symbol)) },
          });
        }
        return;
      }
      clearVolatileBatches();
      clearWatch();
      watched = null;
      if (watch.data.type === 'watch.clear') return;
      const { symbol, interval } = watch.data;
      if (!ensureMarketKnown(symbol)) return;
      watched = { symbol, interval };
      watchReleases = [
        marketHub.watchOrderBook(symbol),
        marketHub.watchTrades(symbol),
        marketHub.watchKlines(symbol, interval),
      ];
      const book = marketHub.orderBook(symbol);
      if (book) safeSend({ type: 'orderbook.update', payload: book });
      safeSend({ type: 'trade.snapshot', payload: { symbol, trades: marketHub.recentTrades(symbol) } });
      candleStore.hydrate(symbol, interval);
      safeSend({ type: 'kline.snapshot', payload: { symbol, interval, candles: marketHub.candles(symbol, interval) } });
      // Fetch only the selected timeframe; other intervals backfill when the user requests them.
      candleStore.prefetch(symbol, interval);
    });
    socket.on('close', () => {
      clearWatch();
      clearMarketBatch();
      clearVolatileBatches();
      clearInterval(statusHeartbeat);
      unsubscribeMarkets();
      unsubscribeRuntime();
      unsubscribePortfolio();
      unsubscribeMode();
    });
  });

  app.get('/api/markets/catalog', async (request, reply) => {
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        recordMarketDataFailure(database, 'gate_crossex_instruments', new Date().toISOString(), errorCode);
        request.log.warn({ reason: errorCode }, 'market catalog discovery failed');
      }
      if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    } else if (Date.now() - Date.parse(catalog.fetchedAt) > MARKET_CATALOG_FRESH_MS) {
      // Serve the cached list instantly; converge in the background for the next request.
      void fetchInstrumentCatalog().catch((error: unknown) => {
        request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'market catalog refresh failed');
      });
    }
    const assets: MarketCatalogAsset[] = [...catalog.assets.entries()].map(([asset, venues]) => ({
      asset,
      streamed: marketHub.hasAsset(asset),
      venues,
    }));
    return {
      assets,
      fetchedAt: catalog.fetchedAt,
      cacheStatus: Date.now() - Date.parse(catalog.fetchedAt) <= MARKET_CATALOG_FRESH_MS ? 'fresh' : 'stale',
    } satisfies MarketCatalogResponse;
  });

  app.get('/api/markets/funding-overview', async (request, reply) => {
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        recordMarketDataFailure(database, 'gate_crossex_instruments', new Date().toISOString(), errorCode);
        request.log.warn({ reason: errorCode }, 'funding overview catalog discovery failed');
      }
      if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    } else if (Date.now() - Date.parse(catalog.fetchedAt) > MARKET_CATALOG_FRESH_MS) {
      void fetchInstrumentCatalog().catch((error: unknown) => {
        request.log.warn({ reason: error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR' }, 'market catalog refresh failed');
      });
    }
    await fundingOverviewService.ensureFresh();
    return fundingOverviewService.buildResponse(catalog) satisfies FundingOverviewResponse;
  });

  app.post('/api/markets/funding-history', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-history') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingHistoryRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_history_request' });
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const reason = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        request.log.warn({ reason }, 'funding history catalog discovery failed');
      }
    }
    if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    if (parsed.data.symbols.some((symbol) => !catalog?.liveSymbols.has(symbol))) {
      return reply.code(404).send({ error: 'unknown_market_symbol' });
    }
    return fundingHistoryService.loadCachedMany(
      parsed.data.symbols,
      parsed.data.durationDays * 24 * 60 * 60_000,
    ) satisfies FundingHistoryResponse;
  });

  app.post('/api/markets/funding-rankings', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-history') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingRankingRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_ranking_request' });
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const reason = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        request.log.warn({ reason }, 'funding ranking catalog discovery failed');
      }
    }
    if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    if (parsed.data.symbols.some((symbol) => !catalog?.liveSymbols.has(symbol))) {
      return reply.code(404).send({ error: 'unknown_market_symbol' });
    }
    return fundingHistoryService.loadRankingSnapshot(
      parsed.data.symbols,
      parsed.data.durationDays * 24 * 60 * 60_000,
    ) satisfies FundingHistoryResponse;
  });

  app.post('/api/markets/funding-history/series', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-history') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingHistorySeriesRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_history_series_request' });
    let catalog = derivedMarketCatalog();
    if (!catalog) {
      try {
        await fetchInstrumentCatalog();
        catalog = derivedMarketCatalog();
      } catch (error) {
        const reason = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
        request.log.warn({ reason }, 'funding history series catalog discovery failed');
      }
    }
    if (!catalog) return reply.code(502).send({ error: 'market_catalog_unavailable' });
    if (parsed.data.symbols.some((symbol) => !catalog?.liveSymbols.has(symbol))) {
      return reply.code(404).send({ error: 'unknown_market_symbol' });
    }
    return await fundingHistoryService.loadSeries(
      parsed.data.symbols,
      parsed.data.durationDays * 24 * 60 * 60_000,
    ) satisfies FundingHistorySeriesResponse;
  });

  app.get('/api/markets/:symbol/candles', async (request, reply) => {
    const params = z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/) }).safeParse(request.params);
    const query = z.object({
      interval: z.enum(CANDLE_INTERVALS).default('1m'),
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(30).max(500).default(300),
      fresh: z.literal('1').optional(),
    }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_candle_request' });
    const symbol = params.data.symbol;
    const interval: CandleInterval = query.data.interval;
    if (!ensureMarketKnown(symbol)) return reply.code(404).send({ error: 'unknown_market_symbol' });

    if (query.data.before !== undefined) {
      const candles = await candleStore.loadBefore(symbol, interval, query.data.before, query.data.limit);
      if (candles === null) return reply.code(502).send({ error: 'candle_history_unavailable' });
      return {
        symbol,
        interval,
        candles,
        source: candleStore.canBackfill(symbol) ? 'venue_public_rest_and_crossex_websocket' : 'crossex_websocket_only',
        building: false,
        hasMore: candles.length >= query.data.limit,
      } satisfies CandleSeriesResponse;
    }

    candleStore.hydrate(symbol, interval);
    let candles = marketHub.candles(symbol, interval);
    if (candleStore.canBackfill(symbol) && !candleStore.backfilledRecently(symbol, interval)) {
      const refresh = candleStore.refresh(symbol, interval);
      if (candles.length === 0 || query.data.fresh === '1') {
        // A chart switching to this key opts into one stable first paint: wait for the current
        // venue page instead of returning persisted candles and replacing them moments later.
        await refresh;
        candles = marketHub.candles(symbol, interval);
      }
      // Otherwise the cached series ships now; watchers receive a kline.snapshot push when the
      // background refresh lands.
    }
    return {
      symbol,
      interval,
      candles,
      source: candleStore.hasVenueHistory(symbol, interval) ? 'venue_public_rest_and_crossex_websocket' : 'crossex_websocket_only',
      building: candles.length < 30,
      // A short persisted/live series can be returned while its latest venue refresh is still
      // running. Keep history loading eligible until a completed refresh proves the page short.
      hasMore: candleStore.canBackfill(symbol) && candles.length > 0
        && (!candleStore.backfilledRecently(symbol, interval) || candles.length >= query.data.limit),
    } satisfies CandleSeriesResponse;
  });

  // Public book/trade streams are venue-native: contract counts on GATE and OKX, base-coin
  // quantities on the other venues (verified against live feed magnitudes, 2026-07-22). This maps
  // each futures symbol to base-units-per-feed-unit so the UI can label real coin amounts.
  app.get('/api/markets/size-units', async (request) => {
    const cached = sizeUnitCache;
    // A dynamically registered market invalidates the cache (count changes) so its symbols get mapped.
    if (cached && cached.complete && cached.marketCount === marketHub.snapshot().markets.length
      && Date.now() - Date.parse(cached.fetchedAt) < MARKET_REFERENCE_CACHE_MS) {
      return { units: cached.units, fetchedAt: cached.fetchedAt };
    }
    if (!sizeUnitInFlight) {
      sizeUnitInFlight = (async () => {
        const markets = marketHub.snapshot().markets;
        const units: Record<string, string> = {};
        for (const market of markets) {
          if (market.venue !== 'GATE' && market.venue !== 'OKX') units[market.symbol] = '1';
        }
        let complete = true;
        for (const venue of ['GATE', 'OKX'] as const) {
          try {
            const sizes = await publicMarketGateway.queryContractSizes?.(venue) ?? [];
            const byPair = new Map(sizes.map((size) => [`${size.base}_${size.quote}`, size.multiplier]));
            for (const market of markets) {
              if (market.venue !== venue) continue;
              const quote = market.symbol.split('_')[3] ?? '';
              const multiplier = byPair.get(`${market.asset}_${quote}`);
              if (multiplier && /^\d+(?:\.\d+)?$/.test(multiplier) && Number(multiplier) > 0) {
                units[market.symbol] = multiplier;
              }
            }
          } catch (error) {
            // A failed venue fetch leaves its symbols unmapped; the UI then shows raw feed sizes.
            complete = false;
            const errorCode = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
            request.log.warn({ venue, reason: errorCode }, 'contract size fetch failed');
          }
        }
        sizeUnitCache = { units, fetchedAt: new Date().toISOString(), complete, marketCount: markets.length };
      })().finally(() => { sizeUnitInFlight = null; });
    }
    await sizeUnitInFlight;
    const latest = sizeUnitCache;
    return latest ? { units: latest.units, fetchedAt: latest.fetchedAt } : { units: {}, fetchedAt: new Date().toISOString() };
  });

  app.get('/api/crossex/fees', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'fee-rates') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    if (feeCache && Date.now() - Date.parse(feeCache.fetchedAt) < 10 * 60_000) {
      return { fees: feeCache.fees, fetchedAt: feeCache.fetchedAt, cacheStatus: 'fresh' } satisfies VenueFeeRatesResponse;
    }
    const tradingGateway = crossExGateway as Partial<TradingCrossExGateway>;
    if (!tradingGateway.queryFeeRates) return reply.code(503).send({ error: 'fee_rates_unavailable' });
    try {
      feeFetchInFlight ??= (async () => {
        let credentials: GateCredentials | null = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
        try {
          if (!credentials) throw new TradingRuntimeError('credential_not_configured', 409);
          const rates = await tradingGateway.queryFeeRates!(credentials);
          const fetchedAt = new Date().toISOString();
          const fees = rates.map((rate) => ({
            venue: rate.exchange_type, spotMakerFee: rate.spot_maker_fee, spotTakerFee: rate.spot_taker_fee,
            futureMakerFee: rate.future_maker_fee, futureTakerFee: rate.future_taker_fee,
          }));
          feeCache = { fees, fetchedAt };
          return { fees, fetchedAt };
        } finally {
          credentials = null;
        }
      })().finally(() => { feeFetchInFlight = null; });
      const refreshed = await feeFetchInFlight;
      return { ...refreshed, cacheStatus: 'fresh' } satisfies VenueFeeRatesResponse;
    } catch (error) {
      if (error instanceof TradingRuntimeError && error.code === 'credential_not_configured') {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'fee rate refresh failed');
      if (feeCache) return { fees: feeCache.fees, fetchedAt: feeCache.fetchedAt, cacheStatus: 'stale' } satisfies VenueFeeRatesResponse;
      return reply.code(502).send({ error: 'fee_rates_unavailable' });
    }
  });

  app.get('/api/crossex/transfer-coins', async (request, reply) => {
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryTransferCoins) {
      return reply.code(503).send({ error: 'transfer_coins_unavailable' });
    }
    try {
      return { ...(await fetchTransferCoins()), cacheStatus: 'fresh' } satisfies CrossExTransferCoinsResponse;
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'TRANSFER_COIN_ERROR' }, 'transfer coin query failed');
      if (transferCoinCache) return { ...transferCoinCache, cacheStatus: 'stale' } satisfies CrossExTransferCoinsResponse;
      return reply.code(502).send({ error: 'transfer_coins_unavailable' });
    }
  });

  app.get('/api/crossex/transfer-balances', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'transfer-balances') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryAccount || !operationsGateway.querySpotAccounts) {
      return reply.code(503).send({ error: 'transfer_balances_unavailable' });
    }
    let credentials: GateCredentials | null = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
    try {
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const [account, spotAccounts] = await Promise.all([
        operationsGateway.queryAccount(credentials),
        operationsGateway.querySpotAccounts(credentials),
      ]);
      const balances = new Map<string, CrossExTransferBalancesResponse['items'][number]>();
      const addBalance = (transferAccount: unknown, coin: string, available: string) => {
        const parsedAccount = CrossExTransferAccountSchema.safeParse(transferAccount);
        if (!parsedAccount.success || !coin || !/^\d+(?:\.\d+)?$/.test(available)) return;
        balances.set(`${parsedAccount.data}:${coin}`, { account: parsedAccount.data, coin, available });
      };
      for (const spot of spotAccounts) addBalance('SPOT', spot.currency, spot.available);
      for (const asset of account.assets) {
        const exchange = asset.exchange_type.toUpperCase();
        addBalance(exchange === 'CROSSEX' ? 'CROSSEX' : `CROSSEX_${exchange}`, asset.coin, asset.available_balance);
      }
      addBalance('CROSSEX', 'USDT', account.available_margin);
      return {
        items: [...balances.values()].sort((left, right) => left.account.localeCompare(right.account) || left.coin.localeCompare(right.coin)),
        fetchedAt: new Date().toISOString(),
      } satisfies CrossExTransferBalancesResponse;
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'transfer balance query failed');
      return reply.code(502).send({ error: 'transfer_balances_unavailable' });
    } finally {
      credentials = null;
    }
  });

  app.get('/api/crossex/portfolio-activity', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'portfolio-activity') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = z.object({
      coin: z.string().trim().regex(/^[A-Z0-9]{1,20}$/).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_portfolio_activity_query' });
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.queryTransfers || !operationsGateway.queryAccountBook) {
      return reply.code(503).send({ error: 'portfolio_activity_unavailable' });
    }

    let credentials: GateCredentials | null = null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      const [transfers, accountBook, fundingFees] = await Promise.all([
        operationsGateway.queryTransfers(credentials, parsed.data),
        operationsGateway.queryAccountBook(credentials, parsed.data),
        operationsGateway.queryAccountBook(credentials, {
          ...parsed.data,
          statementType: 'FUNDING_FEE',
        }),
      ]);
      return {
        transfers: normalizeTransferRecords(transfers),
        accountBook: normalizeAccountBook(accountBook),
        fundingFees: normalizeAccountBook(fundingFees),
        fetchedAt: new Date().toISOString(),
      } satisfies CrossExPortfolioActivityResponse;
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'portfolio activity query failed');
      return reply.code(502).send({ error: 'portfolio_activity_unavailable' });
    } finally {
      credentials = null;
    }
  });

  app.post('/api/crossex/transfers', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'transfer-funds') {
        return reply.code(403).send({ error: 'missing_trading_intent' });
      }
    },
  }, async (request, reply) => {
    if (config.executionMode !== 'live' || !config.allowLiveWrites) {
      addAuditEvent(database, 'live_execution_denied', { action: 'transfer_funds', reason: 'preview_only_mode' });
      return reply.code(403).send({ error: 'live_execution_disabled' });
    }
    const parsed = CrossExTransferRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_transfer' });
    if (!tradingSession.liveTradingEnabled) return reply.code(403).send({ error: 'live_trading_locked' });
    const operationsGateway = crossExGateway as Partial<PortfolioOperationsCrossExGateway>;
    if (!operationsGateway.createTransfer || !operationsGateway.queryAccount || !operationsGateway.queryTransferCoins) {
      return reply.code(503).send({ error: 'transfers_unavailable' });
    }

    let credentials: GateCredentials | null = null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_not_configured' });
      if (parsed.data.from === 'SPOT' && !operationsGateway.querySpotAccounts) {
        return reply.code(503).send({ error: 'transfer_balances_unavailable' });
      }
      const [account, transferCoins, spotAccounts] = await Promise.all([
        operationsGateway.queryAccount(credentials),
        fetchTransferCoins(),
        parsed.data.from === 'SPOT' ? operationsGateway.querySpotAccounts!(credentials) : Promise.resolve(null),
      ]);
      const routeError = crossExTransferRouteError(parsed.data, account.account_mode);
      if (routeError) return reply.code(400).send({ error: 'invalid_transfer_route', label: routeError });
      const canonicalTransfer = canonicalizeCrossExTransfer(parsed.data, account.account_mode);

      const coinRule = transferCoins.items.find((coin) => coin.coin === parsed.data.coin);
      if (!coinRule || coinRule.disabled) {
        return reply.code(400).send({ error: 'unsupported_transfer_coin', label: coinRule?.disabled ? 'TRANSFER_COIN_DISABLED' : 'TRANSFER_COIN_UNSUPPORTED' });
      }
      const amount = new Decimal(parsed.data.amount);
      if (amount.lt(coinRule.minimumAmount)) {
        return reply.code(400).send({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_BELOW_MINIMUM' });
      }
      if (amount.decimalPlaces() > coinRule.precision) {
        return reply.code(400).send({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_PRECISION_EXCEEDED' });
      }

      let sourceAvailable: string | null = null;
      if (canonicalTransfer.from === 'SPOT') {
        sourceAvailable = spotAccounts?.find((balance) => balance.currency === canonicalTransfer.coin)?.available ?? null;
      } else if (canonicalTransfer.from === 'CROSSEX') {
        sourceAvailable = canonicalTransfer.coin === 'USDT' ? account.available_margin : null;
      } else {
        const exchange = canonicalTransfer.from.slice('CROSSEX_'.length);
        sourceAvailable = account.assets.find((asset) => asset.exchange_type === exchange && asset.coin === canonicalTransfer.coin)?.available_balance ?? null;
      }
      if (sourceAvailable === null) return reply.code(409).send({ error: 'source_balance_unavailable' });
      if (amount.gt(sourceAvailable)) {
        return reply.code(400).send({ error: 'invalid_transfer_amount', label: 'TRANSFER_AMOUNT_EXCEEDS_AVAILABLE' });
      }

      const transfer = await operationsGateway.createTransfer(credentials, canonicalTransfer);
      addAuditEvent(database, 'fund_transfer_submitted', {
        transactionId: transfer.tx_id,
        coin: canonicalTransfer.coin,
        amount: canonicalTransfer.amount,
        from: canonicalTransfer.from,
        to: canonicalTransfer.to,
      });
      request.log.info({ transactionId: transfer.tx_id, coin: canonicalTransfer.coin, from: canonicalTransfer.from, to: canonicalTransfer.to }, 'fund transfer submitted');
      triggerPortfolioRefresh?.();
      return { transactionId: transfer.tx_id, text: transfer.text };
    } catch (error) {
      if (error instanceof GateApiError) {
        if (error.retryAfterMs !== undefined) {
          reply.header('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))));
        }
        const statusCode = error.statusCode === 429 ? 429 : error.statusCode >= 400 && error.statusCode < 500 ? 400 : 502;
        return reply.code(statusCode).send({ error: 'transfer_rejected', label: error.label });
      }
      request.log.error({ error }, 'fund transfer failed');
      return reply.code(500).send({ error: 'transfer_failed' });
    } finally {
      credentials = null;
    }
  });

  app.get('/api/crossex/instruments', async (request, reply) => {
    const now = Date.now();
    const cached = readInstrumentCatalog(database);
    if (cached && isFresh(cached.fetchedAt, now)) {
      const value: CrossExInstrumentCatalog = {
        ...cached,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      };
      return value;
    }

    try {
      const { items, fetchedAt } = await fetchInstrumentCatalog();
      return {
        items,
        fetchedAt,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies CrossExInstrumentCatalog;
    } catch (error) {
      const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
      recordMarketDataFailure(database, 'gate_crossex_instruments', new Date().toISOString(), errorCode);
      request.log.warn({ reason: errorCode }, 'CrossEx instrument discovery failed');
      if (cached) {
        return {
          ...cached,
          source: 'gate_crossex_public_rest',
          cacheStatus: 'stale',
          upstreamStatus: 'unavailable',
        } satisfies CrossExInstrumentCatalog;
      }
      return reply.code(502).send({ error: 'instrument_catalog_unavailable' });
    }
  });

  app.get('/api/crossex/instruments/:symbol/risk-limits', async (request, reply) => {
    const parsed = z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_instrument_symbol' });
    const now = Date.now();
    const cached = readRiskLimit(database, parsed.data.symbol);
    if (cached && isFresh(cached.fetchedAt, now)) {
      return {
        ...cached,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies CrossExRiskLimitResponse;
    }

    try {
      const refreshed = await fetchRiskLimit(parsed.data.symbol);
      if (!refreshed) return reply.code(404).send({ error: 'risk_limits_not_found' });
      return {
        ...refreshed,
        source: 'gate_crossex_public_rest',
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies CrossExRiskLimitResponse;
    } catch (error) {
      const errorCode = error instanceof GateApiError ? error.label : 'PUBLIC_DATA_ERROR';
      recordMarketDataFailure(database, 'gate_crossex_risk_limits', new Date().toISOString(), errorCode);
      request.log.warn({ reason: errorCode, symbol: parsed.data.symbol }, 'CrossEx risk-limit discovery failed');
      if (cached) {
        return {
          ...cached,
          source: 'gate_crossex_public_rest',
          cacheStatus: 'stale',
          upstreamStatus: 'unavailable',
        } satisfies CrossExRiskLimitResponse;
      }
      return reply.code(502).send({ error: 'risk_limits_unavailable' });
    }
  });

  app.get('/api/crossex/instruments/:symbol/market-snapshot', async (request, reply) => {
    const parsed = z.object({ symbol: z.string().regex(/^[A-Z0-9_]{3,120}$/) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_instrument_symbol' });
    if (!/^(BINANCE|GATE|OKX)_FUTURE_/.test(parsed.data.symbol)) {
      return reply.code(422).send({ error: 'public_market_source_not_implemented' });
    }

    const cached = readPublicMarketSnapshot(database, parsed.data.symbol);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < PUBLIC_SNAPSHOT_FRESH_MS) {
      return {
        snapshot: cached,
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies PublicMarketSnapshotResponse;
    }

    try {
      const snapshot = await fetchPublicSnapshot(parsed.data.symbol);
      return {
        snapshot,
        cacheStatus: 'fresh',
        upstreamStatus: 'healthy',
      } satisfies PublicMarketSnapshotResponse;
    } catch (error) {
      const errorCode = error instanceof PublicMarketDataError ? error.code : 'PUBLIC_DATA_ERROR';
      recordMarketDataFailure(database, 'venue_public_market_snapshot', new Date().toISOString(), errorCode);
      request.log.warn({ reason: errorCode, symbol: parsed.data.symbol }, 'public market snapshot failed');
      if (cached) {
        return {
          snapshot: cached,
          cacheStatus: 'stale',
          upstreamStatus: 'unavailable',
        } satisfies PublicMarketSnapshotResponse;
      }
      return reply.code(502).send({ error: 'public_market_snapshot_unavailable' });
    }
  });

  app.get('/api/crossex/account-summary', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'account-summary') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const metadata = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);

    let credentials: GateCredentials | null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_missing_from_vault' });
      const account = await crossExGateway.queryAccount(credentials);
      const verifiedAt = new Date().toISOString();
      const provider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE) ?? credentialVault.provider;
      upsertCredentialMetadata(database, {
        id: DEFAULT_CREDENTIAL_PROFILE,
        label: metadata?.label ?? (provider === 'env_file' ? 'Gate CrossEx (.env)' : 'Gate CrossEx'),
        provider,
        createdAt: metadata?.createdAt ?? verifiedAt,
        lastVerifiedAt: verifiedAt,
      });
      addAuditEvent(database, 'crossex_read_only_account_verified', {
        profile: DEFAULT_CREDENTIAL_PROFILE,
        accountMode: account.account_mode,
        venueCount: new Set(account.assets.map((asset) => asset.exchange_type)).size,
      });
      return summarizeAccount(account, verifiedAt);
    } catch (error) {
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'read-only CrossEx account refresh failed');
      return reply.code(502).send({ error: 'read_only_account_refresh_failed' });
    } finally {
      credentials = null;
    }
  });

  app.get('/api/crossex/portfolio-snapshot', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'portfolio-snapshot') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    try {
      return await refreshPortfolio();
    } catch (error) {
      if (error instanceof TradingRuntimeError && error.code === 'credential_missing_from_vault') {
        return reply.code(409).send({ error: error.code });
      }
      const reason = error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR';
      request.log.warn({ reason }, 'read-only portfolio snapshot failed');
      const cached = livePortfolio.snapshot()?.snapshot ?? readLatestPortfolioSnapshot(database);
      if (cached) {
        const createdAt = new Date().toISOString();
        const reconciliation = stalePortfolioReconciliation(randomUUID(), createdAt, cached);
        saveReconciliationReport(database, reconciliation);
        addAuditEvent(database, 'portfolio_reconciliation_stale', {
          reconciliationStatus: reconciliation.status,
          reconciliationIssueCount: reconciliation.issues.length,
        });
        return livePortfolio.reconcile({
          snapshot: cached,
          dataStatus: 'stale',
          remoteStatus: 'unavailable',
          reconciliation,
        }, 'cache');
      }
      return reply.code(502).send({ error: 'portfolio_snapshot_unavailable' });
    }
  });

  app.get('/api/crossex/positions-snapshot', {
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'positions-snapshot') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    if (positionsRefreshInProgress) return reply.code(409).send({ error: 'positions_refresh_in_progress' });
    positionsRefreshInProgress = true;

    let credentials: GateCredentials | null;
    try {
      credentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      if (!credentials) return reply.code(409).send({ error: 'credential_missing_from_vault' });
      const positions = await crossExGateway.queryPositions(credentials);
      tradingRuntime.reconcileLivePositions(normalizeFuturesPositions(positions));
      return tradingRuntime.snapshot();
    } catch (error) {
      const reason = error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR';
      request.log.warn({ reason }, 'positions snapshot refresh failed');
      return reply.code(502).send({ error: 'positions_snapshot_unavailable' });
    } finally {
      credentials = null;
      positionsRefreshInProgress = false;
    }
  });

  app.get('/api/reconciliation/reports', async (request, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_report_query' });
    try {
      return { reports: listReconciliationReports(database, parsed.data.limit) } satisfies ReconciliationReportList;
    } catch {
      request.log.error({ reason: 'INVALID_RECONCILIATION_REPORT_STORAGE' }, 'stored reconciliation report validation failed');
      return reply.code(500).send({ error: 'reconciliation_reports_unavailable' });
    }
  });

  app.get('/secure/credentials', async (request, reply) => {
    if (config.deploymentMode === 'cloud') return reply.code(404).send({ error: 'credential_entry_unavailable' });
    const liveTradingIntent = hasLiveTradingCredentialIntent(request.query);
    const language = secureCredentialLanguage(request.query);
    const metadata = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);
    const detectedProvider = metadata ? null : await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE);
    return setSecureHtml(reply, renderCredentialEntryPage({
      csrfToken: csrfTokens.issue(),
      configured: metadata !== null || detectedProvider !== null,
      storageAvailable: credentialVault.provider !== 'unavailable',
      storageProviders: selectableStorageProviders,
      configuredStorageProvider: metadata?.provider ?? detectedProvider ?? undefined,
      tradingEnabled: tradingSession.liveTradingEnabled,
      liveTradingIntent,
      language,
    }));
  });

  app.post('/secure/credentials', async (request, reply) => {
    if (config.deploymentMode === 'cloud') return reply.code(404).send({ error: 'credential_entry_unavailable' });
    const parsed = CredentialFormSchema.safeParse(request.body);
    const liveTradingIntent = hasLiveTradingCredentialIntent(request.body);
    const language = secureCredentialLanguage(request.body);
    if (!parsed.success || !csrfTokens.consume(parsed.data.csrfToken)) {
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE) !== null,
        storageAvailable: credentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE)?.provider,
        tradingEnabled: tradingSession.liveTradingEnabled,
        liveTradingIntent,
        language,
        errorMessage: credentialPageMessage(language, 'The form was invalid or expired. Credentials were not stored.', '表单无效或已过期。未存储任何 API 密钥。'),
      }), 400);
    }

    let credentials: GateCredentials | null = {
      apiKey: parsed.data.apiKey,
      apiSecret: parsed.data.apiSecret,
    };
    let previousCredentials: GateCredentials | null = null;
    let previousProvider: CredentialStorageProvider | null = null;
    let vaultMutated = false;
    try {
      await quiesceForCredentialMutation();
      const account = await crossExGateway.queryAccount(credentials);
      const verifiedAt = new Date().toISOString();
      const storageProvider = parsed.data.storageProvider ?? credentialVault.provider;
      previousCredentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      previousProvider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE);
      privateStream.stop();
      await credentialVault.set(DEFAULT_CREDENTIAL_PROFILE, credentials, storageProvider);
      vaultMutated = true;
      try {
        database.transaction(() => {
          const previous = getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);
          upsertCredentialMetadata(database, {
            id: DEFAULT_CREDENTIAL_PROFILE,
            label: parsed.data.label,
            provider: storageProvider,
            createdAt: previous?.createdAt ?? verifiedAt,
            lastVerifiedAt: verifiedAt,
          });
          addAuditEvent(database, 'credential_verified_and_stored', {
            profile: DEFAULT_CREDENTIAL_PROFILE,
            provider: storageProvider,
            accountMode: account.account_mode,
          });
        })();
      } catch (error) {
        if (previousCredentials) {
          await credentialVault.set(DEFAULT_CREDENTIAL_PROFILE, previousCredentials, previousProvider ?? undefined);
        } else {
          await credentialVault.delete(DEFAULT_CREDENTIAL_PROFILE);
        }
        vaultMutated = false;
        throw error;
      }

      invalidateAuthenticatedState();
      privateStream.restart();
      if (options.startMarketStream) triggerPortfolioRefresh?.();
      return setSecureHtml(reply, renderCredentialSuccessPage({
        label: parsed.data.label,
        accountMode: account.account_mode,
        venues: [...new Set(account.assets.map((asset) => asset.exchange_type))].sort(),
        storageProvider,
        liveTradingIntent,
        language,
      }));
    } catch (error) {
      if (vaultMutated) {
        try {
          if (previousCredentials) {
            await credentialVault.set(DEFAULT_CREDENTIAL_PROFILE, previousCredentials, previousProvider ?? undefined);
          } else {
            await credentialVault.delete(DEFAULT_CREDENTIAL_PROFILE);
          }
        } catch (rollbackError) {
          request.log.error({ err: rollbackError }, 'credential rollback failed');
        }
      }
      privateStream.restart();
      request.log.warn({ reason: error instanceof GateApiError ? error.label : 'LOCAL_CREDENTIAL_ERROR' }, 'credential verification failed');
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE) !== null,
        storageAvailable: credentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE)?.provider,
        tradingEnabled: tradingSession.liveTradingEnabled,
        liveTradingIntent,
        language,
        errorMessage: safeCredentialError(error, language),
      }), error instanceof StrategyEngineError || error instanceof TradingRuntimeError
        ? error.statusCode
        : error instanceof GateApiError ? 502 : 500);
    } finally {
      credentials = null;
      previousCredentials = null;
    }
  });

  app.post('/secure/credentials/delete', async (request, reply) => {
    if (config.deploymentMode === 'cloud') return reply.code(404).send({ error: 'credential_entry_unavailable' });
    const parsed = DeleteCredentialFormSchema.safeParse(request.body);
    const language = secureCredentialLanguage(request.body);
    if (!parsed.success || !csrfTokens.consume(parsed.data.csrfToken)) {
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE) !== null,
        storageAvailable: credentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE)?.provider,
        tradingEnabled: tradingSession.liveTradingEnabled,
        language,
        errorMessage: credentialPageMessage(language, 'The delete request was invalid or expired.', '删除请求无效或已过期。'),
      }), 400);
    }

    let previousCredentials: GateCredentials | null = null;
    let previousProvider: CredentialStorageProvider | null = null;
    let vaultDeleted = false;
    try {
      await quiesceForCredentialMutation();
      previousCredentials = await credentialVault.get(DEFAULT_CREDENTIAL_PROFILE);
      previousProvider = await credentialVault.getProvider(DEFAULT_CREDENTIAL_PROFILE);
      privateStream.stop();
      vaultDeleted = await credentialVault.delete(DEFAULT_CREDENTIAL_PROFILE);
      if (previousCredentials && !vaultDeleted) throw new Error('credential_store_reported_no_deletion');
      try {
        database.transaction(() => {
          deleteCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE);
          addAuditEvent(database, 'credential_deleted', { profile: DEFAULT_CREDENTIAL_PROFILE });
        })();
      } catch (error) {
        if (previousCredentials) {
          await credentialVault.set(DEFAULT_CREDENTIAL_PROFILE, previousCredentials, previousProvider ?? undefined);
          vaultDeleted = false;
        }
        throw error;
      }
      invalidateAuthenticatedState();
      privateStream.restart();
      return setSecureHtml(reply, renderCredentialDeletedPage({ language }));
    } catch {
      if (vaultDeleted && previousCredentials) {
        await credentialVault.set(DEFAULT_CREDENTIAL_PROFILE, previousCredentials, previousProvider ?? undefined)
          .catch((rollbackError) => request.log.error({ err: rollbackError }, 'credential delete rollback failed'));
      }
      privateStream.restart();
      return setSecureHtml(reply, renderCredentialEntryPage({
        csrfToken: csrfTokens.issue(),
        configured: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE) !== null,
        storageAvailable: credentialVault.provider !== 'unavailable',
        storageProviders: selectableStorageProviders,
        configuredStorageProvider: getCredentialMetadata(database, DEFAULT_CREDENTIAL_PROFILE)?.provider,
        tradingEnabled: tradingSession.liveTradingEnabled,
        language,
        errorMessage: credentialPageMessage(language, 'The configured credential store could not delete the credential.', '配置的 API 密钥存储无法删除该 API 密钥。'),
      }), 500);
    } finally {
      previousCredentials = null;
    }
  });

  return app;
}

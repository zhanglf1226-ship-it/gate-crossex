import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface BackendConfig {
  deploymentMode: 'local' | 'cloud';
  executionMode: 'preview' | 'live';
  allowLiveWrites: boolean;
  orderConfirmationSecret: string | null;
  cloudBffSecret: string | null;
  cloudAuthMaxSkewMs: number;
  cloudNonceTtlMs: number;
  cloudDefaultAccountId: string | null;
  cloudBootstrapAdminUserId: string | null;
  bridgeAuditDir: string | null;
  protectionBookPath: string | null;
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  credentialEnvPath: string;
  migrationsDir: string;
  frontendDistPath: string;
  allowedOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  gateRestBaseUrl: string;
  gatePublicWebSocketUrl: string;
  gatePrivateWebSocketUrl: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`invalid boolean value: ${value}`);
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  if (environment.GCT_DEPLOYMENT_MODE
    && !['local', 'cloud'].includes(environment.GCT_DEPLOYMENT_MODE)) {
    throw new Error('GCT_DEPLOYMENT_MODE must be local or cloud');
  }
  const deploymentMode = environment.GCT_DEPLOYMENT_MODE === 'cloud' ? 'cloud' : 'local';
  const defaultExecutionMode = deploymentMode === 'cloud' ? 'preview' : 'live';
  const executionMode = environment.GCT_EXECUTION_MODE === 'preview'
    ? 'preview'
    : environment.GCT_EXECUTION_MODE === 'live'
      ? 'live'
      : defaultExecutionMode;
  const allowLiveWrites = parseBoolean(environment.GCT_ALLOW_LIVE_WRITES, deploymentMode === 'local');
  if (deploymentMode === 'cloud' && executionMode === 'live' && !allowLiveWrites) {
    throw new Error('cloud live execution requires GCT_ALLOW_LIVE_WRITES=1');
  }
  const orderConfirmationSecret = environment.GCT_ORDER_CONFIRMATION_SECRET?.trim() || null;
  if (orderConfirmationSecret && orderConfirmationSecret.length < 32) {
    throw new Error('GCT_ORDER_CONFIRMATION_SECRET must contain at least 32 characters');
  }
  if (deploymentMode === 'cloud' && executionMode === 'live' && !orderConfirmationSecret) {
    throw new Error('cloud live execution requires GCT_ORDER_CONFIRMATION_SECRET');
  }
  const cloudBffSecret = environment.GCT_BFF_HMAC_SECRET?.trim() || null;
  if (cloudBffSecret && cloudBffSecret.length < 32) {
    throw new Error('GCT_BFF_HMAC_SECRET must contain at least 32 characters');
  }
  if (deploymentMode === 'cloud' && !cloudBffSecret) {
    throw new Error('cloud deployment requires GCT_BFF_HMAC_SECRET');
  }
  const cloudAuthMaxSkewMs = parsePositiveInteger(environment.GCT_AUTH_MAX_SKEW_MS, 60_000, 'GCT_AUTH_MAX_SKEW_MS');
  const cloudNonceTtlMs = parsePositiveInteger(environment.GCT_NONCE_TTL_MS, 5 * 60_000, 'GCT_NONCE_TTL_MS');
  if (cloudAuthMaxSkewMs > 5 * 60_000 || cloudNonceTtlMs > 60 * 60_000) {
    throw new Error('cloud authentication time windows exceed safe limits');
  }
  if (cloudNonceTtlMs < cloudAuthMaxSkewMs) {
    throw new Error('GCT_NONCE_TTL_MS must be greater than or equal to GCT_AUTH_MAX_SKEW_MS');
  }
  const cloudDefaultAccountId = environment.GCT_CLOUD_ACCOUNT_ID?.trim() || null;
  const cloudBootstrapAdminUserId = environment.GCT_CLOUD_BOOTSTRAP_ADMIN?.trim() || null;
  if (deploymentMode === 'cloud' && (!cloudDefaultAccountId || !cloudBootstrapAdminUserId)) {
    throw new Error('cloud deployment requires GCT_CLOUD_ACCOUNT_ID and GCT_CLOUD_BOOTSTRAP_ADMIN');
  }
  const host = environment.GCT_HOST ?? '127.0.0.1';
  const port = parsePort(environment.PORT ?? environment.GCT_PORT ?? '17840', 'GCT_PORT');
  const frontendPort = parsePort(environment.GCT_FRONTEND_PORT ?? '5173', 'GCT_FRONTEND_PORT');
  const dataDir = resolve(environment.GCT_DATA_DIR ?? join(projectRoot, '.local-data'));
  const configuredHosts = (environment.GCT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const allowedOrigin = environment.GCT_FRONTEND_ORIGIN ?? `http://127.0.0.1:${frontendPort}`;
  // Browsers send the loopback host the user actually typed; localhost, 127.0.0.1, and [::1]
  // variants of the local UI and backend are all the same trust domain.
  const loopbackOrigins = [frontendPort, port].flatMap((loopbackPort) => [
    `http://127.0.0.1:${loopbackPort}`,
    `http://localhost:${loopbackPort}`,
    `http://[::1]:${loopbackPort}`,
  ]);
  return {
    deploymentMode,
    executionMode,
    allowLiveWrites,
    orderConfirmationSecret,
    cloudBffSecret,
    cloudAuthMaxSkewMs,
    cloudNonceTtlMs,
    cloudDefaultAccountId,
    cloudBootstrapAdminUserId,
    bridgeAuditDir: environment.GCT_BRIDGE_AUDIT_DIR?.trim() ? resolve(environment.GCT_BRIDGE_AUDIT_DIR) : null,
    protectionBookPath: environment.GCT_PROTECTION_BOOK_PATH?.trim() && (deploymentMode !== 'cloud' || resolve(environment.GCT_PROTECTION_BOOK_PATH) === '/opt/future/real-trading/runtime/protection_book.json') ? resolve(environment.GCT_PROTECTION_BOOK_PATH) : null,
    host,
    port,
    dataDir,
    databasePath: join(dataDir, 'gate-crossex.sqlite'),
    credentialEnvPath: resolve(environment.GCT_CREDENTIAL_ENV_PATH ?? join(projectRoot, '.env')),
    migrationsDir: resolve(environment.GCT_MIGRATIONS_DIR ?? join(projectRoot, 'migrations')),
    frontendDistPath: resolve(environment.GCT_FRONTEND_DIST_DIR ?? join(projectRoot, 'apps/frontend/dist')),
    allowedOrigin,
    allowedOrigins: new Set([allowedOrigin, ...loopbackOrigins]),
    allowedHosts: new Set(['127.0.0.1', 'localhost', '::1', ...configuredHosts]),
    gateRestBaseUrl: environment.GCT_GATE_REST_URL ?? 'https://api.gateio.ws/api/v4',
    gatePublicWebSocketUrl: environment.GCT_GATE_PUBLIC_WS_URL ?? 'wss://api.gateio.ws/ws/crossex/public',
    gatePrivateWebSocketUrl: environment.GCT_GATE_PRIVATE_WS_URL ?? 'wss://api.gateio.ws/ws/crossex',
  };
}

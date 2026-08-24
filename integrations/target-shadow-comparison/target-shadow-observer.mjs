import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function signedHeaders(secret, method, path, body, identity, intent) {
  const bodyText = body === undefined ? '' : canonicalJson(body);
  const bodyHash = createHash('sha256').update(bodyText).digest('hex');
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString('base64url');
  const material = ['GCT1', method, path, identity.userId, identity.role, identity.accountId, timestamp, nonce, bodyHash].join('\n');
  return {
    'x-gct-user-id': identity.userId,
    'x-gct-role': identity.role,
    'x-gct-account-id': identity.accountId,
    'x-gct-request-timestamp': timestamp,
    'x-gct-nonce': nonce,
    'x-gct-body-sha256': bodyHash,
    'x-gct-signature': createHmac('sha256', secret).update(material).digest('base64url'),
    'x-gct-trading-intent': intent,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
}

async function latestAudit(directory) {
  const entries = await readdir(directory);
  const candidates = await Promise.all(entries.filter((name) => /^bridge_run_\d+_\d{8}_\d{6}\.json$/.test(name)).map(async (name) => {
    const path = join(directory, name);
    return { path, modifiedAtMs: (await stat(path)).mtimeMs };
  }));
  candidates.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  if (!candidates[0]) throw new Error('bridge_audit_unavailable');
  return { ...candidates[0], audit: JSON.parse(await readFile(candidates[0].path, 'utf8')) };
}

async function atomicStatus(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function api(baseUrl, secret, identity, method, path, body, intent) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: signedHeaders(secret, method, path, body, identity, intent),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({ error: 'invalid_json_response' }));
  if (!response.ok) throw new Error(`canary_api_${response.status}:${String(payload.error ?? 'unknown')}`);
  return { statusCode: response.status, payload };
}

export async function run(environment = process.env) {
  const config = {
    baseUrl: environment.GCT_SHADOW_CANARY_URL ?? 'http://127.0.0.1:17841',
    targetFile: environment.GCT_SHADOW_TARGET_FILE ?? '/opt/future/binance-exchange/artifacts/reports/real_trading_state_mainline.json',
    auditDir: environment.GCT_BRIDGE_AUDIT_DIR ?? '/opt/future/real-trading/runtime/audits',
    statusFile: environment.GCT_SHADOW_OBSERVER_STATUS ?? '/var/lib/target-shadow-observer/status.json',
    secret: environment.GCT_BFF_HMAC_SECRET ?? '',
    identity: {
      userId: environment.GCT_SHADOW_OBSERVER_USER_ID ?? '',
      role: environment.GCT_SHADOW_OBSERVER_ROLE ?? '',
      accountId: environment.GCT_CLOUD_ACCOUNT_ID ?? 'preview-gate-default',
    },
  };
  if (config.secret.length < 32) throw new Error('observer_bff_secret_missing');
  if (!config.identity.userId) throw new Error('observer_user_id_missing');
  if (config.identity.role !== 'planner') throw new Error('observer_role_must_be_planner');
  const checkedAt = new Date().toISOString();
  try {
    const target = JSON.parse(await readFile(config.targetFile, 'utf8'));
    const bridge = await latestAudit(config.auditDir);
    const targetFingerprint = String(target?.meta?.state_fingerprint ?? '');
    const bridgeFingerprint = String(bridge.audit?.target_request_hash ?? '');
    const base = { checkedAt, targetFingerprint, bridgeFingerprint, bridgeAuditPath: bridge.path, bridgeAuditModifiedAtMs: bridge.modifiedAtMs };
    if (!/^sha256:[a-f0-9]{64}$/.test(targetFingerprint) || targetFingerprint !== bridgeFingerprint) {
      const status = { ...base, state: 'WAITING', reason: 'target_bridge_fingerprint_not_aligned' };
      await atomicStatus(config.statusFile, status);
      return status;
    }
    const planPath = '/api/v1/strategies/target-shadow-plans';
    const planResult = await api(config.baseUrl, config.secret, config.identity, 'POST', planPath, target, 'shadow-target-state');
    const comparisonPath = `${planPath}/${planResult.payload.planId}/comparisons`;
    const comparisonResult = await api(config.baseUrl, config.secret, config.identity, 'POST', comparisonPath, undefined, 'compare-shadow-plan');
    const status = {
      ...base, state: 'COMPARED', planId: planResult.payload.planId, planReused: Boolean(planResult.payload.reused),
      comparisonId: comparisonResult.payload.comparisonId, comparisonReused: Boolean(comparisonResult.payload.reused),
      comparisonStatus: comparisonResult.payload.status, confidence: comparisonResult.payload.confidence,
      reasons: comparisonResult.payload.reasons ?? [], shadowActionCount: comparisonResult.payload.shadowActions?.length ?? 0,
      legacyActionCount: comparisonResult.payload.legacyActions?.length ?? 0,
    };
    await atomicStatus(config.statusFile, status);
    return status;
  } catch (error) {
    const status = { checkedAt, state: 'ERROR', error: error instanceof Error ? error.message : String(error) };
    await atomicStatus(config.statusFile, status);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then((status) => console.log(JSON.stringify(status))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, run, signedHeaders } from './target-shadow-observer.mjs';

const fingerprint = `sha256:${'a'.repeat(64)}`;
async function fixture(bridgeFingerprint = fingerprint) {
  const root = await mkdtemp(join(tmpdir(), 'shadow-observer-'));
  const auditDir = join(root, 'audits'); await mkdir(auditDir);
  const targetFile = join(root, 'target.json'); const statusFile = join(root, 'status.json');
  await writeFile(targetFile, JSON.stringify({ meta: { contract: 'gate-crossex-target-state', contract_version: 1, state_fingerprint: fingerprint }, positions: [] }));
  await writeFile(join(auditDir, 'bridge_run_001_20260823_000000.json'), JSON.stringify({ target_request_hash: bridgeFingerprint, shadow_actions: [] }));
  return { root, auditDir, targetFile, statusFile };
}
const env = (f) => ({ GCT_SHADOW_TARGET_FILE: f.targetFile, GCT_BRIDGE_AUDIT_DIR: f.auditDir, GCT_SHADOW_OBSERVER_STATUS: f.statusFile, GCT_BFF_HMAC_SECRET: 'x'.repeat(32), GCT_CLOUD_ACCOUNT_ID: 'acct' });

test('canonical JSON and signature body hash are deterministic', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, 'x'] }), '{"a":[true,"x"],"b":1}');
  const headers = signedHeaders('x'.repeat(32), 'POST', '/path', { b: 1, a: 2 }, { userId: 'u', role: 'admin', accountId: 'a' }, 'shadow');
  assert.match(headers['x-gct-body-sha256'], /^[a-f0-9]{64}$/); assert.ok(headers['x-gct-signature']);
});

test('waits without API calls when fingerprints differ', async () => {
  const f = await fixture(`sha256:${'b'.repeat(64)}`); let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error('unexpected'); };
  const result = await run(env(f)); assert.equal(result.state, 'WAITING'); assert.equal(calls, 0);
  assert.equal(JSON.parse(await readFile(f.statusFile, 'utf8')).reason, 'target_bridge_fingerprint_not_aligned');
});

test('creates and compares aligned plans while preserving API idempotency results', async () => {
  const f = await fixture(); const responses = [
    new Response(JSON.stringify({ planId: 'plan-1', reused: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ comparisonId: 'comparison-1', reused: true, status: 'MATCH', confidence: 'HIGH', reasons: [], shadowActions: [], legacyActions: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  globalThis.fetch = async () => responses.shift(); const result = await run(env(f));
  assert.deepEqual({ state: result.state, status: result.comparisonStatus, confidence: result.confidence, planReused: result.planReused, comparisonReused: result.comparisonReused }, { state: 'COMPARED', status: 'MATCH', confidence: 'HIGH', planReused: true, comparisonReused: true });
});

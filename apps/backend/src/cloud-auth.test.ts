import { describe, expect, it } from 'vitest';
import { CloudRequestAuthenticator, cloudBodyHash, signCloudRequest } from './cloud-auth.js';

const secret = 'cloud-bff-secret-with-at-least-32-characters';
const now = new Date('2026-08-21T08:00:00.000Z');

function request(overrides: Partial<{
  method: string; url: string; body: unknown; userId: string; role: 'viewer' | 'planner' | 'approver' | 'admin' | 'auditor'; timestamp: string;     accountId: string; nonce: string;
}> = {}) {
  const method = overrides.method ?? 'POST';
  const url = overrides.url ?? '/api/v1/trading/order-previews';
  const body = overrides.body ?? { symbol: 'BINANCE_FUTURE_BTC_USDT', quantity: '0.01' };
  const identity = {
    userId: overrides.userId ?? 'felix',
    role: overrides.role ?? 'planner',
    accountId: overrides.accountId ?? 'gate-default',
    timestamp: overrides.timestamp ?? String(now.getTime()),
    nonce: overrides.nonce ?? 'nonce-00000000000001',
    bodyHash: cloudBodyHash(body),
  };
  return {
    method, url, body,
    headers: {
      'x-gct-user-id': identity.userId,
      'x-gct-role': identity.role,
      'x-gct-account-id': identity.accountId,
      'x-gct-request-timestamp': identity.timestamp,
      'x-gct-nonce': identity.nonce,
      'x-gct-body-sha256': identity.bodyHash,
      'x-gct-signature': signCloudRequest(secret, method, url, identity),
    },
  };
}

describe('CloudRequestAuthenticator', () => {
  it('authenticates a signed request and enforces roles', () => {
    const auth = new CloudRequestAuthenticator(secret);
    const principal = auth.authenticate(request(), now);
    expect(principal).toEqual({ userId: 'felix', role: 'planner', accountId: 'gate-default' });
    expect(() => auth.authorize(principal, ['planner', 'admin'])).not.toThrow();
    expect(() => auth.authorize(principal, ['admin'])).toThrow('cloud_role_forbidden');
  });

  it('rejects a modified body', () => {
    const auth = new CloudRequestAuthenticator(secret);
    const signed = request();
    expect(() => auth.authenticate({ ...signed, body: { symbol: 'BINANCE_FUTURE_BTC_USDT', quantity: '5' } }, now))
      .toThrow('cloud_body_hash_mismatch');
  });

  it('rejects expired and replayed requests', () => {
    const auth = new CloudRequestAuthenticator(secret);
    const signed = request();
    expect(auth.authenticate(signed, now)).toEqual({ userId: 'felix', role: 'planner', accountId: 'gate-default' });
    expect(() => auth.authenticate(signed, now)).toThrow('cloud_request_replayed');
    const expired = request({ timestamp: String(now.getTime() - 60_001), nonce: 'nonce-00000000000002' });
    expect(() => auth.authenticate(expired, now)).toThrow('cloud_request_expired');
  });

  it('binds method and URL into the signature', () => {
    const auth = new CloudRequestAuthenticator(secret);
    const signed = request();
    expect(() => auth.authenticate({ ...signed, method: 'DELETE' }, now)).toThrow('invalid_cloud_signature');
    expect(() => auth.authenticate({ ...signed, url: '/api/v1/trading/order-previews/other' }, now))
      .toThrow('invalid_cloud_signature');
  });
});

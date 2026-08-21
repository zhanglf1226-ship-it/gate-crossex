import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const CloudRoleSchema = z.enum(['viewer', 'planner', 'approver', 'admin', 'auditor']);
export type CloudRole = z.infer<typeof CloudRoleSchema>;

export interface CloudPrincipal {
  userId: string;
  role: CloudRole;
  accountId: string;
}

export interface CloudAuthRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export class CloudAuthError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = 'CloudAuthError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function cloudBodyHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export interface CloudIdentityHeaders {
  userId: string;
  role: CloudRole;
  accountId: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  signature: string;
}

export function cloudCanonicalRequest(
  method: string,
  url: string,
  identity: Omit<CloudIdentityHeaders, 'signature'>,
): string {
  return [
    'GCT1', method.toUpperCase(), url, identity.userId, identity.role, identity.accountId,
    identity.timestamp, identity.nonce, identity.bodyHash,
  ].join('\n');
}

export function signCloudRequest(
  secret: string,
  method: string,
  url: string,
  identity: Omit<CloudIdentityHeaders, 'signature'>,
): string {
  return createHmac('sha256', secret).update(cloudCanonicalRequest(method, url, identity)).digest('base64url');
}

function oneHeader(headers: CloudAuthRequest['headers'], name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' ? value : null;
}

export class CloudRequestAuthenticator {
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly maxClockSkewMs = 60_000,
    private readonly nonceTtlMs = 5 * 60_000,
    private readonly maxNonceEntries = 100_000,
  ) {}

  authenticate(request: CloudAuthRequest, now: Date = new Date()): CloudPrincipal {
    this.pruneNonces(now.getTime());
    const userId = oneHeader(request.headers, 'x-gct-user-id');
    const rawRole = oneHeader(request.headers, 'x-gct-role');
    const accountId = oneHeader(request.headers, 'x-gct-account-id');
    const timestamp = oneHeader(request.headers, 'x-gct-request-timestamp');
    const nonce = oneHeader(request.headers, 'x-gct-nonce');
    const bodyHash = oneHeader(request.headers, 'x-gct-body-sha256');
    const signature = oneHeader(request.headers, 'x-gct-signature');
    if (!userId || !rawRole || !accountId || !timestamp || !nonce || !bodyHash || !signature) {
      throw new CloudAuthError('cloud_identity_required', 401);
    }
    if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(userId)) throw new CloudAuthError('invalid_cloud_identity', 401);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(accountId)) throw new CloudAuthError('invalid_cloud_account', 401);
    const role = CloudRoleSchema.safeParse(rawRole);
    if (!role.success) throw new CloudAuthError('invalid_cloud_role', 403);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new CloudAuthError('invalid_cloud_nonce', 401);
    const requestTime = Number(timestamp);
    if (!Number.isSafeInteger(requestTime) || Math.abs(now.getTime() - requestTime) > this.maxClockSkewMs) {
      throw new CloudAuthError('cloud_request_expired', 401);
    }
    const actualBodyHash = cloudBodyHash(request.body);
    if (bodyHash !== actualBodyHash) throw new CloudAuthError('cloud_body_hash_mismatch', 401);
    const expected = signCloudRequest(this.secret, request.method, request.url, {
      userId, role: role.data, accountId, timestamp, nonce, bodyHash,
    });
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(signature);
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
      throw new CloudAuthError('invalid_cloud_signature', 401);
    }
    const nonceKey = `${userId}:${nonce}`;
    if (this.usedNonces.has(nonceKey)) throw new CloudAuthError('cloud_request_replayed', 409);
    if (this.usedNonces.size >= this.maxNonceEntries) throw new CloudAuthError('cloud_nonce_capacity_exceeded', 503);
    this.usedNonces.set(nonceKey, now.getTime() + this.nonceTtlMs);
    return { userId, role: role.data, accountId };
  }

  authorize(principal: CloudPrincipal, allowedRoles: readonly CloudRole[]): void {
    if (!allowedRoles.includes(principal.role)) throw new CloudAuthError('cloud_role_forbidden', 403);
  }

  private pruneNonces(nowMs: number): void {
    for (const [key, expiresAt] of this.usedNonces) if (expiresAt <= nowMs) this.usedNonces.delete(key);
  }
}

import type Database from 'better-sqlite3';
import type { CloudRole } from './cloud-auth.js';

export type AccountAccess = 'view' | 'plan' | 'approve' | 'admin' | 'audit';

const roleMinimumAccess: Record<CloudRole, readonly AccountAccess[]> = {
  viewer: ['view', 'plan', 'approve', 'admin'],
  planner: ['plan', 'admin'],
  approver: ['approve', 'admin'],
  admin: ['admin'],
  auditor: ['audit', 'admin'],
};

export class AccountOwnershipError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = 'AccountOwnershipError';
  }
}

export class AccountOwnershipStore {
  constructor(private readonly database: Database.Database) {}

  seedAccount(accountId: string, label: string, credentialProfileId: string, adminUserId: string, now: Date = new Date()): void {
    const timestamp = now.toISOString();
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO cloud_accounts
        (id, label, credential_profile_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`)
        .run(accountId, label, credentialProfileId, timestamp, timestamp);
      const grantCount = this.database.prepare('SELECT COUNT(*) AS count FROM cloud_account_grants WHERE account_id = ?')
        .get(accountId) as { count: number };
      if (grantCount.count === 0) {
        this.database.prepare(`INSERT INTO cloud_account_grants
          (user_id, account_id, access_level, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)`)
          .run(adminUserId, accountId, timestamp, timestamp);
      }
    })();
  }

  requireCredentialProfile(accountId: string, expectedProfileId: string): void {
    const row = this.database.prepare('SELECT credential_profile_id FROM cloud_accounts WHERE id = ?')
      .get(accountId) as { credential_profile_id: string } | undefined;
    if (!row) throw new AccountOwnershipError('cloud_account_not_found', 404);
    if (row.credential_profile_id !== expectedProfileId) {
      throw new AccountOwnershipError('cloud_account_credential_mismatch', 403);
    }
  }

  grant(userId: string, accountId: string, accessLevel: AccountAccess, now: Date = new Date()): void {
    const account = this.database.prepare('SELECT enabled FROM cloud_accounts WHERE id = ?')
      .get(accountId) as { enabled: number } | undefined;
    if (!account) throw new AccountOwnershipError('cloud_account_not_found', 404);
    const timestamp = now.toISOString();
    this.database.prepare(`INSERT INTO cloud_account_grants
      (user_id, account_id, access_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, account_id) DO UPDATE SET access_level = excluded.access_level, updated_at = excluded.updated_at`)
      .run(userId, accountId, accessLevel, timestamp, timestamp);
  }

  requireAccess(userId: string, role: CloudRole, accountId: string): void {
    const row = this.database.prepare(`SELECT a.enabled, g.access_level
      FROM cloud_accounts a LEFT JOIN cloud_account_grants g
        ON g.account_id = a.id AND g.user_id = ? WHERE a.id = ?`)
      .get(userId, accountId) as { enabled: number; access_level: AccountAccess | null } | undefined;
    if (!row) throw new AccountOwnershipError('cloud_account_not_found', 404);
    if (row.enabled !== 1) throw new AccountOwnershipError('cloud_account_disabled', 403);
    if (!row.access_level || !roleMinimumAccess[role].includes(row.access_level)) {
      throw new AccountOwnershipError('cloud_account_forbidden', 403);
    }
  }
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { AccountOwnershipStore } from './account-ownership.js';

const directories: string[] = [];
function store() {
  const directory = mkdtempSync(join(tmpdir(), 'gct-ownership-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'test.sqlite'), resolve(process.cwd(), '../../migrations'));
  return { database, ownership: new AccountOwnershipStore(database) };
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AccountOwnershipStore', () => {
  it('persists account grants and requires role-compatible access', () => {
    const { database, ownership } = store();
    ownership.seedAccount('gate-main', 'Gate Main', 'gate-crossex-default', 'admin-user');
    ownership.grant('planner-user', 'gate-main', 'plan');
    ownership.grant('approver-user', 'gate-main', 'approve');

    expect(() => ownership.requireAccess('planner-user', 'planner', 'gate-main')).not.toThrow();
    expect(() => ownership.requireAccess('planner-user', 'approver', 'gate-main')).toThrow('cloud_account_forbidden');
    expect(() => ownership.requireAccess('approver-user', 'approver', 'gate-main')).not.toThrow();
    expect(() => ownership.requireAccess('admin-user', 'admin', 'gate-main')).not.toThrow();
    expect(() => ownership.requireCredentialProfile('gate-main', 'gate-crossex-default')).not.toThrow();
    expect(() => ownership.requireCredentialProfile('gate-main', 'other-profile')).toThrow('cloud_account_credential_mismatch');
    database.close();
  });

  it('rejects disabled, missing, and ungranted accounts', () => {
    const { database, ownership } = store();
    ownership.seedAccount('gate-main', 'Gate Main', 'gate-crossex-default', 'admin-user');
    expect(() => ownership.requireAccess('unknown', 'viewer', 'gate-main')).toThrow('cloud_account_forbidden');
    expect(() => ownership.requireAccess('admin-user', 'admin', 'missing')).toThrow('cloud_account_not_found');
    database.prepare('UPDATE cloud_accounts SET enabled = 0 WHERE id = ?').run('gate-main');
    expect(() => ownership.requireAccess('admin-user', 'admin', 'gate-main')).toThrow('cloud_account_disabled');
    database.close();
  });
});

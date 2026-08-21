# Cloud preview-only deployment checklist

## Deployment target

This checklist deploys the Gate CrossEx platform as an authenticated **preview-only** service behind the existing portal/BFF. It does not authorize live exchange writes.

## Required environment

```env
GCT_DEPLOYMENT_MODE=cloud
GCT_EXECUTION_MODE=preview
GCT_ALLOW_LIVE_WRITES=0
GCT_BFF_HMAC_SECRET=<secret-manager-value-at-least-32-characters>
GCT_CLOUD_ACCOUNT_ID=<single-account-id>
GCT_CLOUD_BOOTSTRAP_ADMIN=<one-time-initial-admin-user-id>
GCT_ORDER_CONFIRMATION_SECRET=<secret-manager-value-at-least-32-characters>
GCT_ALLOWED_HOSTS=<private-bff-host>
```

After the initial account grant is created, remove `GCT_CLOUD_BOOTSTRAP_ADMIN` from the service environment before the next deployment. Existing grants are not overwritten on restart.

## Network boundary

- Keep Fastify bound to `127.0.0.1` or a private service network.
- Do not expose port `17840` to the Internet.
- Terminate TLS at Nginx or the portal ingress.
- Only the trusted portal/BFF may know `GCT_BFF_HMAC_SECRET`.
- Strip all incoming `X-GCT-*` identity headers at the public edge; the BFF must recreate and sign them.

## Default risk posture

Migration `0020_execution_risk_guard.sql` starts with:

- kill switch: enabled;
- close-only: enabled;
- allowed symbols: empty;
- order/daily limits: conservative defaults.

Do not disable the kill switch in preview-only deployment. The risk policy API is present for validation and future controlled rollout, not for enabling production live writes.

## Identity and approval

- Signed identity includes user ID, role, account ID, timestamp, nonce and body hash.
- Account ID must map to the single configured credential profile.
- Planner creates a preview.
- A different approver/admin confirms it.
- Self-approval, account mismatch and approver takeover are rejected.
- Nonce storage is process-local; run exactly one backend instance.

## Validation before deployment

- Run TypeScript typecheck.
- Run cloud-auth, account-ownership, execution-risk, order-confirmation, database and trading-runtime tests.
- Confirm `GCT_ALLOW_LIVE_WRITES=0` in the rendered service environment.
- Confirm the production Gate credential has no withdrawal permission.
- Confirm public requests cannot reach private Fastify routes directly.
- Confirm Nginx strips client-provided `X-GCT-*` headers.
- Back up the SQLite database before migration.
- Start with a separate preview database copy; do not point the branch at the production database during the first canary.

## Not complete for live execution

Live execution remains blocked until all of the following are externally completed:

1. OIDC login with MFA and server-side sessions.
2. Roles and account grants sourced from the identity system.
3. Cloud secret-manager references per account.
4. PostgreSQL/Redis for shared nonce and risk reservations before multi-instance deployment.
5. Fresh trusted quote pricing for ordinary market orders.
6. Position, leverage, venue and drawdown limits.
7. Immutable off-host audit retention and tamper-evident chaining.
8. Independent security review and penetration testing.
9. Preview-only canary approval and a separate explicit live-unlock change request.

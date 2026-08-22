# Cloud trading platform: phase 1

This branch turns the local Gate CrossEx terminal into a safe cloud-platform foundation without exposing live writes.

## Baseline

- GitHub source: `zhanglf1226-ship-it/gate-crossex`
- Baseline commit: `0f11eb4` (`v0.1.2`)
- Development branch: `feat/cloud-strategy-trading-platform`
- Existing public website: `/opt/future/website`
- Existing website service: `future-website.service`
- Existing website port: `127.0.0.1:8506`

The production website remains unchanged while this branch is developed and tested.

## Phase 1 capabilities

- Public market data and funding views.
- Read-only account, balance, position, order and fill views after authentication is added at the portal/BFF layer.
- Strategy plan ingestion from the versioned `gate-crossex-target-state/v1` contract.
- Order preview generation with a canonical request hash.
- Target-state validation, venue candidate expansion and route-plan preview.
- Route-plan and risk-check display.
- Append-only audit events for preview and denied execution attempts.

## Phase 1 hard safety boundary

Defaults:

```env
GCT_DEPLOYMENT_MODE=cloud
GCT_EXECUTION_MODE=preview
GCT_ALLOW_LIVE_WRITES=0
```

In preview mode the backend rejects:

- enabling live trading;
- placing or cancelling orders;
- changing leverage;
- starting execution strategies;
- transferring funds.

`POST /api/v1/trading/order-previews` validates and canonicalizes an order, returns a short-lived preview and always reports `executionAllowed: false`. It does not call a Gate write endpoint.

`POST /api/v1/strategies/target-state-previews` accepts only `gate-crossex-target-state/v1`, expands normalized symbols into allowed venue candidates and returns a non-executable route plan. Unknown contract versions are rejected.

## Deployment topology

```text
Internet
  -> Nginx / TLS
     -> /                  existing Flask portal
     -> /platform/         React trading console
     -> /api/v1/platform/  authenticated portal/BFF
        -> 127.0.0.1 Fastify execution core
```

The Fastify backend must remain loopback/private. Do not publish port `17840` directly to the Internet.

## Phase 2 execution-confirmation foundation

The first Phase 2 increment adds a mandatory cloud order confirmation boundary:

- `order_previews` persists the canonical order, request hash, HMAC signature, expiry and status.
- `POST /api/v1/trading/order-previews/:previewId/confirm` requires an `Idempotency-Key` and a confirmation intent header.
- Confirmation rejects missing, expired, modified, already-consumed and conflicting previews before reaching the trading gateway.
- Successful retries with the same idempotency key return the existing execution order rather than submitting again.
- Direct `POST /api/trading/orders` remains available to the local desktop deployment, but cloud deployments return `428 order_preview_required`.
- Cloud live execution additionally requires a durable `GCT_ORDER_CONFIRMATION_SECRET` containing at least 32 characters.
- Preview mode remains non-executable: confirmation is denied before any exchange write call.

## Phase 2 trusted BFF identity boundary

The second Phase 2 increment requires a signed portal/BFF identity for private cloud routes:

- Cloud startup requires `GCT_BFF_HMAC_SECRET` with at least 32 characters.
- The BFF signs method, URL, user ID, role, account ID, request timestamp, nonce and canonical body hash.
- Requests outside the clock window, with a modified body, invalid signature or reused nonce are rejected.
- Roles are `viewer`, `planner`, `approver`, `admin` and `auditor`.
- Order and target-state previews require planner/admin; confirmation requires approver/admin; trading-mode and credential changes require admin.
- In cloud mode all `/api/**`, `/secure/**` and `/ws/stream` routes are private by default, except the explicit health, discovery and public-market allowlist.
- The nonce replay store is process-local in this increment. The Fastify core must remain single-instance until it is replaced by an atomic shared store such as Redis or PostgreSQL.

## Phase 2 account, approval and execution-risk boundary

The third Phase 2 increment adds the internal safety boundary needed for a preview-only deployment:

- Every signed cloud request includes an `accountId`, which is bound to a persisted account grant and the configured credential profile.
- This release intentionally supports one cloud Gate CrossEx credential profile. Unknown account IDs and profile mismatches fail closed; it must not be presented as multi-tenant account isolation.
- Order previews persist account and creator identity. Confirmation must use the same account and a different approver identity.
- Idempotent confirmation retries remain bound to the original approver.
- Execution risk defaults to kill-switch enabled, close-only enabled and an empty symbol allowlist.
- Risk checks enforce symbol allowlist, quantity, order notional and atomically reserved UTC daily notional.
- The risk guard is injected at `TradingRuntime.createOrder`, so strategy and internal order paths cannot bypass it in cloud deployment mode.
- Ordinary market orders remain disabled until the confirmation service can price them from a fresh trusted quote. Risk-reducing/reduce-only market orders may use the current persisted position mark with a 3% conservative buffer; missing marks fail closed.
- Bootstrap administrator creation runs only when an account has no grants. Remove `GCT_CLOUD_BOOTSTRAP_ADMIN` from the service environment after first initialization.

This increment makes a **preview-only cloud deployment** internally fail-closed, but does not authorize production live execution. Keep:

```env
GCT_DEPLOYMENT_MODE=cloud
GCT_EXECUTION_MODE=preview
GCT_ALLOW_LIVE_WRITES=0
GCT_BFF_HMAC_SECRET=<secret-manager-reference>
GCT_CLOUD_ACCOUNT_ID=<single-account-id>
GCT_CLOUD_BOOTSTRAP_ADMIN=<one-time-bootstrap-user>
```

## TARGET shadow planning

The first TARGET takeover increment persists deterministic, non-executable shadow plans:

- validates `gate-crossex-target-state/v1` and rejects expired or duplicate normalized symbols;
- fingerprints the TARGET request and current position snapshot;
- compiles flatten, reduce and open actions with explicit phases;
- clips actions using the configured maximum order notional;
- binds plans to the single configured cloud account and authenticated creator;
- idempotently reuses the same plan for the same TARGET and position fingerprint;
- never creates `execution_orders`, calls a trading gateway or exposes a confirm/execute route.

The compiler intentionally selects only a deterministic preferred/first route candidate. Fresh venue depth, slippage scoring, exchange precision and minimum-order quantization remain required before any executable TARGET plan.

## Required before live execution

1. Connect the trusted BFF identity to real OIDC authentication with MFA.
2. Server-side sessions and CSRF protection at the portal/BFF layer.
3. Source user roles and account grants from the OIDC/session identity layer rather than bootstrap configuration.
4. Replace the single credential profile with account-scoped secret-manager references before claiming multi-account support.
5. Cloud secret manager integration; disable the local credential-entry page in cloud mode.
6. Add position, leverage, venue and drawdown limits; price market orders from fresh trusted quotes.
7. Replace in-memory nonce storage and SQLite risk reservations with shared PostgreSQL/Redis primitives before multi-instance deployment.
8. Extend actor/account/request-aware audit coverage to every private read and write operation.
9. Add tamper-evident audit chaining and immutable off-host retention.
10. Independent security review, OIDC/MFA penetration test and preview-only canary rollout before any live unlock.

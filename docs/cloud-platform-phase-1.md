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
- The BFF signs method, URL, user ID, role, request timestamp, nonce and canonical body hash.
- Requests outside the clock window, with a modified body, invalid signature or reused nonce are rejected.
- Roles are `viewer`, `planner`, `approver`, `admin` and `auditor`.
- Order and target-state previews require planner/admin; confirmation requires approver/admin; trading-mode and credential changes require admin.
- In cloud mode all `/api/**`, `/secure/**` and `/ws/stream` routes are private by default, except the explicit health, discovery and public-market allowlist.
- The nonce replay store is process-local in this increment. The Fastify core must remain single-instance until it is replaced by an atomic shared store such as Redis or PostgreSQL.

This increment does **not** make the cloud platform production-ready for live execution. Keep:

```env
GCT_DEPLOYMENT_MODE=cloud
GCT_EXECUTION_MODE=preview
GCT_ALLOW_LIVE_WRITES=0
GCT_BFF_HMAC_SECRET=<secret-manager-reference>
```

## Required before live execution

1. Connect the trusted BFF identity to real OIDC authentication with MFA.
2. Server-side sessions and CSRF protection at the portal/BFF layer.
3. Persist actor roles and approval policy instead of accepting roles solely from the BFF assertion.
4. Account ownership and scope on every private API and WebSocket subscription.
5. Cloud secret manager integration; no public credential-entry page.
6. Risk policies: order, daily, position, symbol, venue, leverage and drawdown limits.
7. Bind persisted confirmations to authenticated actor, account and approval policy.
8. Kill switch and close-only mode.
9. Actor/account/request-aware tamper-evident audit trail.
10. Independent security review and canary rollout.

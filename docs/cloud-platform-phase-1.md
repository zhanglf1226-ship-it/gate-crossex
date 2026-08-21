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

## Required before live execution

1. Unified user authentication with MFA.
2. Server-side sessions and CSRF protection.
3. Roles: viewer, planner, approver, admin, auditor.
4. Account ownership and scope on every private API and WebSocket subscription.
5. Cloud secret manager integration; no public credential-entry page.
6. Risk policies: order, daily, position, symbol, venue, leverage and drawdown limits.
7. Server-side preview/confirm flow with expiration, idempotency and replay rejection.
8. Kill switch and close-only mode.
9. Actor/account/request-aware tamper-evident audit trail.
10. Independent security review and canary rollout.

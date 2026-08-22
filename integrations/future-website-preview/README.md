# Future Website Cloud Preview BFF Overlay

This integration adds an administrator-only, preview-only Gate CrossEx BFF to the existing Flask website without importing the full website into this repository.

## Security boundary

- Separate administrator password and Flask session.
- Per-IP failed-login throttle: five failures per 15 minutes, then a 15-minute block.
- CSRF token required for order preview POST requests.
- BFF HMAC secret remains server-side.
- Fixed upstream routes only: health, discovery, execution-risk read, and order preview creation.
- No confirm route, live-order route, credential route, arbitrary proxy, or risk-policy write route.

## Host integration

The host Flask app needs:

```python
from platform_preview_bff import preview_blueprint
app.register_blueprint(preview_blueprint)
```

The deployment script inserts these lines idempotently when the host uses the current `future/website` app markers.

## Environment

Install a root-only environment file at `/etc/future/platform-preview.env` using `platform-preview.env.example`. The BFF secret must match `GCT_BFF_HMAC_SECRET` on the loopback Canary, but must never be shipped to the browser.

## Deploy

```bash
sudo OVERLAY_ROOT=/path/to/integrations/future-website-preview \
  ./integrations/future-website-preview/scripts/deploy.sh
```

The script backs up the host app and existing overlay files under `/opt/future/env-backup`, installs the Blueprint/template, performs Python syntax checks, restarts only `future-website.service`, and checks `/` plus `/platform-preview`.

## Roll back

```bash
sudo ./integrations/future-website-preview/scripts/rollback.sh \
  /opt/future/env-backup/website-platform-overlay-<timestamp>
```

## HTTPS Nginx overlay

The `nginx/` directory contains versioned rate-limit zones and path-scoped locations for an existing HTTPS virtual host. The locations:

- redirect HTTP `/platform-preview` and `/api/platform-preview/` to HTTPS;
- proxy only those prefixes to the Flask website on loopback port 8506;
- apply login/API/page rate limits and a 16KB request-body limit;
- add `Secure`, `HttpOnly`, and `SameSite=Lax` to Preview-path session cookies;
- add clickjacking, MIME-sniffing, and referrer protections.

Use `scripts/install_nginx_overlay.py` against a backed-up candidate server block, run `nginx -t`, and reload only after validation. Do not enable Flask's global `SESSION_COOKIE_SECURE` while the same Flask session cookie is still used by HTTP/IP Live Dashboard users; the Nginx overlay scopes `Secure` to the HTTPS Preview paths.

## Current production note

The first deployment was introduced inline in the existing website before this overlay was extracted. Do not register the Blueprint on top of those inline routes. Migrate by restoring the pre-BFF `app.py` backup or removing the inline `/platform-preview` helper/routes, then deploy this overlay.

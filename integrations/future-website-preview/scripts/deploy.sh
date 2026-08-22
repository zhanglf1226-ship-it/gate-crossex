#!/usr/bin/env bash
set -euo pipefail

OVERLAY_ROOT="${OVERLAY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WEBSITE_ROOT="${WEBSITE_ROOT:-/opt/future/website}"
ENV_FILE="${ENV_FILE:-/etc/future/platform-preview.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/future/env-backup}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/website-platform-overlay-$STAMP"

[[ -f "$WEBSITE_ROOT/app.py" ]]
[[ -f "$ENV_FILE" ]]
grep -q '^PLATFORM_PREVIEW_BFF_SECRET=' "$ENV_FILE"
grep -q '^PLATFORM_PREVIEW_ADMIN_PASSWORD=' "$ENV_FILE"

install -d -m 0700 "$BACKUP_DIR"
cp -a "$WEBSITE_ROOT/app.py" "$BACKUP_DIR/app.py"
[[ ! -f "$WEBSITE_ROOT/platform_preview_bff.py" ]] || cp -a "$WEBSITE_ROOT/platform_preview_bff.py" "$BACKUP_DIR/platform_preview_bff.py"
[[ ! -f "$WEBSITE_ROOT/templates/platform_preview.html" ]] || cp -a "$WEBSITE_ROOT/templates/platform_preview.html" "$BACKUP_DIR/platform_preview.html"

install -m 0644 "$OVERLAY_ROOT/platform_preview_bff.py" "$WEBSITE_ROOT/platform_preview_bff.py"
install -m 0644 "$OVERLAY_ROOT/templates/platform_preview.html" "$WEBSITE_ROOT/templates/platform_preview.html"
python3 "$OVERLAY_ROOT/scripts/install_overlay.py" "$WEBSITE_ROOT/app.py"
"$WEBSITE_ROOT/.venv/bin/python" -m py_compile "$WEBSITE_ROOT/app.py" "$WEBSITE_ROOT/platform_preview_bff.py"
systemctl restart future-website.service
systemctl is-active --quiet future-website.service
curl -fsS http://127.0.0.1:8506/ >/dev/null
curl -fsS http://127.0.0.1:8506/platform-preview >/dev/null
printf 'deployed overlay; rollback backup: %s\n' "$BACKUP_DIR"

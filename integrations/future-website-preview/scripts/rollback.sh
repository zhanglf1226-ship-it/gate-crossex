#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: $0 <backup-dir>" >&2; exit 2; }
BACKUP_DIR="$1"
WEBSITE_ROOT="${WEBSITE_ROOT:-/opt/future/website}"
[[ -f "$BACKUP_DIR/app.py" ]]
install -m 0644 "$BACKUP_DIR/app.py" "$WEBSITE_ROOT/app.py"
if [[ -f "$BACKUP_DIR/platform_preview_bff.py" ]]; then
  install -m 0644 "$BACKUP_DIR/platform_preview_bff.py" "$WEBSITE_ROOT/platform_preview_bff.py"
else
  rm -f "$WEBSITE_ROOT/platform_preview_bff.py"
fi
if [[ -f "$BACKUP_DIR/platform_preview.html" ]]; then
  install -m 0644 "$BACKUP_DIR/platform_preview.html" "$WEBSITE_ROOT/templates/platform_preview.html"
fi
"$WEBSITE_ROOT/.venv/bin/python" -m py_compile "$WEBSITE_ROOT/app.py"
systemctl restart future-website.service
systemctl is-active --quiet future-website.service
curl -fsS http://127.0.0.1:8506/ >/dev/null
printf 'rolled back overlay from: %s\n' "$BACKUP_DIR"

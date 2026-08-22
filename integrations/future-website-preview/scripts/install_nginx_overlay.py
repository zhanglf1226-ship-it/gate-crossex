from __future__ import annotations

import sys
from pathlib import Path

config_path = Path(sys.argv[1])
https_path = Path(sys.argv[2])
http_path = Path(sys.argv[3])
text = config_path.read_text(encoding="utf-8")
if "zone=platform_preview_login" in text:
    raise SystemExit("platform preview locations already installed")

https_marker = "    location = /webhook/lark/query {\n"
https_locations = https_path.read_text(encoding="utf-8") + "\n"
if https_marker not in text:
    raise SystemExit("HTTPS webhook marker not found")
text = text.replace(https_marker, https_locations + https_marker, 1)

http_marker = "    location = /healthz {\n"
first = text.find(http_marker)
second = text.find(http_marker, first + 1)
if second == -1:
    raise SystemExit("HTTP health marker not found")
http_locations = http_path.read_text(encoding="utf-8") + "\n"
text = text[:second] + http_locations + text[second:]
config_path.write_text(text, encoding="utf-8")

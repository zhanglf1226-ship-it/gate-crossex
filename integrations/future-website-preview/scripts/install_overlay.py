from __future__ import annotations

import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
import_line = "from platform_preview_bff import preview_blueprint\n"
register_line = "app.register_blueprint(preview_blueprint)\n"
if import_line not in text:
    marker = "from flask import Flask, jsonify, render_template, request, session\n"
    if marker not in text:
        raise SystemExit("Flask import marker not found")
    text = text.replace(marker, marker + import_line, 1)
if register_line not in text:
    marker = "app = Flask(__name__, static_folder=\"static\", template_folder=\"templates\")\n"
    if marker not in text:
        raise SystemExit("Flask app marker not found")
    text = text.replace(marker, marker + register_line, 1)
path.write_text(text, encoding="utf-8")

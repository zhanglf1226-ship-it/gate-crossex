from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import requests as http_requests
from flask import Blueprint, jsonify, render_template, request, session

preview_blueprint = Blueprint(
    "platform_preview",
    __name__,
    template_folder="templates",
)

_LOGIN_WINDOW_SECONDS = 15 * 60
_LOGIN_MAX_FAILURES = 5
_LOGIN_BLOCK_SECONDS = 15 * 60
_LOGIN_ATTEMPTS: dict[str, list[float]] = {}
_LOGIN_BLOCKED_UNTIL: dict[str, float] = {}


@preview_blueprint.record_once
def _configure_host(state) -> None:
    state.app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=str(os.environ.get("SESSION_COOKIE_SECURE", "0")).lower()
        in {"1", "true", "yes", "on"},
        PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    )


def _config() -> dict[str, Any]:
    return {
        "url": os.environ.get("PLATFORM_PREVIEW_URL", "http://127.0.0.1:17841").rstrip("/"),
        "password": os.environ.get("PLATFORM_PREVIEW_ADMIN_PASSWORD", ""),
        "secret": os.environ.get("PLATFORM_PREVIEW_BFF_SECRET", ""),
        "account_id": os.environ.get("PLATFORM_PREVIEW_ACCOUNT_ID", "preview-gate-default"),
        "user_id": os.environ.get("PLATFORM_PREVIEW_ADMIN_USER_ID", "website-preview-admin"),
        "observer_status": os.environ.get("PLATFORM_PREVIEW_OBSERVER_STATUS", "/var/lib/target-shadow-observer/status.json"),
        "timeout": 5,
    }


def _auth_payload() -> dict[str, Any]:
    config = _config()
    return {
        "configured": bool(config["password"] and config["secret"]),
        "authenticated": bool(session.get("platform_preview_admin")),
    }


def _require_admin():
    payload = _auth_payload()
    if not payload["configured"]:
        return jsonify({"error": "platform_preview_not_configured"}), 503
    if not payload["authenticated"]:
        return jsonify({"error": "platform_preview_admin_required"}), 401
    return None


def _csrf_token() -> str:
    token = session.get("platform_preview_csrf")
    if not token:
        token = secrets.token_urlsafe(32)
        session["platform_preview_csrf"] = token
    return token


def _check_csrf():
    expected = session.get("platform_preview_csrf", "")
    provided = request.headers.get("X-CSRF-Token", "")
    if not expected or not hmac.compare_digest(provided, expected):
        return jsonify({"error": "platform_preview_csrf_invalid"}), 403
    return None


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value, separators=(",", ":"), allow_nan=False)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(key), ensure_ascii=False) + ":" + _canonical_json(value[key])
            for key in sorted(value)
        ) + "}"
    raise TypeError("unsupported JSON value")


def _signed_headers(method: str, path: str, body: Any) -> dict[str, str]:
    config = _config()
    body_text = "" if body is None else _canonical_json(body)
    body_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
    timestamp = str(int(time.time() * 1000))
    nonce = secrets.token_urlsafe(24)
    material = "\n".join([
        "GCT1", method.upper(), path, config["user_id"], "admin", config["account_id"],
        timestamp, nonce, body_hash,
    ])
    digest = hmac.new(config["secret"].encode(), material.encode(), hashlib.sha256).digest()
    signature = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return {
        "X-GCT-User-Id": config["user_id"],
        "X-GCT-Role": "admin",
        "X-GCT-Account-Id": config["account_id"],
        "X-GCT-Request-Timestamp": timestamp,
        "X-GCT-Nonce": nonce,
        "X-GCT-Body-SHA256": body_hash,
        "X-GCT-Signature": signature,
    }


def _upstream(method: str, path: str, body: Any = None, extra_headers: dict[str, str] | None = None):
    config = _config()
    headers = _signed_headers(method, path, body)
    if extra_headers:
        headers.update(extra_headers)
    response = http_requests.request(
        method, config["url"] + path, headers=headers,
        json=body if body is not None else None, timeout=config["timeout"],
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {"error": "invalid_platform_response"}
    return payload, response.status_code


@preview_blueprint.get("/platform-preview")
def index():
    return render_template("platform_preview.html")


@preview_blueprint.get("/api/platform-preview/auth")
def auth():
    payload = _auth_payload()
    if payload["authenticated"]:
        payload["csrf_token"] = _csrf_token()
    return jsonify(payload)


@preview_blueprint.post("/platform-preview/login")
def login():
    config = _config()
    if not config["password"] or not config["secret"]:
        return jsonify({"error": "platform_preview_not_configured"}), 503
    now = time.time()
    client_key = request.remote_addr or "unknown"
    if _LOGIN_BLOCKED_UNTIL.get(client_key, 0) > now:
        return jsonify({"error": "platform_preview_login_rate_limited"}), 429
    _LOGIN_BLOCKED_UNTIL.pop(client_key, None)
    attempts = [t for t in _LOGIN_ATTEMPTS.get(client_key, []) if now - t < _LOGIN_WINDOW_SECONDS]
    password = str((request.get_json(silent=True) or {}).get("password") or "")
    if not hmac.compare_digest(password, config["password"]):
        attempts.append(now)
        _LOGIN_ATTEMPTS[client_key] = attempts
        if len(attempts) >= _LOGIN_MAX_FAILURES:
            _LOGIN_BLOCKED_UNTIL[client_key] = now + _LOGIN_BLOCK_SECONDS
            _LOGIN_ATTEMPTS.pop(client_key, None)
        return jsonify({"error": "platform_preview_password_incorrect"}), 401
    _LOGIN_ATTEMPTS.pop(client_key, None)
    _LOGIN_BLOCKED_UNTIL.pop(client_key, None)
    session.permanent = True
    session["platform_preview_admin"] = True
    session["platform_preview_csrf"] = secrets.token_urlsafe(32)
    return jsonify({**_auth_payload(), "csrf_token": session["platform_preview_csrf"]})


@preview_blueprint.post("/platform-preview/logout")
def logout():
    session.pop("platform_preview_admin", None)
    session.pop("platform_preview_csrf", None)
    return jsonify(_auth_payload())


@preview_blueprint.get("/api/platform-preview/status")
def status():
    denied = _require_admin()
    if denied:
        return denied
    config = _config()
    try:
        health = http_requests.get(config["url"] + "/health", timeout=config["timeout"]).json()
        discovery = http_requests.get(config["url"] + "/api/system/discovery", timeout=config["timeout"]).json()
        risk, risk_status = _upstream("GET", "/api/v1/risk/execution-policy")
        return jsonify({"health": health, "discovery": discovery, "risk": risk, "risk_status": risk_status})
    except http_requests.RequestException:
        return jsonify({"error": "platform_preview_unavailable"}), 503


@preview_blueprint.get("/api/platform-preview/shadow-status")
def shadow_status():
    denied = _require_admin()
    if denied:
        return denied
    path = Path(_config()["observer_status"])
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("invalid observer status")
        return jsonify(payload)
    except (OSError, ValueError, json.JSONDecodeError):
        return jsonify({"error": "shadow_observer_status_unavailable"}), 503


@preview_blueprint.get("/api/platform-preview/shadow-comparisons")
def shadow_comparisons():
    denied = _require_admin()
    if denied:
        return denied
    try:
        payload, status_code = _upstream("GET", "/api/v1/strategies/target-shadow-comparisons")
        return jsonify(payload), status_code
    except http_requests.RequestException:
        return jsonify({"error": "platform_preview_unavailable"}), 503


@preview_blueprint.post("/api/platform-preview/order-previews")
def create_order_preview():
    denied = _require_admin()
    if denied:
        return denied
    csrf_denied = _check_csrf()
    if csrf_denied:
        return csrf_denied
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_order_preview"}), 400
    try:
        payload, status_code = _upstream(
            "POST", "/api/v1/trading/order-previews", body,
            {"X-GCT-Trading-Intent": "preview-order"},
        )
        return jsonify(payload), status_code
    except (http_requests.RequestException, TypeError, ValueError):
        return jsonify({"error": "platform_preview_unavailable"}), 503

from __future__ import annotations

import os

from flask import Flask

from platform_preview_bff import preview_blueprint


def create_app() -> Flask:
    os.environ["PLATFORM_PREVIEW_ADMIN_PASSWORD"] = "admin-secret"
    os.environ["PLATFORM_PREVIEW_BFF_SECRET"] = "bff-secret-with-at-least-32-characters"
    os.environ["PLATFORM_PREVIEW_ACCOUNT_ID"] = "preview-gate-default"
    app = Flask(__name__)
    app.secret_key = "test-secret"
    app.register_blueprint(preview_blueprint)
    return app


def test_auth_csrf_and_fixed_preview_proxy(monkeypatch):
    app = create_app()
    calls = []

    class Response:
        status_code = 201

        @staticmethod
        def json():
            return {"executionAllowed": False, "previewId": "preview-1"}

    def fake_request(method, url, headers, json, timeout):
        calls.append((method, url, headers, json, timeout))
        return Response()

    monkeypatch.setattr("platform_preview_bff.http_requests.request", fake_request)
    client = app.test_client()
    assert client.get("/api/platform-preview/status").status_code == 401
    login = client.post("/platform-preview/login", json={"password": "admin-secret"})
    assert login.status_code == 200
    csrf = login.get_json()["csrf_token"]
    order = {
        "symbol": "BINANCE_FUTURE_BTC_USDT", "side": "BUY", "type": "LIMIT",
        "timeInForce": "GTC", "quantity": "0.001", "price": "64000", "reduceOnly": False,
    }
    assert client.post("/api/platform-preview/order-previews", json=order).status_code == 403
    preview = client.post(
        "/api/platform-preview/order-previews", json=order, headers={"X-CSRF-Token": csrf},
    )
    assert preview.status_code == 201
    assert preview.get_json()["executionAllowed"] is False
    method, url, headers, body, _timeout = calls[-1]
    assert method == "POST"
    assert url.endswith("/api/v1/trading/order-previews")
    assert headers["X-GCT-Role"] == "admin"
    assert headers["X-GCT-Trading-Intent"] == "preview-order"
    assert body == order

from __future__ import annotations
import json
import os
import socket
import sys
from pathlib import Path

def _deny_network(*args, **kwargs):
    raise RuntimeError("offline drill network access prohibited")


socket.socket = _deny_network  # type: ignore[assignment]
root = Path(os.environ["LEGACY_GATE_CROSSEX_ROOT"]).resolve()
if not (root / "strategy" / "router.py").is_file():
    raise RuntimeError("legacy drill root is missing strategy/router.py")
if str(root) not in sys.path:
    sys.path.insert(0, str(root))
from strategy.router import route_signals  # noqa: E402
payload = json.load(sys.stdin)
scenario = payload["scenario"]
positions = []
for item in scenario["positions"]:
    notional = float(item["notional"])
    positions.append({
        "symbol": item["symbol"],
        "position_side": "LONG" if item["side"] == "BUY" else "SHORT",
        "position_value": notional,
        "position_qty": notional / float(payload["markPrice"]) * (1 if item["side"] == "BUY" else -1),
    })
signal = {
    "symbol": "BTCUSDT",
    "route_symbol": "BTCUSDT",
    "side": scenario["targetSide"],
    "mode": "TARGET",
    "target_quote_qty": float(scenario["targetQuoteQty"]),
    "route": {
        "mode": "AUTO", "allowed_exchanges": ["GATE", "BINANCE"], "prefer_exchange": "GATE",
        "split_allowed": False, "max_venue_count": 2, "max_slippage_bps": 40, "min_depth_notional": 500,
    },
}
routed, audit = route_signals([signal], venue_snapshot=payload["venueSnapshot"], positions=positions)
actions = []
for item in routed:
    kind = str(item.get("_shadow_action_kind") or "")
    side = str(item.get("_shadow_execution_side") or "")
    quantity = float(item.get("_shadow_delta_quote_qty") or 0)
    if kind and side and quantity > 0:
        actions.append({"kind": kind, "symbol": str(item["symbol"]), "venue": str(item.get("exchange") or ""), "side": side, "quoteQuantity": str(quantity)})
json.dump({"actions": actions, "routed": routed, "audit": audit}, sys.stdout, separators=(",", ":"))

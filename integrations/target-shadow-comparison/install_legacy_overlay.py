from __future__ import annotations

import os
from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    if text.count(old) != 1:
        raise SystemExit(f"overlay anchor mismatch: {path}: {text.count(old)}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def install_strategy(path: Path) -> None:
    replace_once(path, "import argparse\nimport json", "import argparse\nimport hashlib\nimport json")
    replace_once(path, 'STATE_CONTRACT_VERSION = 1\n', '''STATE_CONTRACT_VERSION = 1


def _attach_state_fingerprint(payload: Dict[str, Any]) -> str:
    meta = payload.setdefault("meta", {})
    meta.pop("state_fingerprint", None)
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    fingerprint = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    meta["state_fingerprint"] = fingerprint
    return fingerprint
''')
    lines = path.read_text(encoding="utf-8").splitlines()
    render_indexes = [i for i, line in enumerate(lines) if line.strip() == "rendered = json.dumps(payload, ensure_ascii=False)"]
    if len(render_indexes) != 2:
        raise SystemExit("strategy render anchors mismatch")
    for index in reversed(render_indexes):
        if index == 0 or lines[index - 1].strip() != "_attach_state_fingerprint(payload)":
            indent = lines[index][:-len(lines[index].lstrip())]
            lines.insert(index, indent + "_attach_state_fingerprint(payload)")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def install_signal_emitter(path: Path) -> None:
    replace_once(path, "    default_valid_for_minutes: int,\n) -> Dict[str, Any]:", "    default_valid_for_minutes: int,\n    source_meta: Optional[Mapping[str, Any]] = None,\n) -> Dict[str, Any]:")
    replace_once(path, '            "default_strategy_tag": default_strategy_tag,\n', '            "default_strategy_tag": default_strategy_tag,\n            "source_state_fingerprint": str((source_meta or {}).get("state_fingerprint") or ""),\n')
    replace_once(path, "        default_valid_for_minutes=int(args.valid_for_minutes),\n    )", "        default_valid_for_minutes=int(args.valid_for_minutes),\n        source_meta=raw.get(\"meta\") if isinstance(raw, Mapping) and isinstance(raw.get(\"meta\"), Mapping) else None,\n    )")


def install_providers(path: Path) -> None:
    marker = "def load_signals_from_command(command: str, *, cwd: Optional[Path] = None) -> List[Dict[str, Any]]:\n"
    block = '''def load_signal_payload_from_command(command: str, *, cwd: Optional[Path] = None) -> Dict[str, Any]:
    payload = _run_json_command(command, cwd=cwd)
    return payload if isinstance(payload, dict) else {"signals": payload if isinstance(payload, list) else [], "meta": {}}


def normalize_signal_payload(payload: Any) -> List[Dict[str, Any]]:
    rows = payload.get("signals", []) if isinstance(payload, dict) else payload if isinstance(payload, list) else []
    signals: List[Dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            parsed = parse_signal_row(row)
            if parsed:
                signals.append(parsed)
    return signals


'''
    replace_once(path, marker, block + marker)
    text = path.read_text(encoding="utf-8")
    start = text.index(marker) + len(marker)
    payload_line = "    payload = _run_json_command(command, cwd=cwd)"
    next_function = text.find("\n\ndef ", start)
    function_body = text[start:next_function if next_function != -1 else len(text)]
    if payload_line in function_body:
        text = text[:start] + text[start:].replace(payload_line, "    return normalize_signal_payload(load_signal_payload_from_command(command, cwd=cwd))", 1)
        body_start = text.index("    rows: List[Dict[str, Any]] = []", start)
        body_end = text.index("\n\n\ndef load_price_snapshot_from_command", body_start)
        text = text[:body_start] + text[body_end + 2:]
        path.write_text(text, encoding="utf-8")


def install_router(path: Path) -> None:
    replace_once(path, '            child["target_quote_qty"] = 0.0\n            child.pop("target_qty", None)\n            audit["selected"].append({"exchange": exchange, "reason": "flatten_opposite_position"})', '            child["target_quote_qty"] = 0.0\n            child.pop("target_qty", None)\n            child["_shadow_action_kind"] = "FLATTEN"\n            child["_shadow_execution_side"] = "SELL" if position_side_label(dict(position)) == "LONG" else "BUY"\n            child["_shadow_delta_quote_qty"] = _position_notional(position)\n            audit["selected"].append({"exchange": exchange, "reason": "flatten_opposite_position"})')
    replace_once(path, '                child["target_quote_qty"] = 0.0\n                child.pop("target_qty", None)\n                children.append(child)', '                child["target_quote_qty"] = 0.0\n                child.pop("target_qty", None)\n                child["_shadow_action_kind"] = "FLATTEN"\n                child["_shadow_execution_side"] = "SELL" if position_side_label(dict(position)) == "LONG" else "BUY"\n                child["_shadow_delta_quote_qty"] = _position_notional(position)\n                children.append(child)')
    replace_once(path, '                child["target_quote_qty"] = venue_target\n                child.pop("target_qty", None)\n                children.append(child)', '                child["target_quote_qty"] = venue_target\n                child.pop("target_qty", None)\n                delta_notional = max(current_notional - venue_target, 0.0)\n                if delta_notional > 0:\n                    child["_shadow_action_kind"] = "REDUCE"\n                    child["_shadow_execution_side"] = "SELL" if target_side == "LONG" else "BUY"\n                    child["_shadow_delta_quote_qty"] = delta_notional\n                children.append(child)')
    replace_once(path, '            children.append(child)\n            used.add(exchange)', '            child["_shadow_action_kind"] = "OPEN"\n            child["_shadow_execution_side"] = normalize_side(signal.get("side"))\n            child["_shadow_delta_quote_qty"] = float(amount)\n            children.append(child)\n            used.add(exchange)')


def install_adapter(path: Path) -> None:
    replace_once(path, "import sys\nfrom pathlib import Path", "import os\nimport sys\nfrom decimal import Decimal, InvalidOperation\nfrom pathlib import Path")
    text = path.read_text(encoding="utf-8")
    text = text.replace("from .providers import load_signals_from_command", "from .providers import load_signal_payload_from_command, load_signals_from_command, normalize_signal_payload")
    text = text.replace("from strategy.providers import load_signals_from_command", "from strategy.providers import load_signal_payload_from_command, load_signals_from_command, normalize_signal_payload")
    path.write_text(text, encoding="utf-8")
    replace_once(path, "def execute_signal_bridge_command_with_audit(", '''def _shadow_actions_from_routed_signals(signals: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    actions: List[Dict[str, str]] = []
    for signal in signals:
        kind = str(signal.get("_shadow_action_kind") or "").strip().upper()
        side = str(signal.get("_shadow_execution_side") or "").strip().upper()
        symbol = str(signal.get("symbol") or "").strip().upper()
        exchange = str(signal.get("exchange") or symbol.split("_", 1)[0]).strip().upper()
        try:
            quantity = float(signal.get("_shadow_delta_quote_qty") or 0.0)
        except (TypeError, ValueError):
            quantity = 0.0
        if kind in {"FLATTEN", "REDUCE", "OPEN"} and side in {"BUY", "SELL"} and symbol and exchange and quantity > 0:
            actions.append({"kind": kind, "symbol": symbol, "venue": exchange, "side": side, "quoteQuantity": str(quantity)})
    return actions


def _project_shadow_action_clips(actions: List[Dict[str, str]], clip_notional: str) -> List[Dict[str, str]]:
    try:
        limit = Decimal(str(clip_notional))
        if not limit.is_finite() or limit <= 0:
            return []
    except (InvalidOperation, ValueError):
        return []
    projected: List[Dict[str, str]] = []
    for action in actions:
        try:
            remaining = Decimal(str(action.get("quoteQuantity") or "0"))
        except (InvalidOperation, ValueError):
            return []
        if not remaining.is_finite() or remaining <= 0:
            return []
        count = int((remaining / limit).to_integral_value(rounding="ROUND_CEILING"))
        for index in range(count):
            amount = min(remaining, limit)
            projected.append({**action, "quoteQuantity": format(amount, "f"), "clipIndex": str(index + 1), "clipCount": str(count)})
            remaining -= amount
    return projected


def execute_signal_bridge_command_with_audit(''')
    replace_once(path, "    signals = load_signals_from_command(command, cwd=cwd)\n    protection_entries = _protection_entries_from_book(book_file)", "    signal_payload = load_signal_payload_from_command(command, cwd=cwd)\n    signals = normalize_signal_payload(signal_payload)\n    source_meta = signal_payload.get(\"meta\") if isinstance(signal_payload.get(\"meta\"), Mapping) else {}\n    source_state_fingerprint = str(source_meta.get(\"source_state_fingerprint\") or \"\").strip()\n    protection_entries = _protection_entries_from_book(book_file)")
    replace_once(path, '        "signal_source": str(command),\n        "signal_count": len(signals),', '        "signal_source": str(command),\n        "target_request_hash": source_state_fingerprint,\n        "shadow_actions": _shadow_actions_from_routed_signals(routed_signals),\n        "signal_count": len(signals),')
    replace_once(path, '    combined_audit: Dict[str, Any] = {\n        "signal_source": str(command),\n        "target_request_hash": source_state_fingerprint,\n        "shadow_actions": _shadow_actions_from_routed_signals(routed_signals),', '    shadow_actions = _shadow_actions_from_routed_signals(routed_signals)\n    projected_clip_notional = str(os.environ.get("GCT_SHADOW_PROJECTED_CLIP_NOTIONAL") or "").strip()\n    try:\n        projected_limit = Decimal(projected_clip_notional)\n        projected_limit_valid = projected_limit.is_finite() and projected_limit > 0\n    except (InvalidOperation, ValueError):\n        projected_limit_valid = False\n    projected_shadow_actions = _project_shadow_action_clips(shadow_actions, projected_clip_notional) if projected_limit_valid else None\n    combined_audit: Dict[str, Any] = {\n        "signal_source": str(command),\n        "target_request_hash": source_state_fingerprint,\n        "shadow_actions": shadow_actions,\n        **({"projected_shadow_actions": projected_shadow_actions, "projected_clip_notional": projected_clip_notional} if projected_shadow_actions is not None else {}),')


def main() -> None:
    root = Path(os.environ.get("TARGET_ROOT", "/"))
    target = lambda absolute: root / absolute.lstrip("/")
    install_strategy(target("/opt/future/binance-exchange/scripts/emit_real_trading_state_mainline.py"))
    install_signal_emitter(target("/opt/future/real-trading/scripts/emit_gate_crossex_state_signals.py"))
    install_providers(target("/opt/future/real-trading/Gate CrossEx/strategy/providers.py"))
    install_router(target("/opt/future/real-trading/Gate CrossEx/strategy/router.py"))
    install_adapter(target("/opt/future/real-trading/Gate CrossEx/strategy/adapter.py"))
    print("legacy target fingerprint overlay installed")


if __name__ == "__main__":
    main()

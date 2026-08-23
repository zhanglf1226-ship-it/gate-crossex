# TARGET shadow comparison legacy overlay

This overlay adds a trusted source-state fingerprint and explicit shadow action evidence to the existing strategy/Bridge production chain without changing order routing or execution decisions.

## Data chain

1. Mainline state emitter hashes the complete state before adding `meta.state_fingerprint`.
2. State-to-signal emitter maps it to `meta.source_state_fingerprint`, including empty states.
3. Bridge adapter records it as `target_request_hash`.
4. TARGET router annotates routed TARGET children with explicit action kind, execution side and delta quote notional.
5. Bridge audit publishes normalized `shadow_actions`.
6. Cloud Canary reads the latest audit from a server-configured fixed directory and compares only when the source fingerprint matches the Shadow plan.

Missing fingerprints, stale audits, wrong sources or missing explicit actions are `UNCOMPARABLE`; they can never become a false `MATCH`.

## Install safely

Run `install_legacy_overlay.py` first against a copied tree using `TARGET_ROOT`. Compile all five candidate files. Back up the production files under `/opt/future/env-backup`, run the installer without `TARGET_ROOT`, compile production files, then restart only the mainline state service and Bridge. Roll back all five files together on any failure.

The overlay must not change credentials, Gate 17840, order execution configuration, protection state or live-write switches.

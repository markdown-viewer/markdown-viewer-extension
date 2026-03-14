# Licensing (MVP) — Execution Baseline v0.1 (Frozen)

This folder contains the frozen technical spec for MVP licensing/billing.

## Frozen baseline (DO NOT change in W3)
### Product/Platform
- Product: **Markdown Viewer Pro** (B2C browser extension)
- Platform: **Chrome first** (Edge compatible)

### Pricing/Payment
- Pricing: **Lifetime ¥79** (Early bird **¥49**)
- Payment (Phase 1): **Stripe**
- Key delivery (Frozen): **Stripe success page uses `session_id` to query backend and fetch `licenseKey`**

### Licensing
- Mode: **Minimal backend license** (no heavy account system / no strong DRM)
- Device limit: **max_devices = 3**
- Device UX: extension supports `deactivate` (current device); admin supports `reset_devices` / `revoke`

### Offline policy (Frozen)
- `token_exp = 90d`
- `expiring_notice = 7d`
- `grace = 7d`
- Time rollback protection: persist `lastServerTime` and require refresh if local clock is rolled back > 24h

### Crypto (Frozen)
- Entitlement token signing: **Ed25519**
  - Server signs with private key (Cloudflare Worker)
  - Extension verifies offline with embedded public key
  - **Do not use HS256** (shared secret would ship to users and break offline verification)

### Backend stack (Frozen)
- Cloudflare **Worker + D1**

## Files
- `openapi.yaml` — Licensing API + Stripe session key delivery endpoint
- `schema.sql` — D1/SQLite schema for `licenses` and `activations`
- `state-machine.md` — Extension state machine + gating rules + UI hints + required telemetry
- `W3-issue-breakdown.md` — W3 breakdown and DoD
- `W3_issues_v0.1.md` — DoD checklist mirroring PRD Appendix A (Frozen)

## Implementation rule (must-follow)
- Any Pro entrypoint MUST call a single gate function: `canUseProFeature(state)` (no scattered if/else).
- Any gating/copy/state-related issue MUST reference **PRD v0.1 Appendix A (Frozen)** and use `W3_issues_v0.1.md` as DoD checklist.

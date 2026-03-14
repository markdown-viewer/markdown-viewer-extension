# W3 Issue Breakdown — Execution Baseline v0.1

This is the canonical W3 breakdown derived from frozen PRD v0.1 + Licensing Spec v0.1.

## W3 Definition of Done
End-to-end flow works:
1) Stripe checkout (Phase 1) → success page can fetch `licenseKey`
2) Extension activates with `licenseKey` → receives `entitlementToken`
3) Offline use within token window (90d)
4) Expiring notice (7d) → grace (7d) → expired locks Pro
5) Online refresh rolls token window
6) Device limit max=3 enforced; current device can deactivate
7) Admin can revoke license + reset devices
8) Telemetry for deactivate + device_limit_hit

## Epic
- [EPIC] W3 - Licensing minimal backend + Pro gating + Stripe key delivery

## Backend (Worker + D1)
1. D1 migration: `licenses`, `activations` (+ indexes + unique)
2. API: POST `/v1/licenses/activate`
3. API: POST `/v1/licenses/refresh`
4. API: POST `/v1/licenses/deactivate`
5. Token signing + verification spec (no HS256; prefer Ed25519, fallback RS256)
6. Admin: revoke/reset/query (internal)
7. Rate limit + logging (MVP)

## Billing (Stripe Phase 1)
8. Checkout session creation (lifetime: ¥79; early bird: ¥49)
9. Success page key delivery: `GET /v1/billing/checkout-session?session_id=...` (paid-only)

## Extension
10. deviceId generation + persistence (UUIDv4)
11. State machine implementation (UNACTIVATED/ACTIVE/EXPIRING_SOON/GRACE/EXPIRED/REVOKED)
12. Refresh scheduler (startup + daily) w/ offline tolerance
13. Pro gating: unify `canUseProFeature(state)` across all Pro entrypoints
14. Settings UI: enter license key → activate; deactivate current device
15. Telemetry: deactivate_* + device_limit_hit

## QA
16. E2E manual checklist (device limit, deactivate, revoke, offline expiry, grace, time rollback)

## Notes for issues
Every gating/UI-related issue must link PRD v0.1 Appendix A (Frozen) and include its A1/A2 checklist items in DoD.

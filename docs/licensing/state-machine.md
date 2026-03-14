# Licensing State Machine (Extension) — Execution Baseline v0.1

This document is the frozen implementation reference for the extension-side license state machine, offline refresh policy, and UI rules.

## Frozen parameters
- `token_exp = 90d`
- `expiring_notice = 7d`
- `grace = 7d`
- `max_devices = 3`

## Frozen state enum
- `UNACTIVATED`
- `ACTIVE`
- `EXPIRING_SOON`
- `GRACE`
- `EXPIRED`
- `REVOKED`

## Token model
The backend mints a signed `entitlementToken` (JWT-like payload). The extension must:
- verify signature offline
- read `exp` (unix seconds)
- enforce device binding (payload contains `deviceId`)

### Signing algorithm (important)
- **DO NOT use HS256** if the extension needs offline verification (shared secret would ship to users).
- Recommended: **Ed25519** (server signs with private key; extension verifies with embedded public key). If browser crypto support becomes an issue, use **RS256**.

## Time rollback protection (MVP-level)
Persist `lastServerTimeMs` (from API response). On startup / before Pro use:
- if `nowMs < lastServerTimeMs - 24h`: force online refresh (treat as `EXPIRED` until refreshed)

This prevents infinite extension of expired entitlements via manual clock rollback.

## State derivation
Inputs:
- `token` (string | null)
- `tokenPayload` (decoded after signature verification)
- `nowMs = Date.now()`
- `expMs = tokenPayload.exp * 1000`

Derived thresholds:
- `expiringSoonAtMs = expMs - 7d`
- `graceUntilMs = expMs + 7d`

Rules:
1. If no token → `UNACTIVATED`
2. If server returned revoked (or refresh/activate returns `LICENSE_REVOKED`) → `REVOKED`
3. If `nowMs < expiringSoonAtMs` → `ACTIVE`
4. If `expiringSoonAtMs <= nowMs <= expMs` → `EXPIRING_SOON`
5. If `expMs < nowMs <= graceUntilMs` → `GRACE`
6. If `nowMs > graceUntilMs` → `EXPIRED`

## Pro gating (must be consistent everywhere)
All Pro entrypoints MUST call the same gate:

```ts
export type LicenseState =
  | 'UNACTIVATED'
  | 'ACTIVE'
  | 'EXPIRING_SOON'
  | 'GRACE'
  | 'EXPIRED'
  | 'REVOKED';

type ProGateDecision =
  | { allow: true; showRefreshHint?: boolean }
  | { allow: false; reason: 'NEED_ACTIVATION' | 'NEED_REFRESH' | 'REVOKED' };

export function canUseProFeature(state: LicenseState): ProGateDecision {
  switch (state) {
    case 'ACTIVE':
    case 'EXPIRING_SOON':
      return { allow: true };
    case 'GRACE':
      return { allow: true, showRefreshHint: true };
    case 'UNACTIVATED':
      return { allow: false, reason: 'NEED_ACTIVATION' };
    case 'EXPIRED':
      return { allow: false, reason: 'NEED_REFRESH' };
    case 'REVOKED':
      return { allow: false, reason: 'REVOKED' };
  }
}
```

### Pro features (frozen list)
Any access to the following must be gated:
- PDF export
- print templates / advanced print controls
- Mermaid rendering
- Pro themes
- Profiles

## UI rules
- `UNACTIVATED`: show paywall with CTA: "Buy" + "Enter License Key"
- `EXPIRING_SOON`: show non-blocking banner: "Connect to refresh in X days"
- `GRACE`: allow Pro, but show blocking-ish hint (toast/banner) on Pro action: "Please connect to refresh"
- `EXPIRED`: block Pro, show: "Connect to refresh" + "Support"
- `REVOKED`: block Pro, show: "License revoked" + "Support"

## Required telemetry (device management)
- `deactivate_click`
- `deactivate_success`
- `deactivate_fail` (include `error_code`)
- `device_limit_hit` (when backend returns `DEVICE_LIMIT`)

Minimum event props:
- `state`
- `feature` (optional)
- `error_code` (on fail)

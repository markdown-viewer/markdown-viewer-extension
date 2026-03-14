# W3 Issues v0.1 (Frozen)

> Source of truth: PRD v0.1 + Appendix A (Frozen) + Licensing Spec (Execution Baseline v0.1)

This file is intended to be referenced from GitHub issues. Every gating / copy / state-related issue MUST link:
- PRD v0.1 Appendix A (Frozen)
- This checklist as DoD

## Frozen parameters
- token_exp=90d
- expiring_notice=7d
- grace=7d
- max_devices=3
- extension supports: deactivate
- admin supports: reset_devices, revoke

## DoD checklist (A1+A2 mirror)
### Paywall / copy (A1)
- [ ] UNACTIVATED: any Pro entrypoint shows paywall (Buy + Enter License Key)
- [ ] EXPIRING_SOON: non-blocking banner indicates refresh needed in <=7d
- [ ] GRACE: Pro is allowed, but shows strong refresh hint on Pro action
- [ ] EXPIRED: blocks Pro, shows "Connect to refresh" + Support entry
- [ ] REVOKED: blocks Pro, shows "License revoked" + Support entry
- [ ] All Pro entrypoints use a single gate: `canUseProFeature(state)`

### Telemetry (A2)
- [ ] activate_click / activate_success / activate_fail (with error_code)
- [ ] refresh_attempt / refresh_success / refresh_fail (with error_code)
- [ ] paywall_show (include feature + state)
- [ ] purchase_click (from paywall)
- [ ] deactivate_click / deactivate_success / deactivate_fail
- [ ] device_limit_hit (backend returns DEVICE_LIMIT)

## Issue breakdown
See `docs/licensing/W3-issue-breakdown.md` for the full breakdown and DoD.

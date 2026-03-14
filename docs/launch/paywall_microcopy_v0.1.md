# Paywall Microcopy — v0.1 (Frozen)

> Single source of truth for paywall + state hints copy.  
> Must match PRD v0.1 Appendix A (Frozen) behaviors and the extension state machine.

## Tone
- Clear, neutral, non-pushy.
- Avoid store-payment wording. Use “license key” and “purchase on website”.

---

## UNACTIVATED (paywall)
- Title: TBD
- Body: TBD
- Primary CTA: **Purchase Pro License**
- Secondary CTA: **Enter License Key**

## EXPIRING_SOON (banner)
- Copy: TBD (non-blocking)

## GRACE (strong hint)
- Copy: TBD (allow Pro but require refresh soon)

## EXPIRED (blocking)
- Title: TBD
- Body: TBD
- Primary CTA: **Connect to Refresh**
- Secondary CTA: **Contact Support**

## REVOKED (blocking)
- Title: TBD
- Body: TBD
- Primary CTA: **Contact Support**

---

## Error code → user-facing message (MVP)
- DEVICE_LIMIT: TBD
- LICENSE_INVALID: TBD
- LICENSE_REVOKED: TBD
- LICENSE_EXPIRED: TBD
- INVALID_TOKEN: TBD

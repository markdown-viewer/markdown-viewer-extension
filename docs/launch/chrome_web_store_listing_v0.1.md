# Chrome Web Store Listing — v0.1 (Frozen)

> NOTE: This file is the single source of truth for store listing copy.  
> Keep wording consistent with Launch v0.1 baseline (Chrome / B2C / Lifetime / Stripe / License Key).

## Guardrails (review checklist)
- Use **GitHub-style** (not “GitHub official”). Avoid implying affiliation.
- Monetization wording: **“Unlock Pro with a license key / Purchase a Pro license on our website”**.
- Avoid “in-app purchase”, “Chrome Web Store subscription”, or similar store-payment implications.
- Prefer value proposition in short description; pricing can live in FAQ/CTA.

---

## Short description (<= 132 chars)
TBD

## Keywords
TBD

## Title
TBD

## Detailed description
TBD

## Privacy summary (user-facing)
TBD

## FAQ
- **How do I unlock Pro?**
  - Purchase a Pro license on our website and paste the license key in the extension.
- **How many devices can I use?**
  - Up to 3 devices per license (MVP v0.1).
- **Does it work offline?**
  - Yes. Pro stays available offline and refreshes periodically when online.

## Compliance notes (internal)
- Payment happens off-store (Stripe Phase 1).
- License validation calls backend (Cloudflare Worker/D1).

-- D1 / SQLite schema (MVP Licensing, Execution Baseline v0.1)
-- Frozen params: max_devices=3 (default), token_exp=90d (implemented in app)

PRAGMA foreign_keys = ON;

-- Licenses are minted by billing flow (Stripe Phase 1) and later activated by devices.
CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'pro_lifetime',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  max_devices INTEGER NOT NULL DEFAULT 3,
  email TEXT,
  stripe_customer_id TEXT,
  stripe_checkout_session_id TEXT,
  expires_at TEXT, -- nullable ISO8601, null for lifetime
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_session ON licenses(stripe_checkout_session_id);

CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  deactivated_at TEXT,
  app_version TEXT,
  browser TEXT,
  FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE,
  UNIQUE (license_key, device_id)
);

CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_key);
CREATE INDEX IF NOT EXISTS idx_activations_active ON activations(license_key, deactivated_at);

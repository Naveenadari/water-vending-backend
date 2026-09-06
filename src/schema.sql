-- Run this once against your Render PostgreSQL database
-- (Render dashboard -> your Postgres -> "Connect" -> psql, then paste this file)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS vendors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  phone         TEXT,
  upi_id        TEXT,                 -- vendor's own UPI VPA, e.g. vendorname@okhdfcbank
  admin_pin     TEXT NOT NULL,        -- simple PIN for vendor app login (MVP auth)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  device_token  UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,  -- goes into ESP32 firmware
  name          TEXT NOT NULL DEFAULT 'Tap 1',
  is_online     BOOLEAN NOT NULL DEFAULT false,
  last_seen     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS presets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  slot_index    INT NOT NULL,          -- 0..3 (V1..V4)
  pulses        BIGINT NOT NULL DEFAULT 0,
  price_rupees  INT NOT NULL DEFAULT 0,
  UNIQUE(device_id, slot_index)
);

CREATE TABLE IF NOT EXISTS settings (
  device_id       UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  timeout_seconds INT NOT NULL DEFAULT 30,
  pulses_per_rupee INT NOT NULL DEFAULT 20,
  topup_amount    INT NOT NULL DEFAULT 100,
  trip_cost       INT NOT NULL DEFAULT 20,
  confirm_mode    BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  uid           TEXT NOT NULL,
  balance       INT NOT NULL DEFAULT 0,
  is_master     BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(device_id, uid)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  vendor_id     UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,         -- 'app' | 'coin' | 'card' | 'upi'
  amount_rupees INT,
  pulses        BIGINT,
  status        TEXT NOT NULL DEFAULT 'completed', -- 'completed' | 'refunded' | 'cancelled'
  raw_note      TEXT,                  -- e.g. raw notification text, for audit
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_device ON transactions(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_vendor ON devices(vendor_id);

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Protects provisioning endpoints - only YOU (the machine builder) should
// create vendors/devices. Set ADMIN_KEY in Render env vars and keep it secret.
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Create a new vendor (you do this once per customer who buys a machine)
router.post('/', requireAdmin, async (req, res) => {
  const { name, phone, upi_id, admin_pin } = req.body;
  if (!name || !phone || !admin_pin) {
    return res.status(400).json({ error: 'name, phone, admin_pin are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO vendors (name, phone, upi_id, admin_pin)
       VALUES ($1, $2, $3, $4) RETURNING id, name, phone, upi_id, created_at`,
      [name, phone, upi_id || null, admin_pin]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create vendor' });
  }
});

// Public self-signup, used by the vendor app's "Sign up" screen. No admin
// key needed. Creates the vendor account AND, in the same step, claims the
// machine identified by claim_code (the code printed on that machine's
// sticker/QR) - so that machine becomes linked to this vendor only, and no
// other vendor's app can see or control it. If the code is invalid or was
// already claimed by someone else, the vendor account is rolled back so we
// don't leave an orphaned account behind.
router.post('/signup', async (req, res) => {
  const { name, phone, pin, claim_code } = req.body;
  if (!name || !phone || !pin || !claim_code) {
    return res.status(400).json({ error: 'name, phone, pin and claim_code are required' });
  }
  try {
    const existing = await pool.query(`SELECT id FROM vendors WHERE phone = $1`, [phone]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This phone number is already registered' });
    }

    const vendorResult = await pool.query(
      `INSERT INTO vendors (name, phone, admin_pin) VALUES ($1, $2, $3)
       RETURNING id, name, phone, upi_id, is_activated`,
      [name, phone, pin]
    );
    const vendor = vendorResult.rows[0];

    const claimResult = await pool.query(
      `UPDATE devices SET vendor_id = $1
       WHERE claim_code = $2 AND vendor_id IS NULL
       RETURNING id, name`,
      [vendor.id, claim_code.trim().toUpperCase()]
    );

    if (claimResult.rows.length === 0) {
      await pool.query(`DELETE FROM vendors WHERE id = $1`, [vendor.id]);
      return res.status(400).json({ error: 'Invalid or already-used machine code' });
    }

    res.status(201).json({ vendor, device: claimResult.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'signup failed' });
  }
});

// Simple login for the vendor app (MVP auth - phone + PIN)
// Returns the vendor_id which the app stores and uses as a bearer token
// for socket connections and the webhook endpoint.
router.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
  try {
    const result = await pool.query(
      `SELECT id, name, phone, upi_id, is_activated FROM vendors WHERE phone = $1 AND admin_pin = $2`,
      [phone, pin]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'invalid phone or pin' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'login failed' });
  }
});

// Public - the Activate screen fetches the current one-time activation price.
// IMPORTANT: these literal-path GET routes (activation-price, support-phone)
// must be declared BEFORE the generic GET '/:id' route below. Express tries
// routes in the order they're registered, so if '/:id' came first it would
// swallow requests like "/support-phone" (treating "support-phone" as the
// id) and wrongly apply requireAdmin to them - which is exactly the bug that
// was breaking the Contact tab's support number.
router.get('/activation-price', async (req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'activation_price_rupees'`);
    res.json({ price_rupees: Number(result.rows[0]?.value || 0) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch activation price' });
  }
});

// Admin-only - you set/change this any time from admin-tool.html.
router.post('/activation-price', requireAdmin, async (req, res) => {
  const { price_rupees } = req.body;
  if (!price_rupees || Number(price_rupees) <= 0) {
    return res.status(400).json({ error: 'price_rupees required' });
  }
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('activation_price_rupees', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(price_rupees)]
    );
    res.json({ ok: true, price_rupees: Number(price_rupees) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to update activation price' });
  }
});

// Public - the Contact tab fetches the vendor support number.
router.get('/support-phone', async (req, res) => {
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'support_phone_number'`);
    res.json({ phone: result.rows[0]?.value || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch support phone' });
  }
});

// Admin-only - set/change from admin-tool.html any time.
router.post('/support-phone', requireAdmin, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('support_phone_number', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [phone]
    );
    res.json({ ok: true, phone });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to update support phone' });
  }
});

// Called after the app has already verified phone ownership via Firebase
// OTP (client-side) - resets the PIN with no need for the old one.
router.post('/reset-pin', async (req, res) => {
  const { phone, new_pin } = req.body;
  if (!phone || !new_pin) return res.status(400).json({ error: 'phone and new_pin required' });
  try {
    const result = await pool.query(
      `UPDATE vendors SET admin_pin = $1 WHERE phone = $2 RETURNING id`,
      [new_pin, phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'no vendor with that phone number' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to reset PIN' });
  }
});

// Generic "get vendor by id" - kept admin-only. Constrained to digits only
// (id(\d+)) and declared LAST among GET routes so it can never intercept a
// literal path like /support-phone or /activation-price ever again, even if
// more such routes are added above in the future.
router.get('/:id(\\d+)', requireAdmin, async (req, res) => {
  const result = await pool.query(`SELECT id, name, phone, upi_id, created_at FROM vendors WHERE id = $1`, [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
});

module.exports = { router, requireAdmin };

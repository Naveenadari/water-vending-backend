const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdmin } = require('./vendors');

const router = express.Router();

const VALVE_NAMES = ['Normal', 'Cooling'];

function generateClaimCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
  let code = 'SOL-';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

// Create a device - this generates the device_token that goes straight into
// the ESP32 firmware. vendor_id is now OPTIONAL: leave it out to create an
// "unclaimed" machine (ready to hand to a vendor), who links it to their
// account later via POST /claim during sign up, using the claim_code printed
// on the machine's sticker/QR. Sets up BOTH taps (Normal=0, Cooling=1).
router.post('/', requireAdmin, async (req, res) => {
  const { vendor_id, name, claim_code } = req.body;
  const code = claim_code || generateClaimCode();
  try {
    const result = await pool.query(
      `INSERT INTO devices (vendor_id, name, claim_code) VALUES ($1, $2, $3)
       RETURNING id, vendor_id, device_token, name, claim_code, created_at`,
      [vendor_id || null, name || 'Tap 1', code]
    );
    const device = result.rows[0];

    // Shared, device-level settings (one row per device) - topup/timeout/confirm_mode
    await pool.query(`INSERT INTO device_settings (device_id) VALUES ($1)`, [device.id]);

    // Per-valve settings + 2 presets each (Normal=0, Cooling=1)
    for (const valve of [0, 1]) {
      await pool.query(`INSERT INTO settings (device_id, valve) VALUES ($1, $2)`, [device.id, valve]);
      for (let slot = 0; slot < 2; slot++) {
        await pool.query(
          `INSERT INTO presets (device_id, valve, slot_index, pulses, price_rupees) VALUES ($1, $2, $3, 0, 0)`,
          [device.id, valve, slot]
        );
      }
    }

    res.status(201).json(device);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create device' });
  }
});

// Link an unclaimed device to a vendor account by its printed claim_code.
// Used directly by the vendor-app signup flow (see routes/vendors.js).
// Fails if the code doesn't exist or has already been claimed by someone else.
router.post('/claim', async (req, res) => {
  const { claim_code, vendor_id } = req.body;
  if (!claim_code || !vendor_id) {
    return res.status(400).json({ error: 'claim_code and vendor_id required' });
  }
  try {
    const result = await pool.query(
      `UPDATE devices SET vendor_id = $1
       WHERE claim_code = $2 AND vendor_id IS NULL
       RETURNING id, name`,
      [vendor_id, claim_code.trim().toUpperCase()]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or already-used machine code' });
    }
    res.json({ device: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to claim device' });
  }
});

// List all devices for a vendor (used by the vendor app home screen)
router.get('/vendor/:vendorId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, is_online, last_seen, created_at
       FROM devices WHERE vendor_id = $1 ORDER BY created_at`,
      [req.params.vendorId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to list devices' });
  }
});

// Full detail for one device: shared settings + BOTH valves' settings/presets
// + recent transactions (each tagged with which valve it came from).
router.get('/:deviceId', async (req, res) => {
  try {
    const deviceQ = await pool.query(`SELECT * FROM devices WHERE id = $1`, [req.params.deviceId]);
    if (deviceQ.rows.length === 0) return res.status(404).json({ error: 'not found' });

    const [deviceSettingsQ, settingsQ, presetsQ, txQ] = await Promise.all([
      pool.query(
        `SELECT topup_amount, timeout_seconds, confirm_mode FROM device_settings WHERE device_id = $1`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT valve, pulses_per_rupee, trip_cost FROM settings WHERE device_id = $1 ORDER BY valve`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT valve, slot_index, pulses FROM presets
         WHERE device_id = $1 AND slot_index IN (0, 1) ORDER BY valve, slot_index`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT id, valve, source, amount_rupees, pulses, status, created_at
         FROM transactions WHERE device_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.deviceId]
      )
    ]);

    // Group settings/presets by valve so the app can render "Normal" and
    // "Cooling" as two clean sections without doing this matching itself.
    const valves = [0, 1].map((v) => ({
      valve: v,
      name: VALVE_NAMES[v],
      settings: settingsQ.rows.find((r) => r.valve === v) || { pulses_per_rupee: 20, trip_cost: 20 },
      presets: presetsQ.rows.filter((r) => r.valve === v),
    }));

    res.json({
      device: deviceQ.rows[0],
      device_settings: deviceSettingsQ.rows[0] || { topup_amount: 100, timeout_seconds: 30, confirm_mode: true },
      valves,
      recent_transactions: txQ.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch device' });
  }
});

module.exports = router;

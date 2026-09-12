const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('./vendors');

const router = express.Router();

const VALVE_NAMES = ['Normal', 'Cooling'];

// Create a device for a vendor - this generates the device_token that goes
// straight into the ESP32 firmware. Sets up BOTH taps (Normal=0, Cooling=1):
// one shared device_settings row, plus per-valve settings + 2 presets each
// (matches the firmware's 2-preset-per-tap model).
router.post('/', requireAdmin, async (req, res) => {
  const { vendor_id, name } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
  try {
    const result = await pool.query(
      `INSERT INTO devices (vendor_id, name) VALUES ($1, $2)
       RETURNING id, vendor_id, device_token, name, created_at`,
      [vendor_id, name || 'Tap 1']
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

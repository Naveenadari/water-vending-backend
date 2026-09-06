const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('./vendors');

const router = express.Router();

// Create a device for a vendor - this generates the device_token that goes
// straight into the ESP32 firmware (replaces BLYNK_AUTH_TOKEN).
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

    // Default settings row + 4 empty presets, so the device has something
    // sane to read on first connect.
    await pool.query(`INSERT INTO settings (device_id) VALUES ($1)`, [device.id]);
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `INSERT INTO presets (device_id, slot_index, pulses, price_rupees) VALUES ($1, $2, 0, 0)`,
        [device.id, i]
      );
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

// Full detail for one device: settings + presets + recent transactions
router.get('/:deviceId', async (req, res) => {
  try {
    const deviceQ = await pool.query(`SELECT * FROM devices WHERE id = $1`, [req.params.deviceId]);
    if (deviceQ.rows.length === 0) return res.status(404).json({ error: 'not found' });

    const [settingsQ, presetsQ, txQ] = await Promise.all([
      pool.query(`SELECT * FROM settings WHERE device_id = $1`, [req.params.deviceId]),
      pool.query(`SELECT * FROM presets WHERE device_id = $1 ORDER BY slot_index`, [req.params.deviceId]),
      pool.query(
        `SELECT id, source, amount_rupees, pulses, status, created_at
         FROM transactions WHERE device_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.deviceId]
      )
    ]);

    res.json({
      device: deviceQ.rows[0],
      settings: settingsQ.rows[0],
      presets: presetsQ.rows,
      recent_transactions: txQ.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch device' });
  }
});

module.exports = router;

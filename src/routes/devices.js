const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdmin } = require('./vendors');

const router = express.Router();

const VALVE_NAMES = ['Normal', 'Cooling'];

// Normal water (valve 0) now has a 3rd preset button (Button 3) in addition
// to the original 2; Cooling (valve 1) keeps its original 2. Centralized
// here so device-creation and the self-heal check below always agree.
function slotsForValve(valve, hardware) {
  if (hardware === 'upi_only') return 4; // unchanged: UPI-only machines already had 4
  return valve === 0 ? 3 : 2;
}

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
  const { vendor_id, name, claim_code, valve_count, payment_hardware } = req.body;
  const code = claim_code || generateClaimCode();
  const valveCount = [1, 2].includes(Number(valve_count)) ? Number(valve_count) : 2;
  const hardware = payment_hardware === 'upi_only' ? 'upi_only' : 'full';
  const valves = valveCount === 1 ? [0] : [0, 1]; // single tap = Normal (valve 0) only

  try {
    const result = await pool.query(
      `INSERT INTO devices (vendor_id, name, claim_code, valve_count, payment_hardware)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, vendor_id, device_token, name, claim_code, valve_count, payment_hardware, created_at`,
      [vendor_id || null, name || 'Tap 1', code, valveCount, hardware]
    );
    const device = result.rows[0];

    // Shared, device-level settings (one row per device) - topup/timeout/confirm_mode
    await pool.query(`INSERT INTO device_settings (device_id) VALUES ($1)`, [device.id]);

    // Per-valve settings + presets (Normal now gets 3 preset slots, Cooling
    // keeps 2; UPI-only machines keep 4 for both - see slotsForValve above)
    for (const valve of valves) {
      await pool.query(`INSERT INTO settings (device_id, valve) VALUES ($1, $2)`, [device.id, valve]);
      const slotCount = slotsForValve(valve, hardware);
      for (let slot = 0; slot < slotCount; slot++) {
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
    const device = deviceQ.rows[0];

    // Self-heal: devices provisioned BEFORE Normal water's 3rd preset button
    // existed only have slot_index 0/1 rows in `presets` for valve 0. Rather
    // than requiring a one-off manual database command, fill in whatever's
    // missing right here - this route already runs every ~15s from the
    // vendor app's polling, so any device gets the missing row(s) added the
    // next time it's read, with no downtime or manual step needed.
    const valveIndices = device.valve_count === 1 ? [0] : [0, 1];
    for (const valve of valveIndices) {
      const requiredSlots = slotsForValve(valve, device.payment_hardware);
      const existingQ = await pool.query(
        `SELECT slot_index FROM presets WHERE device_id = $1 AND valve = $2`,
        [req.params.deviceId, valve]
      );
      const existingSlots = new Set(existingQ.rows.map((r) => r.slot_index));
      for (let slot = 0; slot < requiredSlots; slot++) {
        if (!existingSlots.has(slot)) {
          await pool.query(
            `INSERT INTO presets (device_id, valve, slot_index, pulses, price_rupees) VALUES ($1, $2, $3, 0, 0)`,
            [req.params.deviceId, valve, slot]
          );
        }
      }
    }

    const [deviceSettingsQ, settingsQ, presetsQ, qrPricesQ, txQ] = await Promise.all([
      pool.query(
        `SELECT topup_amount, timeout_seconds, confirm_mode, pulses_per_liter FROM device_settings WHERE device_id = $1`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT valve, pulses_per_rupee, trip_cost FROM settings WHERE device_id = $1 ORDER BY valve`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT valve, slot_index, pulses FROM presets
         WHERE device_id = $1 ORDER BY valve, slot_index`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT valve, slot_index, price_rupees, pulses FROM qr_prices
         WHERE device_id = $1 ORDER BY valve, slot_index`,
        [req.params.deviceId]
      ),
      pool.query(
        `SELECT id, valve, source, amount_rupees, pulses, status, created_at
         FROM transactions WHERE device_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.deviceId]
      )
    ]);

    // Group settings/presets by valve so the app can render each tap as a
    // clean section without doing this matching itself. Only build entries
    // for the valves this specific machine actually has (1 for single tap,
    // 2 for dual tap) - showing a fake "Cooling" section on a single-tap
    // machine would be wrong.
    const valves = valveIndices.map((v) => ({
      valve: v,
      name: VALVE_NAMES[v],
      settings: settingsQ.rows.find((r) => r.valve === v) || { pulses_per_rupee: 20, trip_cost: 20 },
      presets: presetsQ.rows.filter((r) => r.valve === v),
      qr_prices: qrPricesQ.rows.filter((r) => r.valve === v),
    }));

    res.json({
      device,
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

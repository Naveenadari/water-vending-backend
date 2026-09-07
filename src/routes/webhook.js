const express = require('express');
const { pool } = require('../db');
const { matchAndConsume } = require('../sessionManager');
const { sendToDevice } = require('../socket/deviceWs');

const router = express.Router();

// Called by the companion Android app (Notification Listener) on the
// vendor's phone whenever a "payment received" notification appears.
// Body: { phone, pin, amount, raw_text }
// (phone+pin re-used as a lightweight bearer since this app only ever
// belongs to one vendor - fine for MVP, tighten later with a real token.)
router.post('/notification', async (req, res) => {
  const { phone, pin, amount, raw_text } = req.body;
  if (!phone || !pin || !amount) {
    return res.status(400).json({ error: 'phone, pin, amount required' });
  }

  try {
    const vendorQ = await pool.query(
      `SELECT id FROM vendors WHERE phone = $1 AND admin_pin = $2`,
      [phone, pin]
    );
    if (vendorQ.rows.length === 0) return res.status(401).json({ error: 'invalid vendor credentials' });
    const vendorId = vendorQ.rows[0].id;

    const session = matchAndConsume(vendorId, Number(amount));
    if (!session) {
      // No machine was waiting for this amount right now - log it, don't fail.
      console.log(`No pending session matched vendor=${vendorId} amount=${amount}`);
      return res.json({ matched: false });
    }

    // Fetch device's trip cost -> pulses to dispense (fallback: amount * pulses_per_rupee)
    const settingsQ = await pool.query(`SELECT * FROM settings WHERE device_id = $1`, [session.deviceId]);
    const settings = settingsQ.rows[0];
    const pulses = settings ? Number(amount) * settings.pulses_per_rupee : 0;

    await pool.query(
      `INSERT INTO transactions (device_id, vendor_id, source, amount_rupees, pulses, status, raw_note)
       VALUES ($1, $2, 'upi', $3, $4, 'completed', $5)`,
      [session.deviceId, vendorId, amount, pulses, raw_text || null]
    );

    // Tell the ESP32 to open the valve, via the raw device WebSocket.
    sendToDevice(session.deviceId, {
      type: 'dispense',
      source: 'upi',
      pulses,
      order_id: session.orderId
    });

    // Also let the vendor app know, for live dashboard updates.
    const io = req.app.get('io');
    io.of('/app').to(`vendor:${vendorId}`).emit('payment_matched', {
      device_id: session.deviceId,
      amount: Number(amount),
      order_id: session.orderId
    });

    res.json({ matched: true, device_id: session.deviceId, pulses });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to process notification' });
  }
});

module.exports = router;

const express = require('express');
const { pool } = require('../db');
const { sendToDevice } = require('../socket/deviceWs');

const router = express.Router();

// Called by the companion Android app (Notification Listener) whenever a
// "payment received" notification appears on the vendor's ONE dedicated
// UPI Business app. No physical button press on the machine is needed -
// the amount alone determines which valve/volume to dispense, matched
// against qr_prices (the same per-button price table also used by the
// Razorpay flow - set in the app's Settings tab).
// Body: { phone, pin, amount, raw_text }
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

    const matchQ = await pool.query(
      `SELECT qp.device_id, qp.valve, qp.pulses
       FROM qr_prices qp
       JOIN devices d ON d.id = qp.device_id
       WHERE d.vendor_id = $1 AND qp.price_rupees = $2`,
      [vendorId, Number(amount)]
    );

    if (matchQ.rows.length === 0) {
      // Unlike Razorpay, there's no API to auto-refund a plain UPI payment
      // sent to a personal/business UPI ID - the money has already landed.
      // Just log it so the vendor can investigate/manually refund if needed.
      console.log(`No price matches vendor=${vendorId} amount=${amount} - not dispensing (cannot auto-refund this payment method)`);
      return res.json({ matched: false });
    }

    const { device_id, valve, pulses } = matchQ.rows[0];

    await pool.query(
      `INSERT INTO transactions (device_id, vendor_id, valve, source, amount_rupees, pulses, status, raw_note)
       VALUES ($1, $2, $3, 'upi', $4, $5, 'completed', $6)`,
      [device_id, vendorId, valve, amount, pulses, raw_text || null]
    );

    const delivered = sendToDevice(device_id, {
      type: 'dispense',
      valve,
      pulses,
      source: 'upi',
    });

    const io = req.app.get('io');
    if (io) {
      io.of('/app').to(`vendor:${vendorId}`).emit('payment_matched', {
        device_id, valve, amount: Number(amount),
      });
    }

    res.json({ matched: true, device_id, valve, pulses, delivered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to process notification' });
  }
});

module.exports = router;

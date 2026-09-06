const express = require('express');
const { pool } = require('../db');
const { createSession, cancelSession } = require('../sessionManager');

const router = express.Router();

// Called by the ESP32 / kiosk screen when a customer picks an amount.
// Body: { device_token, amount }
// Returns an order id + a upi:// deep link the kiosk can render as a QR.
router.post('/request', async (req, res) => {
  const { device_token, amount } = req.body;
  if (!device_token || !amount) {
    return res.status(400).json({ error: 'device_token and amount required' });
  }
  try {
    const deviceQ = await pool.query(
      `SELECT d.id AS device_id, d.vendor_id, v.upi_id, v.name AS vendor_name
       FROM devices d JOIN vendors v ON v.id = d.vendor_id
       WHERE d.device_token = $1`,
      [device_token]
    );
    if (deviceQ.rows.length === 0) return res.status(404).json({ error: 'unknown device' });
    const { device_id, vendor_id, upi_id, vendor_name } = deviceQ.rows[0];
    if (!upi_id) return res.status(400).json({ error: 'vendor has no UPI ID configured' });

    const session = createSession(vendor_id, device_id, Number(amount));

    const upiUri = `upi://pay?pa=${encodeURIComponent(upi_id)}&pn=${encodeURIComponent(vendor_name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(session.orderId)}`;

    res.json({ order_id: session.orderId, upi_uri: upiUri, amount: Number(amount), expires_in_seconds: 300 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create payment request' });
  }
});

// Called by the ESP32 / kiosk if the customer cancels before paying.
router.post('/cancel', async (req, res) => {
  const { device_token, order_id } = req.body;
  try {
    const deviceQ = await pool.query(`SELECT vendor_id FROM devices WHERE device_token = $1`, [device_token]);
    if (deviceQ.rows.length === 0) return res.status(404).json({ error: 'unknown device' });
    cancelSession(deviceQ.rows[0].vendor_id, order_id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to cancel' });
  }
});

module.exports = router;

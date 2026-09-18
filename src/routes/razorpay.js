const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { pool } = require('../db');
const { sendToDevice } = require('../socket/deviceWs');

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create (or return the existing) single QR code for a device. Call this
// once when a vendor switches a machine to Razorpay mode (or wants to
// reprint the sticker). The QR has NO fixed amount - the customer pays
// whatever amount matches the valve they want (see the webhook below,
// which looks up the valve by matching the amount paid).
router.post('/qr', async (req, res) => {
  const { device_id, vendor_id } = req.body;
  if (!device_id || !vendor_id) {
    return res.status(400).json({ error: 'device_id and vendor_id required' });
  }
  try {
    const deviceRes = await pool.query(
      `SELECT id, vendor_id, razorpay_qr_id, name FROM devices WHERE id = $1`,
      [device_id]
    );
    const device = deviceRes.rows[0];
    if (!device || device.vendor_id !== vendor_id) {
      return res.status(403).json({ error: 'not your device' });
    }

    if (device.razorpay_qr_id) {
      try {
        const existing = await razorpay.qrCode.fetch(device.razorpay_qr_id);
        if (existing.status === 'active') {
          return res.json({ qr_id: existing.id, image_url: existing.image_url });
        }
      } catch (e) {
        // fall through and create a new one if the old one can't be fetched
      }
    }

    const qr = await razorpay.qrCode.create({
      type: 'upi_qr',
      usage: 'multiple_use',
      fixed_amount: false,
      description: `Sol Electronics - ${device.name || device_id}`,
      notes: { device_id, vendor_id },
    });

    await pool.query(`UPDATE devices SET razorpay_qr_id = $1 WHERE id = $2`, [qr.id, device_id]);
    res.json({ qr_id: qr.id, image_url: qr.image_url });
  } catch (err) {
    console.error('razorpay qr create failed', err);
    res.status(500).json({ error: 'failed to create QR code' });
  }
});

// This account's webhook is shared with the water-management app (Razorpay
// account plan only allows one webhook). Anything that isn't a vending-
// machine QR payment gets forwarded here, untouched, so water-management
// keeps working exactly as before.
const WATER_MANAGEMENT_WEBHOOK_URL = 'https://water-vending-server.onrender.com/webhook';

async function forwardToWaterManagement(rawBody, signature) {
  try {
    await fetch(WATER_MANAGEMENT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
      },
      body: rawBody,
    });
  } catch (err) {
    console.error('failed to forward webhook to water-management', err);
  }
}

// Razorpay calls this on EVERY payment on the account (shared webhook -
// see forwardToWaterManagement above). Register this exact URL in
// Razorpay Dashboard -> Settings -> Webhooks (replacing the old one):
//   https://<your-backend>.onrender.com/api/razorpay/webhook
// Keep it subscribed to whatever events it already was. Keep the SAME
// webhook secret - copy it into RAZORPAY_WEBHOOK_SECRET on Render.
router.post('/webhook', async (req, res) => {
  console.log('razorpay webhook: request received');
  let signature, expected;
  try {
    signature = req.headers['x-razorpay-signature'];
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET is not set');
    }
    if (!req.rawBody) {
      throw new Error('req.rawBody missing - check express.json() verify hook in server.js');
    }
    expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('hex');
  } catch (setupErr) {
    // NEVER let a config problem crash the whole server - just fail this
    // one request loudly in the logs so it's easy to spot and fix.
    console.error('razorpay webhook: signature setup failed -', setupErr.message);
    return res.status(500).json({ error: 'webhook misconfigured' });
  }

  if (!signature || signature !== expected) {
    console.warn('razorpay webhook: signature mismatch');
    return res.status(400).json({ error: 'invalid signature' });
  }

  // Acknowledge immediately - Razorpay retries aggressively if we're slow,
  // and we don't want a slow DB query to cause duplicate webhook retries.
  res.json({ received: true });

  try {
    const event = req.body;
    console.log('razorpay webhook: event =', event.event);

    // App-activation one-time payment, made via a Payment Link. Payment
    // Links on this account fire as "payment.captured" (not
    // "payment_link.paid" - that event isn't subscribed here), so we read
    // the notes straight off the payment entity, which inherits them from
    // the link it was created against.
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const notes = payment.notes || {};
      if (notes.purpose === 'app_activation' && notes.vendor_id) {
        const already = await pool.query(`SELECT is_activated FROM vendors WHERE id = $1`, [notes.vendor_id]);
        if (already.rows[0] && !already.rows[0].is_activated) {
          await pool.query(`UPDATE vendors SET is_activated = true WHERE id = $1`, [notes.vendor_id]);
          console.log(`razorpay webhook: vendor ${notes.vendor_id} activated (payment ${payment.id})`);
        } else {
          console.log(`razorpay webhook: vendor ${notes.vendor_id} already activated, ignoring duplicate payment ${payment.id}`);
        }
        return;
      }
      // A payment.captured that ISN'T an activation payment - it's not one
      // of ours (vending payments arrive via qr_code.credited instead), so
      // hand it to water-management.
      console.log('razorpay webhook: payment.captured with no matching purpose, forwarding to water-management');
      await forwardToWaterManagement(req.rawBody, signature);
      return;
    }

    // QR-code payments arrive as "qr_code.credited" - THIS is where the
    // qr_code id actually lives, not on payment.captured (which is what we
    // were checking before - it never has qr_code_id, hence "undefined").
    if (event.event !== 'qr_code.credited') {
      console.log('razorpay webhook: not qr_code.credited, forwarding to water-management');
      await forwardToWaterManagement(req.rawBody, signature);
      return;
    }

    const payment = event.payload.payment.entity;
    const qrCodeId = event.payload.qr_code.entity.id;
    const amountRupees = payment.amount / 100;
    console.log(`razorpay webhook: payment ${payment.id}, amount ₹${amountRupees}, qr_code_id=${qrCodeId}`);

    const device = qrCodeId
      ? (await pool.query(`SELECT id, vendor_id FROM devices WHERE razorpay_qr_id = $1`, [qrCodeId])).rows[0]
      : null;

    if (!device) {
      console.log('razorpay webhook: qr_code_id does not match any vending device - forwarding to water-management');
      await forwardToWaterManagement(req.rawBody, signature);
      return;
    }
    console.log(`razorpay webhook: matched vending device ${device.id}`);

    const settingsRes = await pool.query(
      `SELECT valve, pulses FROM qr_prices WHERE device_id = $1 AND price_rupees = $2`,
      [device.id, amountRupees]
    );
    const matched = settingsRes.rows[0];

    if (!matched) {
      console.log(`razorpay webhook: ₹${amountRupees} doesn't match either valve's price on device ${device.id} - refunding`);
      // Amount doesn't match either valve's price - can't fulfil it, so
      // refund immediately rather than silently keeping the customer's money.
      await pool.query(
        `INSERT INTO razorpay_payments (vendor_id, device_id, valve, razorpay_payment_id, amount_rupees, status)
         VALUES ($1, $2, NULL, $3, $4, 'unmatched')
         ON CONFLICT (razorpay_payment_id) DO NOTHING`,
        [device.vendor_id, device.id, payment.id, amountRupees]
      );
      try {
        const refund = await razorpay.payments.refund(payment.id, {});
        await pool.query(
          `UPDATE razorpay_payments SET status = 'refunded', refund_id = $1, refund_amount = $2
           WHERE razorpay_payment_id = $3`,
          [refund.id, refund.amount / 100, payment.id]
        );
        console.log(`razorpay webhook: refunded ${payment.id}`);
      } catch (refundErr) {
        console.error('razorpay auto-refund (unmatched amount) failed', refundErr);
      }
      return;
    }
    console.log(`razorpay webhook: matched valve ${matched.valve}, ${matched.pulses} pulses - sending dispense`);

    const delivered = sendToDevice(device.id, {
      type: 'dispense',
      valve: matched.valve,
      pulses: matched.pulses,
      source: 'razorpay',
      razorpay_payment_id: payment.id,
    });
    console.log(`razorpay webhook: sendToDevice returned delivered=${delivered}`);

    await pool.query(
      `INSERT INTO razorpay_payments (vendor_id, device_id, valve, razorpay_payment_id, amount_rupees, status, dispensed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (razorpay_payment_id) DO NOTHING`,
      [device.vendor_id, device.id, matched.valve, payment.id, amountRupees,
        delivered ? 'dispensed' : 'captured', delivered]
    );

    if (!delivered) {
      console.warn(`razorpay payment ${payment.id} captured but device ${device.id} is offline - could not dispense`);
    }
  } catch (err) {
    console.error('razorpay webhook processing failed', err);
  }
});

// Vendor sets/edits a valve's Razorpay trigger price + quantity - e.g.
// "pay Rs 10, get 20L Normal water". This is a plain DB value, not sent to
// the firmware at all (unlike the manual button presets) - the webhook
// above reads it directly when matching an incoming payment amount.
router.post('/price', async (req, res) => {
  const { device_id, vendor_id, valve, slot_index, price_rupees, litres } = req.body;
  if (!device_id || !vendor_id || valve === undefined || slot_index === undefined || !price_rupees || !litres) {
    return res.status(400).json({ error: 'device_id, vendor_id, valve, slot_index, price_rupees and litres are required' });
  }
  try {
    const deviceRes = await pool.query(`SELECT vendor_id FROM devices WHERE id = $1`, [device_id]);
    if (!deviceRes.rows[0] || deviceRes.rows[0].vendor_id !== vendor_id) {
      return res.status(403).json({ error: 'not your device' });
    }
    const settingsRes = await pool.query(
      `SELECT pulses_per_liter FROM device_settings WHERE device_id = $1`, [device_id]
    );
    const pulsesPerLiter = settingsRes.rows[0]?.pulses_per_liter || 240;
    const pulses = Math.round(litres * pulsesPerLiter);
    await pool.query(
      `INSERT INTO qr_prices (device_id, valve, slot_index, price_rupees, pulses)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_id, valve, slot_index)
       DO UPDATE SET price_rupees = $4, pulses = $5`,
      [device_id, valve, slot_index, price_rupees, pulses]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      // the (device_id, price_rupees) unique constraint - two buttons on
      // this machine can't share the same amount, since amount alone is
      // what identifies which button was paid for
      return res.status(400).json({ error: 'Another button on this machine already uses that exact price - pick a different amount' });
    }
    console.error('razorpay price update failed', err);
    res.status(500).json({ error: 'failed to save price' });
  }
});

// Vendor switches a machine's payment collection method - no code/DB
// migration needed each time, just flips this column.
router.post('/payment-mode', async (req, res) => {
  const { device_id, vendor_id, payment_mode } = req.body;
  if (!device_id || !vendor_id || !['macrodroid', 'razorpay'].includes(payment_mode)) {
    return res.status(400).json({ error: 'device_id, vendor_id and a valid payment_mode are required' });
  }
  try {
    const result = await pool.query(
      `UPDATE devices SET payment_mode = $1 WHERE id = $2 AND vendor_id = $3 RETURNING id, payment_mode`,
      [payment_mode, device_id, vendor_id]
    );
    if (result.rows.length === 0) return res.status(403).json({ error: 'not your device' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('payment mode update failed', err);
    res.status(500).json({ error: 'failed to update payment mode' });
  }
});

// Creates a one-time Razorpay Payment Link for a newly signed-up vendor's
// app-activation fee. The vendor_id is tagged in `notes` so the webhook
// (payment_link.paid, handled below) knows whose account to activate.
router.post('/activation-payment-link', async (req, res) => {
  const { vendor_id, vendor_name, vendor_phone } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
  try {
    const priceQ = await pool.query(`SELECT value FROM app_settings WHERE key = 'activation_price_rupees'`);
    const priceRupees = Number(priceQ.rows[0]?.value || 0);
    if (!priceRupees) return res.status(500).json({ error: 'activation price not configured' });

    const link = await razorpay.paymentLink.create({
      amount: Math.round(priceRupees * 100),
      currency: 'INR',
      accept_partial: false,
      description: 'Sol Electronics - App activation',
      customer: { name: vendor_name || undefined, contact: vendor_phone || undefined },
      notify: { sms: false, email: false },
      notes: { vendor_id, purpose: 'app_activation' },
    });

    res.json({ payment_link_url: link.short_url, price_rupees: priceRupees });
  } catch (err) {
    console.error('activation payment link creation failed', err);
    res.status(500).json({ error: 'failed to create payment link' });
  }
});

// Vendor app polls this after opening the payment link, to know when to
// transition into the main app.
router.get('/activation-status/:vendorId', async (req, res) => {
  try {
    const result = await pool.query(`SELECT is_activated FROM vendors WHERE id = $1`, [req.params.vendorId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'vendor not found' });
    res.json({ is_activated: result.rows[0].is_activated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to check activation status' });
  }
});

module.exports = router;

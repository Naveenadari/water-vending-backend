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

// Simple login for the vendor app (MVP auth - phone + PIN)
// Returns the vendor_id which the app stores and uses as a bearer token
// for socket connections and the webhook endpoint.
router.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
  try {
    const result = await pool.query(
      `SELECT id, name, phone, upi_id FROM vendors WHERE phone = $1 AND admin_pin = $2`,
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

router.get('/:id', requireAdmin, async (req, res) => {
  const result = await pool.query(`SELECT id, name, phone, upi_id, created_at FROM vendors WHERE id = $1`, [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(result.rows[0]);
});

module.exports = { router, requireAdmin };

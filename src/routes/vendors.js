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

// TEMPORARY one-time migration helper - copies every table's schema + rows
// from THIS backend's own database (whatever DATABASE_URL currently points
// to) into another Postgres database given by connection string. Used once
// to move from the old (soon-to-expire) Render Postgres to a new provider,
// without needing raw TCP access from anywhere except this server itself
// (which already talks to Postgres fine). Admin-key gated. Safe to call more
// than once - every insert is ON CONFLICT DO NOTHING, so re-running just
// fills in anything new since the last run. Remove this route once the
// migration is confirmed working and no longer needed.
router.post('/admin/migrate-db', requireAdmin, async (req, res) => {
  const { target_url } = req.body;
  if (!target_url) return res.status(400).json({ error: 'target_url required' });

  const { Client } = require('pg');
  const target = new Client({ connectionString: target_url, ssl: { rejectUnauthorized: false } });
  const report = { tables: {}, errors: [] };

  try {
    await target.connect();
    try {
      await target.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (e) {
      report.errors.push('pgcrypto: ' + e.message);
    }

    const tablesResult = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const tableNames = tablesResult.rows.map((r) => r.table_name);

    for (const table of tableNames) {
      try {
        const colsResult = await pool.query(
          `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
          [table]
        );
        const pkResult = await pool.query(
          `SELECT kcu.column_name FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'`,
          [table]
        );
        const pkCols = pkResult.rows.map((r) => r.column_name);
        const colTypes = {};

        const colDefs = colsResult.rows.map((c) => {
          colTypes[c.column_name] = c.data_type;
          let type = c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
          if (c.data_type === 'character varying' && c.character_maximum_length) {
            type = `varchar(${c.character_maximum_length})`;
          }
          let def = `"${c.column_name}" ${type}`;
          if (c.column_default && !c.column_default.includes('nextval(')) {
            def += ` DEFAULT ${c.column_default}`;
          }
          if (c.is_nullable === 'NO') def += ' NOT NULL';
          return def;
        });

        let createSql = `CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')}`;
        if (pkCols.length > 0) {
          createSql += `, PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(', ')})`;
        }
        createSql += ')';
        await target.query(createSql);

        const dataResult = await pool.query(`SELECT * FROM "${table}"`);
        let inserted = 0;
        for (const row of dataResult.rows) {
          const cols = Object.keys(row);
          const values = cols.map((c) => {
            const v = row[c];
            if ((colTypes[c] === 'json' || colTypes[c] === 'jsonb') && v !== null) {
              return JSON.stringify(v);
            }
            return v;
          });
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const colList = cols.map((c) => `"${c}"`).join(', ');
          const onConflict =
            pkCols.length > 0
              ? ` ON CONFLICT (${pkCols.map((c) => `"${c}"`).join(', ')}) DO NOTHING`
              : '';
          try {
            await target.query(
              `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})${onConflict}`,
              values
            );
            inserted++;
          } catch (rowErr) {
            report.errors.push(`${table} row insert: ${rowErr.message}`);
          }
        }
        report.tables[table] = { total: dataResult.rows.length, inserted };
      } catch (tableErr) {
        report.errors.push(`${table}: ${tableErr.message}`);
      }
    }

    await target.end();
    res.json(report);
  } catch (err) {
    try {
      await target.end();
    } catch (e) {
      /* ignore */
    }
    console.error(err);
    res.status(500).json({ error: 'migration failed', detail: err.message, report });
  }
});

// TEMPORARY - re-applies every UNIQUE constraint found on a SOURCE Postgres
// database onto a TARGET Postgres database, given two connection strings.
// Needed because the old migration (admin/migrate-db) copied columns and
// primary keys but not UNIQUE constraints (e.g. qr_prices' per-button
// uniqueness, devices.device_token). Safe to run more than once. Remove this
// route once no longer needed.
router.post('/admin/sync-unique-constraints-v2', requireAdmin, async (req, res) => {
  const { source_url, target_url } = req.body;
  if (!source_url || !target_url) {
    return res.status(400).json({ error: 'source_url and target_url required' });
  }

  const { Client } = require('pg');
  const source = new Client({ connectionString: source_url, ssl: { rejectUnauthorized: false } });
  const target = new Client({ connectionString: target_url, ssl: { rejectUnauthorized: false } });
  const report = { applied: [], errors: [] };

  try {
    await source.connect();
    await target.connect();

    const constraintsResult = await source.query(`
      SELECT tc.table_name, tc.constraint_name,
             array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema='public' AND tc.constraint_type='UNIQUE'
      GROUP BY tc.table_name, tc.constraint_name
    `);

    for (const row of constraintsResult.rows) {
      const colsArr = Array.isArray(row.cols)
        ? row.cols
        : String(row.cols).replace(/^\{|\}$/g, '').split(',');
      const cols = colsArr.map((c) => `"${c}"`).join(', ');
      const sql = `ALTER TABLE "${row.table_name}" ADD CONSTRAINT "${row.constraint_name}" UNIQUE (${cols})`;
      try {
        await target.query(sql);
        report.applied.push(`${row.table_name}: ${row.constraint_name} (${colsArr.join(', ')})`);
      } catch (e) {
        if (e.code === '42710' || /already exists/i.test(e.message)) {
          report.applied.push(`${row.table_name}: ${row.constraint_name} (already existed)`);
        } else {
          report.errors.push(`${row.table_name} ${row.constraint_name}: ${e.message}`);
        }
      }
    }

    await source.end();
    await target.end();
    res.json(report);
  } catch (err) {
    try {
      await source.end();
    } catch (e) {
      /* ignore */
    }
    try {
      await target.end();
    } catch (e) {
      /* ignore */
    }
    console.error(err);
    res.status(500).json({ error: 'sync failed', detail: err.message, report });
  }
});

module.exports = { router, requireAdmin };

const { pool } = require('../db');

function setupSockets(io) {
  const deviceNs = io.of('/device');
  const appNs = io.of('/app');

  // ---------------- ESP32 connections ----------------
  // ESP32 connects with: io("wss://yourapp.onrender.com/device", { query: { token: DEVICE_TOKEN } })
  deviceNs.use(async (socket, next) => {
    const token = socket.handshake.query.token;
    if (!token) return next(new Error('missing device token'));
    try {
      const result = await pool.query(
        `SELECT id, vendor_id, name FROM devices WHERE device_token = $1`,
        [token]
      );
      if (result.rows.length === 0) return next(new Error('invalid device token'));
      socket.device = result.rows[0];
      next();
    } catch (err) {
      next(new Error('auth failed'));
    }
  });

  deviceNs.on('connection', async (socket) => {
    const { id: deviceId, vendor_id: vendorId } = socket.device;
    socket.join(`device:${deviceId}`);
    console.log(`Device connected: ${deviceId}`);

    await pool.query(`UPDATE devices SET is_online = true, last_seen = now() WHERE id = $1`, [deviceId]);
    appNs.to(`vendor:${vendorId}`).emit('device_online', { device_id: deviceId });

    // Live status updates: { flow_lpm, valve_open, delivered_pulses, target_pulses }
    socket.on('status', (payload) => {
      appNs.to(`vendor:${vendorId}`).emit('device_status', { device_id: deviceId, ...payload });
    });

    // Device reports a locally-completed transaction (coin or card dispense)
    socket.on('transaction', async (payload) => {
      try {
        await pool.query(
          `INSERT INTO transactions (device_id, vendor_id, source, amount_rupees, pulses, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [deviceId, vendorId, payload.source, payload.amount_rupees || null, payload.pulses || null, payload.status || 'completed']
        );
        appNs.to(`vendor:${vendorId}`).emit('new_transaction', { device_id: deviceId, ...payload });
      } catch (err) {
        console.error('failed to log transaction', err);
      }
    });

    // Device reports updated preset/settings values (e.g. after calibration save)
    socket.on('settings_update', async (payload) => {
      try {
        if (payload.presets) {
          for (const p of payload.presets) {
            await pool.query(
              `UPDATE presets SET pulses = $1 WHERE device_id = $2 AND slot_index = $3`,
              [p.pulses, deviceId, p.slot_index]
            );
          }
        }
        if (payload.settings) {
          const s = payload.settings;
          await pool.query(
            `UPDATE settings SET timeout_seconds = COALESCE($1, timeout_seconds),
                                  pulses_per_rupee = COALESCE($2, pulses_per_rupee),
                                  topup_amount = COALESCE($3, topup_amount),
                                  trip_cost = COALESCE($4, trip_cost),
                                  confirm_mode = COALESCE($5, confirm_mode)
             WHERE device_id = $6`,
            [s.timeout_seconds, s.pulses_per_rupee, s.topup_amount, s.trip_cost, s.confirm_mode, deviceId]
          );
        }
        appNs.to(`vendor:${vendorId}`).emit('settings_synced', { device_id: deviceId });
      } catch (err) {
        console.error('failed to save settings_update', err);
      }
    });

    socket.on('disconnect', async () => {
      console.log(`Device disconnected: ${deviceId}`);
      await pool.query(`UPDATE devices SET is_online = false, last_seen = now() WHERE id = $1`, [deviceId]);
      appNs.to(`vendor:${vendorId}`).emit('device_offline', { device_id: deviceId });
    });
  });

  // ---------------- Vendor app connections ----------------
  // App connects with: io("wss://yourapp.onrender.com/app", { query: { vendor_id: VENDOR_ID } })
  // (vendor_id obtained from POST /api/vendors/login)
  appNs.use(async (socket, next) => {
    const vendorId = socket.handshake.query.vendor_id;
    if (!vendorId) return next(new Error('missing vendor_id'));
    try {
      const result = await pool.query(`SELECT id FROM vendors WHERE id = $1`, [vendorId]);
      if (result.rows.length === 0) return next(new Error('invalid vendor_id'));
      socket.vendorId = vendorId;
      next();
    } catch (err) {
      next(new Error('auth failed'));
    }
  });

  appNs.on('connection', (socket) => {
    socket.join(`vendor:${socket.vendorId}`);
    console.log(`Vendor app connected: ${socket.vendorId}`);

    // App sends a control command for one of its devices:
    // { device_id, type: 'open_valve' | 'stop' | 'save_preset' | 'save_settings' | ... , ...extra }
    socket.on('command', (payload) => {
      if (!payload || !payload.device_id) return;
      deviceNs.to(`device:${payload.device_id}`).emit('command', payload);
    });

    socket.on('disconnect', () => {
      console.log(`Vendor app disconnected: ${socket.vendorId}`);
    });
  });
}

module.exports = { setupSockets };

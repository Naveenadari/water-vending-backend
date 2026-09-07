const { pool } = require('../db');
const { sendToDevice } = require('./deviceWs');

// Sets up the Socket.IO namespace for vendor apps only.
// ESP32 devices connect separately via raw WebSocket (see deviceWs.js).
function setupSockets(io) {
  const appNs = io.of('/app');

  // App connects with: io("wss://yourapp.onrender.com/app", { query: { vendor_id: VENDOR_ID } })
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
      const delivered = sendToDevice(payload.device_id, payload);
      if (!delivered) {
        socket.emit('command_failed', { device_id: payload.device_id, reason: 'device offline' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Vendor app disconnected: ${socket.vendorId}`);
    });
  });

  return appNs;
}

module.exports = { setupSockets };

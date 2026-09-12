const { WebSocketServer } = require('ws');
const url = require('url');
const { pool } = require('../db');

// deviceId -> { ws, vendorId }
const deviceConnections = new Map();

// Sends a JSON command to a device if it's currently connected.
// Returns true if delivered, false if the device is offline.
// NOTE: still keyed by deviceId only - ONE ESP32 = ONE WebSocket connection,
// carrying BOTH valves (Normal=0, Cooling=1). Every command payload you send
// must include a "valve" field so the firmware knows which tap it's for.
function sendToDevice(deviceId, payload) {
  const conn = deviceConnections.get(deviceId);
  if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
  conn.ws.send(JSON.stringify(payload));
  return true;
}

function isDeviceOnline(deviceId) {
  const conn = deviceConnections.get(deviceId);
  return !!(conn && conn.ws.readyState === conn.ws.OPEN);
}

// Attaches a raw WebSocket server to the existing HTTP server at path /device.
// ESP32 connects with: ws://host/device?token=DEVICE_TOKEN
// Every message the device sends must be a single JSON object with a "type"
// field, and (NEW) a "valve" field: 0 = Normal tap, 1 = Cooling tap.
function setupDeviceWebSocket(httpServer, appNs) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);
    if (pathname !== '/device') return; // let socket.io handle its own upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, query);
    });
  });

  wss.on('connection', async (ws, request, query) => {
    const token = query.token;
    if (!token) { ws.close(4001, 'missing token'); return; }

    let deviceRow;
    try {
      const result = await pool.query(
        `SELECT id, vendor_id, name FROM devices WHERE device_token = $1`,
        [token]
      );
      if (result.rows.length === 0) { ws.close(4002, 'invalid token'); return; }
      deviceRow = result.rows[0];
    } catch (err) {
      console.error('device auth failed', err);
      ws.close(4003, 'auth error');
      return;
    }

    const deviceId = deviceRow.id;
    const vendorId = deviceRow.vendor_id;
    deviceConnections.set(deviceId, { ws, vendorId });
    console.log(`Device connected (ws): ${deviceId}`);

    await pool.query(`UPDATE devices SET is_online = true, last_seen = now() WHERE id = $1`, [deviceId]);
    appNs.to(`vendor:${vendorId}`).emit('device_online', { device_id: deviceId });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || !msg.type) return;

      // NEW: normalize valve to 0 or 1 (defaults to 0 = Normal if a device
      // sends an old-style message without a valve field, so this stays
      // backward compatible with single-valve firmware during rollout).
      const valve = (msg.valve === 1) ? 1 : 0;

      switch (msg.type) {
        case 'status':
          // { type:'status', valve, flow_lpm, valve_open, delivered_pulses, target_pulses }
          appNs.to(`vendor:${vendorId}`).emit('device_status', { device_id: deviceId, ...msg, valve });
          break;

        case 'transaction':
          // { type:'transaction', valve, source, amount_rupees, pulses, status }
          try {
            await pool.query(
              `INSERT INTO transactions (device_id, vendor_id, valve, source, amount_rupees, pulses, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [deviceId, vendorId, valve, msg.source, msg.amount_rupees || null, msg.pulses || null, msg.status || 'completed']
            );
            appNs.to(`vendor:${vendorId}`).emit('new_transaction', { device_id: deviceId, ...msg, valve });
          } catch (err) {
            console.error('failed to log transaction', err);
          }
          break;

        case 'settings_update':
          // { type:'settings_update', valve, presets:[{slot_index,pulses}], settings:{...} }
          try {
            if (msg.presets) {
              for (const p of msg.presets) {
                await pool.query(
                  `UPDATE presets SET pulses = $1 WHERE device_id = $2 AND valve = $3 AND slot_index = $4`,
                  [p.pulses, deviceId, valve, p.slot_index]
                );
              }
            }
            if (msg.settings) {
              const s = msg.settings;
              await pool.query(
                `UPDATE settings SET timeout_seconds = COALESCE($1, timeout_seconds),
                                      pulses_per_rupee = COALESCE($2, pulses_per_rupee),
                                      topup_amount = COALESCE($3, topup_amount),
                                      trip_cost = COALESCE($4, trip_cost),
                                      confirm_mode = COALESCE($5, confirm_mode)
                 WHERE device_id = $6 AND valve = $7`,
                [s.timeout_seconds, s.pulses_per_rupee, s.topup_amount, s.trip_cost, s.confirm_mode, deviceId, valve]
              );
            }
            appNs.to(`vendor:${vendorId}`).emit('settings_synced', { device_id: deviceId, valve });
          } catch (err) {
            console.error('failed to save settings_update', err);
          }
          break;

        default:
          break;
      }
    });

    ws.on('close', async () => {
      console.log(`Device disconnected (ws): ${deviceId}`);
      deviceConnections.delete(deviceId);
      try {
        await pool.query(`UPDATE devices SET is_online = false, last_seen = now() WHERE id = $1`, [deviceId]);
        appNs.to(`vendor:${vendorId}`).emit('device_offline', { device_id: deviceId });
      } catch (err) {
        console.error('failed to mark device offline', err);
      }
    });

    ws.on('error', (err) => console.error(`device ws error (${deviceId}):`, err.message));
  });
}

module.exports = { setupDeviceWebSocket, sendToDevice, isDeviceOnline };

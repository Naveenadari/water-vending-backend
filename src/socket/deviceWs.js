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

  // Every deploy/restart wipes the in-memory deviceConnections map, but
  // NOT the database - a device that was online before the restart would
  // otherwise stay stuck showing "Online" in the app until it happens to
  // disconnect/reconnect again for real. Reset everyone to offline here so
  // the app reflects reality immediately after every deploy; devices mark
  // themselves online again within seconds as they actually reconnect.
  pool.query(`UPDATE devices SET is_online = false WHERE is_online = true`)
    .catch((err) => console.error('failed to reset device online status on boot', err));

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

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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
          // { type:'settings_update', valve, presets:[{slot_index,pulses}],
          //   settings:{ pulses_per_rupee, trip_cost,           <- per-valve
          //              topup_amount, timeout_seconds, confirm_mode } }  <- shared
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

              // Per-valve fields -> settings table, keyed by (device_id, valve)
              await pool.query(
                `UPDATE settings SET pulses_per_rupee = COALESCE($1, pulses_per_rupee),
                                      trip_cost = COALESCE($2, trip_cost)
                 WHERE device_id = $3 AND valve = $4`,
                [s.pulses_per_rupee, s.trip_cost, deviceId, valve]
              );

              // Shared fields -> device_settings table, keyed by device_id only
              // (NOT per valve - one topup amount / timeout / confirm_mode per device)
              if (s.topup_amount !== undefined || s.timeout_seconds !== undefined || s.confirm_mode !== undefined) {
                await pool.query(
                  `INSERT INTO device_settings (device_id, topup_amount, timeout_seconds, confirm_mode)
                   VALUES ($1, COALESCE($2, 100), COALESCE($3, 30), COALESCE($4, true))
                   ON CONFLICT (device_id) DO UPDATE SET
                     topup_amount = COALESCE($2, device_settings.topup_amount),
                     timeout_seconds = COALESCE($3, device_settings.timeout_seconds),
                     confirm_mode = COALESCE($4, device_settings.confirm_mode)`,
                  [deviceId, s.topup_amount, s.timeout_seconds, s.confirm_mode]
                );
              }
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
      // Only act if this closing socket is still the one on record. If the
      // device already reconnected (new ws replaced this entry in the map),
      // a late close event from the OLD dead socket must NOT wipe out the
      // new live connection - that was the bug causing "online" to flip
      // back to "offline" ~1 minute after a reconnect.
      const current = deviceConnections.get(deviceId);
      if (!current || current.ws !== ws) return;

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

  // Heartbeat: ping every connected device every 15s. If a device didn't
  // respond to the PREVIOUS ping (isAlive still false), it's a dead/zombie
  // connection - typically because the ESP32 lost power or WiFi abruptly
  // without sending a clean close frame. Terminating it here fires the
  // 'close' handler above, so the app shows "Offline" within ~15-30s
  // instead of staying "Online" indefinitely.
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000);

  wss.on('close', () => clearInterval(heartbeatInterval));
}

module.exports = { setupDeviceWebSocket, sendToDevice, isDeviceOnline };

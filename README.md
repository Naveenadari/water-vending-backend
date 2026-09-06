# Water Vending Backend

Multi-tenant backend that replaces Blynk for ESP32 water vending machines.
One deployment serves many vendors, each with one or more machines (devices).

## Stack
- Node.js + Express (REST API)
- Socket.IO (real-time link to ESP32 machines and vendor apps)
- PostgreSQL (vendors, devices, presets, settings, cards, transactions)

## 1. Local setup

```bash
cd water-vending-backend
npm install
cp .env.example .env   # fill in DATABASE_URL and ADMIN_KEY
npm run dev
```

## 2. Deploy to Render

1. Push this folder to a GitHub repo.
2. On Render: **New +** → **PostgreSQL** → create a free/starter instance. Copy its
   "Internal Database URL".
3. Open the Render Postgres **Connect → psql** (or any client) and run the
   contents of `src/schema.sql` once to create the tables.
4. On Render: **New +** → **Web Service** → connect your GitHub repo.
   - Build command: `npm install`
   - Start command: `npm start`
5. In the web service's **Environment** tab, add:
   - `DATABASE_URL` = the Postgres URL from step 2
   - `ADMIN_KEY` = any long random string (keep it secret - it protects vendor/device creation)
6. Deploy. Render gives you a URL like `https://your-app.onrender.com`.
   That's the base URL every ESP32 and the mobile app will talk to.

## 3. Provisioning a new customer (water plant vendor)

You do this once per customer who buys a machine, using your `ADMIN_KEY`.

**Create the vendor:**
```bash
curl -X POST https://your-app.onrender.com/api/vendors \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"name":"Sri Balaji Water Plant","phone":"9999999999","upi_id":"vendor@okhdfcbank","admin_pin":"1234"}'
```
Response includes `id` - this is the `vendor_id`.

**Create a device (one per machine/tap) for that vendor:**
```bash
curl -X POST https://your-app.onrender.com/api/devices \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"vendor_id":"<vendor_id from above>","name":"Tap 1"}'
```
Response includes `device_token` (a UUID) - **this replaces `BLYNK_AUTH_TOKEN`**
in the ESP32 firmware. Flash it into the device's firmware/config.

The vendor logs into the mobile app with their `phone` + `admin_pin`.

## 4. Protocol reference (for firmware + app developers)

### ESP32 → Backend (Socket.IO, namespace `/device`)
Connect: `wss://your-app.onrender.com/device?token=<device_token>`

Emits from device:
- `status` — `{ flow_lpm, valve_open, delivered_pulses, target_pulses }` (periodic, e.g. every 1s while dispensing)
- `transaction` — `{ source: 'coin'|'card', amount_rupees, pulses, status }` (on completed coin/card dispense)
- `settings_update` — `{ presets: [{slot_index, pulses}], settings: {...} }` (after calibration/local save)

Receives on device:
- `command` — `{ type: 'dispense'|'open_valve'|'stop', pulses, source, order_id }`

### Vendor App → Backend (Socket.IO, namespace `/app`)
Connect: `wss://your-app.onrender.com/app?vendor_id=<vendor_id>`

Emits from app:
- `command` — `{ device_id, type: 'open_valve'|'stop'|'save_preset'|..., ... }` (forwarded straight to the device)

Receives in app:
- `device_status`, `new_transaction`, `device_online`, `device_offline`, `payment_matched`, `settings_synced`

### REST API
- `POST /api/vendors/login` — `{ phone, pin }` → `{ id, name, phone, upi_id }`
- `GET /api/devices/vendor/:vendorId` — list machines for the logged-in vendor
- `GET /api/devices/:deviceId` — full detail (settings, presets, recent transactions)
- `POST /api/payment/request` — `{ device_token, amount }` → `{ order_id, upi_uri }` (kiosk shows this as a QR)
- `POST /api/payment/cancel` — `{ device_token, order_id }`
- `POST /webhook/notification` — called by the vendor's companion Android app
  when a GPay/PhonePe "payment received" notification appears:
  `{ phone, pin, amount, raw_text }`. Matches it to a pending payment
  request (FIFO by amount) and tells the right device to dispense.

## Notes
- UPI payments go **directly to the vendor's own UPI ID** — no payment
  gateway, no commission. The companion app on the vendor's phone detects
  the payment via notification and reports it here.
- Auth is intentionally simple (phone+PIN) for the MVP. Tighten with proper
  JWTs before wider rollout.

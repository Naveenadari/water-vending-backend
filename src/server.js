require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const { router: vendorsRouter } = require('./routes/vendors');
const devicesRouter = require('./routes/devices');
const paymentRouter = require('./routes/payment');
const webhookRouter = require('./routes/webhook');
const razorpayRouter = require('./routes/razorpay');
const { setupSockets } = require('./socket');
const { setupDeviceWebSocket } = require('./socket/deviceWs');

const app = express();
app.use(cors());
// The `verify` callback stashes the raw request body on req.rawBody, in
// addition to the normal parsed req.body. Every existing route keeps
// working exactly as before - this only ADDS req.rawBody, which the new
// Razorpay webhook route needs to verify its signature (HMAC must be
// computed over the exact raw bytes Razorpay sent, not the re-serialized
// JSON object).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'water-vending-backend' }));

app.use('/api/vendors', vendorsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/razorpay', razorpayRouter);
app.use('/webhook', webhookRouter);

const server = http.createServer(app);

// Vendor apps connect here via Socket.IO (good reconnection/rooms support)
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*' } // tighten this once you know your app's origin
});
app.set('io', io);
const appNs = setupSockets(io);

// ESP32 devices connect here via plain WebSocket - much simpler on embedded hardware
setupDeviceWebSocket(server, appNs);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

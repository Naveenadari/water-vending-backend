require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const { router: vendorsRouter } = require('./routes/vendors');
const devicesRouter = require('./routes/devices');
const paymentRouter = require('./routes/payment');
const webhookRouter = require('./routes/webhook');
const { setupSockets } = require('./socket');
const { setupDeviceWebSocket } = require('./socket/deviceWs');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', service: 'water-vending-backend' }));

app.use('/api/vendors', vendorsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/payment', paymentRouter);
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

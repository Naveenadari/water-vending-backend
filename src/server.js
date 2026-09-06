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

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', service: 'water-vending-backend' }));

app.use('/api/vendors', vendorsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/payment', paymentRouter);
app.use('/webhook', webhookRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten this once you know your app's origin
});
app.set('io', io);

setupSockets(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

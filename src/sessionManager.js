// Tracks "waiting for UPI payment" sessions per vendor.
// A session is created when a customer picks an amount at a machine and
// shows the UPI QR. It's matched (FIFO, oldest first) when the vendor's
// companion app reports a matching notification amount.
//
// In-memory is fine for MVP: sessions live for a few minutes only.
// If the server restarts mid-payment, worst case the customer re-scans.

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// vendorId -> array of { orderId, deviceId, amount, createdAt }
const pendingByVendor = new Map();

function createSession(vendorId, deviceId, amount) {
  const orderId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = { orderId, deviceId, amount, createdAt: Date.now() };
  if (!pendingByVendor.has(vendorId)) pendingByVendor.set(vendorId, []);
  pendingByVendor.get(vendorId).push(session);
  return session;
}

function cleanupExpired(vendorId) {
  const list = pendingByVendor.get(vendorId) || [];
  const now = Date.now();
  const fresh = list.filter(s => now - s.createdAt < SESSION_TTL_MS);
  pendingByVendor.set(vendorId, fresh);
  return fresh;
}

// Finds the oldest pending session for this vendor matching the amount,
// removes it, and returns it. Returns null if no match.
function matchAndConsume(vendorId, amount) {
  const list = cleanupExpired(vendorId);
  const idx = list.findIndex(s => s.amount === amount);
  if (idx === -1) return null;
  const [session] = list.splice(idx, 1);
  pendingByVendor.set(vendorId, list);
  return session;
}

function cancelSession(vendorId, orderId) {
  const list = pendingByVendor.get(vendorId) || [];
  pendingByVendor.set(vendorId, list.filter(s => s.orderId !== orderId));
}

module.exports = { createSession, matchAndConsume, cancelSession };

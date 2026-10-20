import { EventEmitter } from 'node:events';

// Domain bus: notifications and automations subscribe to task changes here.
export const bus = new EventEmitter();
bus.setMaxListeners(50);

// Live push to connected browsers (Server-Sent Events).
const clients = new Map(); // userId -> Set<res>

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => {
    clients.get(userId)?.delete(res);
    if (!clients.get(userId)?.size) clients.delete(userId);
  });
}

export function pushTo(userIds, event, data = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    for (const res of clients.get(id) || []) res.write(frame);
  }
}

setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000).unref();

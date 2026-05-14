import { db } from './connection.js';

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_SIZE = 100;

const queue = [];
let timer = null;

export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const batch = queue.splice(0);
  try {
    db.transaction(() => { for (const fn of batch) fn(); })();
  } catch (err) {
    console.error(`[batchWriter] flush error: ${err.message}`);
  }
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

export function queueWrite(fn) {
  queue.push(fn);
  if (queue.length >= MAX_BATCH_SIZE) flush();
  else scheduleFlush();
}

export function pendingCount() { return queue.length; }

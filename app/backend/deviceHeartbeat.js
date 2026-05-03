const { createClient } = require('redis');

const HEARTBEAT_TTL_SECONDS = parseInt(process.env.DEVICE_HEARTBEAT_TTL_SECONDS || '70', 10);

let pub = null;
let sub = null;
let started = false;
let onExpiredDeviceKey = null;

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

function createDeviceKey(username, deviceName) {
  return `${username}:${deviceName}`;
}

function registerExpireHandler(handler) {
  onExpiredDeviceKey = handler;
}

async function ensureStarted() {
  if (started) return;
  pub = createClient({ url: redisUrl });
  sub = pub.duplicate();
  await pub.connect();
  await sub.connect();
  started = true;

  try {
    await pub.configSet('notify-keyspace-events', 'Ex');
  } catch (e) {
    console.warn('[heartbeat] Cannot set notify-keyspace-events:', e.message);
  }

  await sub.pSubscribe('__keyevent@0__:expired', async (message) => {
    if (typeof message !== 'string' || message.indexOf(':') < 1) return;
    if (!onExpiredDeviceKey) return;
    try {
      await onExpiredDeviceKey(message);
    } catch (e) {
      console.error('[heartbeat] Expired key handler failed:', e.message);
    }
  });
}

async function touch(username, deviceName) {
  await ensureStarted();
  const key = createDeviceKey(username, deviceName);
  await pub.setEx(key, HEARTBEAT_TTL_SECONDS, '1');
  return { key, ttl: HEARTBEAT_TTL_SECONDS };
}

async function clear(username, deviceName) {
  await ensureStarted();
  await pub.del(createDeviceKey(username, deviceName));
}

module.exports = {
  registerExpireHandler,
  touch,
  clear,
  createDeviceKey,
  HEARTBEAT_TTL_SECONDS
};

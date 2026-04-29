const { createClient } = require('redis');

const HEARTBEAT_TTL_SECONDS = parseInt(process.env.DEVICE_HEARTBEAT_TTL_SECONDS || '70', 10);

function createDeviceKey(username, deviceName) {
  return `${username}:${deviceName}`;
}

function createDeviceHeartbeatManager({ onExpiredDeviceKey }) {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const pub = createClient({ url: redisUrl });
  const sub = pub.duplicate();
  let started = false;

  async function start() {
    if (started) return;
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
      try {
        await onExpiredDeviceKey(message);
      } catch (e) {
        console.error('[heartbeat] Expired key handler failed:', e.message);
      }
    });
  }

  async function touch(username, deviceName) {
    if (!started) await start();
    const key = createDeviceKey(username, deviceName);
    await pub.setEx(key, HEARTBEAT_TTL_SECONDS, '1');
    return { key, ttl: HEARTBEAT_TTL_SECONDS };
  }

  async function clear(username, deviceName) {
    if (!started) await start();
    const key = createDeviceKey(username, deviceName);
    await pub.del(key);
  }

  return {
    start,
    touch,
    clear,
    createDeviceKey,
    HEARTBEAT_TTL_SECONDS
  };
}

module.exports = {
  createDeviceHeartbeatManager,
  createDeviceKey,
  HEARTBEAT_TTL_SECONDS
};

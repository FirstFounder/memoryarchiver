import mqtt from 'mqtt';
import config from '../config.js';
import db from '../db/client.js';

// deviceId (integer) → live state object
const deviceState = {};

// throttle tracking
const lastInsertAt = {};  // deviceId → timestamp ms
const lastApower = {};    // deviceId → last inserted apower

let client = null;

export function getDeviceState(deviceId) {
  return deviceState[deviceId] ?? null;
}

export function getAllDeviceStates() {
  return { ...deviceState };
}

export function startMaevingMqtt(logger) {
  const devices = db.prepare('SELECT * FROM maeving_devices WHERE enabled = 1').all();
  if (!devices.length) {
    logger.info('Maeving MQTT: no enabled devices, skipping');
    return;
  }

  const topicToDevice = {};
  for (const device of devices) {
    deviceState[device.id] = { online: false, apower: null, current: null, voltage: null, aenergy_total: null, updatedAt: null };
    topicToDevice[`${device.mqtt_prefix}/online`] = device;
    topicToDevice[`${device.mqtt_prefix}/events/rpc`] = device;
  }

  const url = `mqtt://${config.teslaMqttHost}:${config.teslaMqttPort}`;
  client = mqtt.connect(url);

  client.on('connect', () => {
    logger.info('Maeving MQTT connected to %s', url);
    for (const topic of Object.keys(topicToDevice)) {
      client.subscribe(topic, (err) => {
        if (err) logger.error({ err }, 'Maeving MQTT subscribe error: %s', topic);
      });
    }
  });

  client.on('message', (topic, message) => {
    const device = topicToDevice[topic];
    if (!device) return;

    if (topic.endsWith('/online')) {
      deviceState[device.id].online = message.toString() === 'true';
      deviceState[device.id].updatedAt = new Date().toISOString();
      return;
    }

    if (topic.endsWith('/events/rpc')) {
      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch {
        return;
      }

      const sw = payload?.params?.['switch:0'];
      if (!sw) return;

      const { apower, current, voltage } = sw;
      const aenergy_total = sw.aenergy?.total ?? null;

      deviceState[device.id].apower = apower ?? null;
      deviceState[device.id].current = current ?? null;
      deviceState[device.id].voltage = voltage ?? null;
      deviceState[device.id].aenergy_total = aenergy_total;
      deviceState[device.id].updatedAt = new Date().toISOString();

      const now = Date.now();
      const timeSinceLast = now - (lastInsertAt[device.id] ?? 0);
      const powerDelta = Math.abs((apower ?? 0) - (lastApower[device.id] ?? 0));
      const shouldInsert = !lastInsertAt[device.id] || timeSinceLast > 30_000 || powerDelta > 5;

      if (shouldInsert) {
        try {
          db.prepare(`
            INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
            VALUES (?, ?, ?, ?, ?)
          `).run(device.id, apower ?? null, current ?? null, voltage ?? null, aenergy_total);
          lastInsertAt[device.id] = now;
          lastApower[device.id] = apower ?? 0;
        } catch (err) {
          logger.error({ err }, 'Maeving MQTT: failed to insert reading for device %d', device.id);
        }
      }
    }
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Maeving MQTT error');
  });

  client.on('offline', () => {
    logger.warn('Maeving MQTT offline');
  });
}

export function stopMaevingMqtt() {
  if (client) {
    client.end();
    client = null;
  }
}

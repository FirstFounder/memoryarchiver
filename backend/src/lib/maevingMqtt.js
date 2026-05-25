import mqtt from 'mqtt';
import config from '../config.js';
import db from '../db/client.js';
import { setPlugState } from './maevingControl.js';

export const CHARGE_COMPLETE_WATTS = 20;
export const CHARGE_COMPLETE_CONSECUTIVE = 3;

// deviceId (integer) → live state object
const deviceState = {};

// throttle tracking
const lastInsertAt = {};  // deviceId → timestamp ms
const lastApower = {};    // deviceId → last inserted apower

// active session cache for taper recording
const activeSessionCache = {};     // deviceId → session | null (absent = not yet loaded)

let client = null;

export function getDeviceState(deviceId) {
  return deviceState[deviceId] ?? null;
}

export function getAllDeviceStates() {
  return { ...deviceState };
}

export function invalidateActiveSessionCache(deviceId) {
  delete activeSessionCache[deviceId];
}

export function sessionReadingsStats(deviceId, startedAt) {
  const rows = db.prepare(`
    SELECT apower, aenergy_total
    FROM maeving_readings
    WHERE device_id = ? AND recorded_at >= datetime(?)
    ORDER BY recorded_at ASC
  `).all(deviceId, startedAt);

  if (rows.length < 2) return { wh_delivered: null, peak_watts: null, avg_watts: null };

  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = last.aenergy_total - first.aenergy_total;
  const wh_delivered = delta >= 0 ? delta : 0;

  const charging = rows.filter(r => (r.apower ?? 0) > 10);
  const peak_watts = charging.length ? Math.max(...charging.map(r => r.apower)) : null;
  const avg_watts = charging.length
    ? charging.reduce((s, r) => s + r.apower, 0) / charging.length
    : null;

  return { wh_delivered, peak_watts, avg_watts };
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

    for (const device of devices) {
      const activeSession = db.prepare(
        "SELECT id FROM maeving_sessions WHERE device_id = ? AND status IN ('active', 'scheduled')"
      ).get(device.id);
      if (!activeSession) {
        setPlugState(device.ip, false).catch(err =>
          logger.warn({ err }, 'Maeving startup: failed to turn off plug for device %d', device.id)
        );
      }
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

      // ─── Taper recording for 100% target sessions ───────────────────────────
      try {
        if (!(device.id in activeSessionCache)) {
          const sess = db.prepare(
            "SELECT * FROM maeving_sessions WHERE device_id = ? AND status = 'active' LIMIT 1",
          ).get(device.id) ?? null;
          if (sess) {
            const firstReading = db.prepare(`
              SELECT aenergy_total FROM maeving_readings
              WHERE device_id = ? AND recorded_at >= datetime(?)
              ORDER BY recorded_at ASC LIMIT 1
            `).get(device.id, sess.started_at);
            sess._firstAenergy = firstReading?.aenergy_total ?? null;
          }
          activeSessionCache[device.id] = sess;
        }

        const activeSession = activeSessionCache[device.id];

        if (activeSession && activeSession.soc_target_pct === 100) {
          if (activeSession._firstAenergy == null && aenergy_total != null) {
            activeSession._firstAenergy = aenergy_total;
          }

          if (apower != null && aenergy_total != null) {
            const effectiveCapacity = db.prepare(
              'SELECT effective_capacity_wh FROM maeving_config WHERE id = 1',
            ).get()?.effective_capacity_wh ?? 2880;
            const whSinceStart = activeSession._firstAenergy != null
              ? Math.max(0, aenergy_total - activeSession._firstAenergy)
              : 0;
            const estimatedSoc =
              (activeSession.soc_start_pct ?? 0) + (whSinceStart / effectiveCapacity) * 100;

            db.prepare(`
              INSERT INTO maeving_taper_readings (session_id, apower, aenergy_total, estimated_soc)
              VALUES (?, ?, ?, ?)
            `).run(activeSession.id, apower, aenergy_total, estimatedSoc);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Maeving MQTT: taper recording error for device %d', device.id);
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

import mqtt from 'mqtt';
import config from '../config.js';
import db from '../db/client.js';

const NUMERIC_FIELDS = new Set([
  'battery_level', 'usable_battery_level', 'charge_limit_soc',
  'charger_power', 'charger_voltage', 'charge_current_request',
  'charge_current_request_max', 'time_to_full_charge',
  'odometer', 'speed', 'heading', 'elevation', 'outside_temp',
  'inside_temp', 'rated_battery_range_km', 'ideal_battery_range_km',
  'latitude', 'longitude',
]);

// carId (integer) → state object
const carState = {};

let client = null;

function parseValue(field, raw) {
  if (raw === 'nil' || raw === 'null') return null;
  if (NUMERIC_FIELDS.has(field)) {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? null : n;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export function getCarState(carId) {
  return carState[carId] ?? null;
}

export function getAllCarState() {
  return { ...carState };
}

export function getCarStateByVin(vin) {
  if (!config.teslaMqttEnabled) return null;
  const row = db.prepare('SELECT teslamate_car_id FROM tesla_config WHERE vin = ?').get(vin);
  if (!row?.teslamate_car_id) return null;
  return getCarState(row.teslamate_car_id);
}

export function isMqttFresh(carId, maxAgeMs = 15 * 60 * 1000) {
  const state = carState[carId];
  if (!state?._updatedAt) return false;
  return (Date.now() - new Date(state._updatedAt).getTime()) < maxAgeMs;
}

export function startTeslaMqtt(logger) {
  if (!config.teslaMqttEnabled) return;

  const url = `mqtt://${config.teslaMqttHost}:${config.teslaMqttPort}`;
  client = mqtt.connect(url);

  client.on('connect', () => {
    logger.info('TeslaMate MQTT connected to %s', url);
    client.subscribe('teslamate/cars/#', (err) => {
      if (err) logger.error({ err }, 'TeslaMate MQTT subscribe error');
    });
  });

  client.on('message', (topic, message) => {
    const parts = topic.split('/');
    if (parts.length < 4) return;

    const carId = parseInt(parts[2], 10);
    const field = parts[3];
    if (!Number.isFinite(carId)) return;

    if (!carState[carId]) carState[carId] = {};
    carState[carId][field] = parseValue(field, message.toString());
    carState[carId]._updatedAt = new Date().toISOString();
  });

  client.on('error', (err) => {
    logger.error({ err }, 'TeslaMate MQTT error');
  });

  client.on('offline', () => {
    logger.warn('TeslaMate MQTT offline');
  });
}

export function stopTeslaMqtt() {
  if (client) {
    client.end();
    client = null;
  }
}

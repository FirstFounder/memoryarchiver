import config from '../../config.js';
import db from '../../db/client.js';
import {
  fleetFetch,
  getValidAccessToken,
  hasCredentials,
  saveCredentials,
} from '../../lib/teslaAuth.js';

const VEHICLE_COLUMNS = `
  id, vin, nickname, mode, departure_time, pack_capacity_kwh,
  normal_charge_amps, last_hpwc_amps, last_charge_limit_pct,
  pack_swap_date, created_at, updated_at
`;

function getVehicle(vin) {
  return db.prepare(`
    SELECT ${VEHICLE_COLUMNS}
    FROM tesla_config
    WHERE vin = ?
  `).get(vin);
}

function serializeVehicle(row) {
  return row ? { ...row, hasCredentials: hasCredentials() } : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureVehicleOnline(vin) {
  const info = await fleetFetch(`/api/1/vehicles/${vin}`);
  let state = info?.response?.state ?? 'offline';

  if (state === 'online') {
    return state;
  }

  await fleetFetch(`/api/1/vehicles/${vin}/wake_up`, { method: 'POST' });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(2_000);
    const next = await fleetFetch(`/api/1/vehicles/${vin}`);
    state = next?.response?.state ?? state;
    if (state === 'online') break;
  }

  return state;
}

function updateVehicleTelemetry(vin, { hpwcAmps, chargeLimitPct }) {
  db.prepare(`
    UPDATE tesla_config
    SET last_hpwc_amps = COALESCE(?, last_hpwc_amps),
        last_charge_limit_pct = COALESCE(?, last_charge_limit_pct),
        updated_at = ?
    WHERE vin = ?
  `).run(hpwcAmps, chargeLimitPct, Date.now(), vin);
}

export default async function teslaRoutes(fastify) {
  if (!config.teslaEnabled) return;

  fastify.get('/api/tesla/vehicles', async (_req, reply) => {
    const creds = hasCredentials();
    const rows = db.prepare(`
      SELECT ${VEHICLE_COLUMNS}
      FROM tesla_config
      ORDER BY created_at, id
    `).all();

    return reply.send(rows.map(row => ({ ...row, hasCredentials: creds })));
  });

  fastify.get('/api/tesla/vehicle/:vin/status', async (req, reply) => {
    const { vin } = req.params;
    const vehicle = getVehicle(vin);
    if (!vehicle) {
      return reply.code(404).send({ error: 'not_found', message: `Unknown VIN: ${vin}` });
    }

    if (vehicle.mode === 'connectivity' || !hasCredentials()) {
      return reply.send({ vin, mode: vehicle.mode, lastKnown: null, source: 'none' });
    }

    try {
      const payload = await fleetFetch(`/api/1/vehicles/${vin}`);
      const fleetVehicle = payload?.response ?? {};
      return reply.send({
        vin,
        mode: vehicle.mode,
        state: fleetVehicle.state ?? 'offline',
        source: 'fleet',
        lastKnown: {
          id: fleetVehicle.id_s ?? null,
          display_name: fleetVehicle.display_name ?? vehicle.nickname,
          state: fleetVehicle.state ?? 'offline',
          in_service: fleetVehicle.in_service ?? null,
        },
      });
    } catch (err) {
      return reply.send({
        vin,
        mode: vehicle.mode,
        error: 'fleet_error',
        message: err.message,
      });
    }
  });

  fastify.get('/api/tesla/vehicle/:vin/poll', async (req, reply) => {
    const { vin } = req.params;
    const vehicle = getVehicle(vin);
    if (!vehicle) {
      return reply.code(404).send({ error: 'not_found', message: `Unknown VIN: ${vin}` });
    }
    if (!hasCredentials()) {
      return reply.send({
        vin,
        mode: vehicle.mode,
        error: 'fleet_error',
        message: 'Tesla credentials not configured',
      });
    }

    try {
      const state = await ensureVehicleOnline(vin);
      const payload = await fleetFetch(`/api/1/vehicles/${vin}/vehicle_data`);
      const chargeState = payload?.response?.charge_state ?? {};
      const result = {
        vin,
        mode: vehicle.mode,
        state,
        battery_level: chargeState.battery_level ?? null,
        charge_limit_soc: chargeState.charge_limit_soc ?? null,
        charger_pilot_current: chargeState.charger_pilot_current ?? null,
        charge_amps: chargeState.charge_amps ?? null,
        scheduled_charging_start_time: chargeState.scheduled_charging_start_time ?? null,
        charging_state: chargeState.charging_state ?? null,
      };

      updateVehicleTelemetry(vin, {
        hpwcAmps: toInteger(chargeState.charger_pilot_current ?? chargeState.charge_current_request_max),
        chargeLimitPct: toInteger(chargeState.charge_limit_soc),
      });

      return reply.send(result);
    } catch (err) {
      return reply.send({
        vin,
        mode: vehicle.mode,
        error: 'fleet_error',
        message: err.message,
      });
    }
  });

  fastify.post('/api/tesla/vehicle/:vin/manual-entry', async (req, reply) => {
    const { vin } = req.params;
    const vehicle = getVehicle(vin);
    if (!vehicle) {
      return reply.code(404).send({ error: 'not_found', message: `Unknown VIN: ${vin}` });
    }

    const socPct = toInteger(req.body?.soc_pct);
    const chargeLimitPct = toInteger(req.body?.charge_limit_pct);
    const hpwcAmps = toInteger(req.body?.hpwc_amps);

    if (!socPct || !chargeLimitPct || !hpwcAmps) {
      return reply.code(400).send({ error: 'invalid_manual_entry', message: 'Manual entry requires SOC, charge limit, and HPWC amps' });
    }

    db.prepare(`
      UPDATE tesla_manual_entries
      SET status = 'superseded'
      WHERE vin = ? AND status = 'pending'
    `).run(vin);

    const inserted = db.prepare(`
      INSERT INTO tesla_manual_entries (vin, soc_pct, charge_limit_pct, hpwc_amps)
      VALUES (?, ?, ?, ?)
    `).run(vin, socPct, chargeLimitPct, hpwcAmps);

    updateVehicleTelemetry(vin, {
      hpwcAmps,
      chargeLimitPct,
    });

    return reply.send({
      ok: true,
      entry: {
        id: Number(inserted.lastInsertRowid),
        vin,
        soc_pct: socPct,
        charge_limit_pct: chargeLimitPct,
        hpwc_amps: hpwcAmps,
      },
    });
  });

  fastify.get('/api/tesla/vehicle/:vin/manual-entry', async (req, reply) => {
    const { vin } = req.params;
    const entry = db.prepare(`
      SELECT id, vin, soc_pct, charge_limit_pct, hpwc_amps, status, created_at
      FROM tesla_manual_entries
      WHERE vin = ? AND status = 'pending'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(vin);

    return reply.send(entry ?? null);
  });

  fastify.patch('/api/tesla/vehicle/:vin/config', async (req, reply) => {
    const { vin } = req.params;
    const vehicle = getVehicle(vin);
    if (!vehicle) {
      return reply.code(404).send({ error: 'not_found', message: `Unknown VIN: ${vin}` });
    }

    const updates = [];
    const values = [];
    const body = req.body ?? {};

    if (body.mode !== undefined) {
      if (!['connectivity', 'active'].includes(body.mode)) {
        return reply.code(400).send({ error: 'invalid_mode', message: 'mode must be connectivity or active' });
      }
      updates.push('mode = ?');
      values.push(body.mode);
    }
    if (body.departure_time !== undefined) {
      updates.push('departure_time = ?');
      values.push(body.departure_time);
    }
    if (body.pack_capacity_kwh !== undefined) {
      const packCapacity = toNumber(body.pack_capacity_kwh);
      if (packCapacity === null) {
        return reply.code(400).send({ error: 'invalid_pack_capacity', message: 'pack_capacity_kwh must be numeric' });
      }
      updates.push('pack_capacity_kwh = ?');
      values.push(packCapacity);
    }
    if (body.normal_charge_amps !== undefined) {
      const normalChargeAmps = toInteger(body.normal_charge_amps);
      if (normalChargeAmps === null) {
        return reply.code(400).send({ error: 'invalid_normal_charge_amps', message: 'normal_charge_amps must be numeric' });
      }
      updates.push('normal_charge_amps = ?');
      values.push(normalChargeAmps);
    }

    if (!updates.length) {
      return reply.send(serializeVehicle(vehicle));
    }

    updates.push('updated_at = ?');
    values.push(Date.now(), vin);

    db.prepare(`
      UPDATE tesla_config
      SET ${updates.join(', ')}
      WHERE vin = ?
    `).run(...values);

    return reply.send(serializeVehicle(getVehicle(vin)));
  });

  fastify.post('/api/tesla/credentials', async (req, reply) => {
    const { clientId, clientSecret, refreshToken } = req.body ?? {};
    await saveCredentials({ clientId, clientSecret, refreshToken });
    return reply.send({ ok: true });
  });

  fastify.get('/api/tesla/credentials/status', async (_req, reply) => {
    const credentialsPresent = hasCredentials();
    if (!credentialsPresent) {
      return reply.send({ hasCredentials: false, tokenValid: false });
    }

    try {
      await getValidAccessToken();
      return reply.send({ hasCredentials: true, tokenValid: true });
    } catch {
      return reply.send({ hasCredentials: true, tokenValid: false });
    }
  });
}

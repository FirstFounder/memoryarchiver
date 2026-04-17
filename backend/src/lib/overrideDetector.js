import db from '../db/client.js';
import { fetchVehicleData } from './teslaFleet.js';

function parseScheduledStart(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value)) return value;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  if (numeric >= 0 && numeric < 1440) {
    const hour = Math.floor(numeric / 60);
    const minute = numeric % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(millis));
}

function getLatestActivePlan(vin) {
  return db.prepare(`
    SELECT *
    FROM tesla_plans
    WHERE vin = ? AND status IN ('active', 'user_overridden')
    ORDER BY computed_at DESC, id DESC
    LIMIT 1
  `).get(vin);
}

function getSettings() {
  return db.prepare(`
    SELECT *
    FROM tesla_settings
    WHERE id = 1
  `).get();
}

function updatePlan(planId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`
    UPDATE tesla_plans
    SET ${keys.map(key => `${key} = ?`).join(', ')}
    WHERE id = ?
  `).run(...keys.map(key => patch[key]), planId);
}

export async function checkForOverride(vin) {
  const plan = getLatestActivePlan(vin);
  if (!plan) return { overridden: false };

  const settings = getSettings();
  const payload = await fetchVehicleData(vin, { wake: true });
  const chargeState = payload?.response?.charge_state ?? {};
  const actualStart = parseScheduledStart(chargeState.scheduled_charging_start_time);
  const actualAmps = Number(chargeState.charge_amps ?? chargeState.charge_current_request ?? 0);
  const currentSoc = Number(chargeState.battery_level ?? plan.soc_at_set_time ?? 0);

  if (
    plan.status === 'user_overridden'
    && Number.isFinite(currentSoc)
    && Number.isFinite(plan.soc_at_set_time)
    && currentSoc < (plan.soc_at_set_time - settings.soc_drop_reset_pct)
  ) {
    updatePlan(plan.id, {
      status: 'active',
      alert: null,
    });
    return { overridden: false, resetReason: 'soc_drop' };
  }

  const scheduleChanged = Boolean(plan.scheduled_start_pushed) && actualStart !== plan.scheduled_start_pushed;
  const ampsChanged = Boolean(plan.charge_amps_pushed) && actualAmps !== plan.charge_amps_pushed;

  if (scheduleChanged || ampsChanged) {
    updatePlan(plan.id, {
      status: 'user_overridden',
      alert: 'user_overridden',
    });
    return { overridden: true };
  }

  return { overridden: false };
}

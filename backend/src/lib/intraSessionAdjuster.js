import db from '../db/client.js';
import { fetchCurrentHourPrice } from './coMedPrices.js';
import { getCarStateByVin, isMqttFresh } from './teslaMqtt.js';
import { setChargingAmps } from './teslaCommands.js';

const VOLTS = 240;

function getChicagoHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    hour12: false,
  }).format(now));
}

function parseHourMinute(timeText) {
  const [hourText = '0', minuteText = '0'] = String(timeText ?? '0:0').split(':');
  return { hour: Number(hourText), minute: Number(minuteText) };
}

function hoursUntilWindowEnd(windowEndText, now = new Date()) {
  const { hour: endHour, minute: endMinute } = parseHourMinute(windowEndText);
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  let endMs = new Date(chicagoNow);
  endMs.setHours(endHour, endMinute, 0, 0);
  if (endMs <= chicagoNow) {
    endMs.setDate(endMs.getDate() + 1);
  }
  return (endMs - chicagoNow) / (1000 * 60 * 60);
}

function isWithinWindow(windowStartText, windowEndText, now = new Date()) {
  const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const currentHour = chicagoNow.getHours();
  const currentMinute = chicagoNow.getMinutes();
  const currentTotal = currentHour * 60 + currentMinute;

  const { hour: startHour, minute: startMinute } = parseHourMinute(windowStartText);
  const { hour: endHour, minute: endMinute } = parseHourMinute(windowEndText);
  const startTotal = startHour * 60 + startMinute;
  const endTotal = endHour * 60 + endMinute;

  if (startTotal <= endTotal) {
    return currentTotal >= startTotal && currentTotal < endTotal;
  }
  // Wraps midnight
  return currentTotal >= startTotal || currentTotal < endTotal;
}

function getDayAheadPriceForHour(dayAheadPricesJson, chicagoHour) {
  try {
    const prices = JSON.parse(dayAheadPricesJson ?? '[]');
    const matching = prices.filter((entry) => {
      const date = new Date(entry.millisUTC);
      const h = Number(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit',
        hour12: false,
      }).format(date));
      return h === chicagoHour;
    });
    if (!matching.length) return null;
    return matching[matching.length - 1].price;
  } catch {
    return null;
  }
}

export function computeAdjustedRate({
  remainingKwh,
  remainingHours,
  currentAmps,
  minRateAmps,
  maxRateAmps,
  currentPriceCents,
  plannedPriceCents,
  thresholdAmps,
}) {
  if (remainingKwh <= 0) {
    return { newAmps: currentAmps, reason: 'session_complete' };
  }
  if (remainingHours <= 0) {
    return { newAmps: currentAmps, reason: 'no_change' };
  }

  const idealKw = remainingKwh / remainingHours;
  const idealAmps = Math.round((idealKw * 1000) / VOLTS);
  const clampedAmps = Math.min(maxRateAmps, Math.max(minRateAmps, idealAmps));

  if (Math.abs(clampedAmps - currentAmps) < thresholdAmps) {
    return { newAmps: currentAmps, reason: 'no_change' };
  }

  let reason;
  if (clampedAmps === minRateAmps && clampedAmps !== currentAmps) {
    reason = 'at_floor';
  } else if (clampedAmps === maxRateAmps && clampedAmps !== currentAmps) {
    reason = 'at_ceiling';
  } else {
    reason = clampedAmps > currentAmps ? 'rate_increased' : 'rate_reduced';
  }

  return { newAmps: clampedAmps, reason };
}

function getSettings() {
  return db.prepare('SELECT * FROM tesla_settings WHERE id = 1').get();
}

function getActiveVehicles() {
  return db.prepare(`
    SELECT *
    FROM tesla_config
    WHERE mode = 'active'
    ORDER BY created_at, id
  `).all();
}

function getActivePlan(vin) {
  return db.prepare(`
    SELECT *
    FROM tesla_plans
    WHERE vin = ? AND status = 'active'
    ORDER BY computed_at DESC, id DESC
    LIMIT 1
  `).get(vin);
}

export async function runIntraSessionAdjuster() {
  const settings = getSettings();
  if (!settings?.intra_adjust_enabled) return;

  const vehicles = getActiveVehicles();

  for (const vehicle of vehicles) {
    try {
      const plan = getActivePlan(vehicle.vin);
      if (!plan) {
        console.info(`[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}: no active plan, skipping`);
        continue;
      }

      if (!isWithinWindow(plan.window_start, plan.window_end)) {
        console.info(`[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}: outside charge window, skipping`);
        continue;
      }

      const mqttState = getCarStateByVin(vehicle.vin);
      const mqttFresh = isMqttFresh(vehicle.teslamate_car_id);

      if (!mqttFresh || !mqttState) {
        console.info(`[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}: MQTT stale or unavailable, skipping`);
        continue;
      }
      if (mqttState.charging_state !== 'Charging') {
        console.info(`[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}: charging_state=${mqttState.charging_state}, skipping`);
        continue;
      }

      const batteryLevel = Number(mqttState.battery_level ?? 0);
      const chargeLimitSoc = Number(mqttState.charge_limit_soc ?? vehicle.last_charge_limit_pct ?? 0);
      const packCapacityKwh = Number(vehicle.pack_capacity_kwh ?? 0);
      const remainingKwh = ((chargeLimitSoc - batteryLevel) / 100) * packCapacityKwh;

      const remainingHours = hoursUntilWindowEnd(plan.window_end);
      const currentAmps = Number(mqttState.charge_current_request ?? 0);
      const maxRateAmps = Number(
        mqttState.charge_current_request_max
        ?? vehicle.last_hpwc_amps
        ?? 0,
      );
      const minRateAmps = Math.max(5, Number(plan.min_rate_amps ?? 5));

      const chicagoHour = getChicagoHour();
      let currentPriceCents = null;
      try {
        const priceEntries = await fetchCurrentHourPrice();
        currentPriceCents = priceEntries[priceEntries.length - 1]?.price ?? null;
      } catch {
        currentPriceCents = getDayAheadPriceForHour(plan.day_ahead_prices_json, chicagoHour);
      }
      if (currentPriceCents === null) {
        currentPriceCents = getDayAheadPriceForHour(plan.day_ahead_prices_json, chicagoHour) ?? 0;
      }

      const plannedPriceCents = getDayAheadPriceForHour(plan.day_ahead_prices_json, chicagoHour) ?? 0;

      const { newAmps, reason } = computeAdjustedRate({
        remainingKwh,
        remainingHours,
        currentAmps,
        minRateAmps,
        maxRateAmps,
        currentPriceCents,
        plannedPriceCents,
        thresholdAmps: settings.intra_adjust_threshold_amps,
      });

      if (reason === 'no_change' || reason === 'session_complete') {
        console.info(`[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}: ${reason} (${currentAmps}A) remaining ${remainingKwh.toFixed(1)} kWh / ${remainingHours.toFixed(1)} h`);
        continue;
      }

      await setChargingAmps(vehicle.vin, newAmps);

      const adjustmentRecord = {
        ts: new Date().toISOString(),
        hour: chicagoHour,
        prevAmps: currentAmps,
        newAmps,
        reason,
        currentPriceCents,
        plannedPriceCents,
        remainingKwh,
      };

      const existing = (() => {
        try { return JSON.parse(plan.mid_session_adjustments_json ?? '[]'); } catch { return []; }
      })();
      existing.push(adjustmentRecord);

      const now = Date.now();
      db.prepare(`
        UPDATE tesla_plans
        SET mid_session_adjustments_json = ?,
            charge_amps_pushed = ?,
            updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(existing), newAmps, now, plan.id);

      console.info(
        `[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}: rate ${currentAmps}A→${newAmps}A (${reason}) @ ${currentPriceCents.toFixed(1)}¢ remaining ${remainingKwh.toFixed(1)} kWh / ${remainingHours.toFixed(1)} h`,
      );
    } catch (error) {
      console.error(`[intraAdjuster] ${vehicle.display_name ?? vehicle.vin}:`, error);
    }
  }
}

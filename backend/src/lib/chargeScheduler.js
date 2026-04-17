import config from '../config.js';
import db from '../db/client.js';
import { fetchDayAheadPrices, filterOvernightPrices } from './coMedPrices.js';
import { addChargeSchedule, setChargingAmps } from './teslaCommands.js';
import { fetchVehicleData, isVehicleSleepError } from './teslaFleet.js';
import { fetchOvernightLow } from './weatherFetch.js';

const VOLTS = 240;

function toKw(amps) {
  return (amps * VOLTS) / 1000;
}

function kwToAmps(rateKw) {
  return Math.max(0, Math.round((rateKw * 1000) / VOLTS));
}

function parseHour(timeText) {
  const [hourText = '0', minuteText = '0'] = String(timeText ?? '0:0').split(':');
  return {
    hour: Number(hourText),
    minute: Number(minuteText),
  };
}

function formatTime(hour, minute = 0) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function averagePrice(prices) {
  if (!prices.length) return 0;
  return prices.reduce((sum, entry) => sum + entry.price, 0) / prices.length;
}

function blockCostDollars(avgPriceCents, kwhNeeded) {
  return (avgPriceCents * kwhNeeded) / 100;
}

function buildHourSequence(windowStartHour, targetHour) {
  const hours = [];
  let hour = windowStartHour;
  do {
    hours.push(hour);
    hour = (hour + 1) % 24;
  } while (hour !== targetHour);
  return hours;
}

function normalizePriceEntries(prices) {
  return prices.map((entry) => {
    const date = new Date(entry.millisUTC);
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      hour12: false,
    }).format(date));
    return {
      ...entry,
      hour,
    };
  });
}

function findContiguousBlocks(entries) {
  const blocks = [];
  let current = [];

  for (const entry of entries) {
    if (!current.length) {
      current.push(entry);
      continue;
    }

    const previous = current[current.length - 1];
    if (entry.millisUTC - previous.millisUTC === 60 * 60 * 1000) {
      current.push(entry);
      continue;
    }

    blocks.push(current);
    current = [entry];
  }

  if (current.length) {
    blocks.push(current);
  }

  return blocks;
}

function cheapestWindow(entries, windowLength) {
  if (!entries.length || windowLength <= 0 || windowLength > entries.length) return null;

  let best = null;
  for (let start = 0; start <= entries.length - windowLength; start += 1) {
    const slice = entries.slice(start, start + windowLength);
    const avgPriceCents = averagePrice(slice);
    if (!best || avgPriceCents < best.avgPriceCents) {
      best = { entries: slice, avgPriceCents };
    }
  }

  return best;
}

function serializeStrategyResult(entries, chargeAmps, avgPriceCents, estimatedCostDollars, extras = {}) {
  const startHour = entries[0]?.hour ?? 0;
  const endHour = ((entries[entries.length - 1]?.hour ?? 0) + 1) % 24;
  return {
    windowStart: formatTime(startHour),
    windowEnd: formatTime(endHour),
    chargeAmps,
    avgPriceCents,
    estimatedCostDollars,
    ...extras,
  };
}

function insertPlan(values) {
  const keys = Object.keys(values);
  const placeholders = keys.map(() => '?').join(', ');
  const result = db.prepare(`
    INSERT INTO tesla_plans (${keys.join(', ')})
    VALUES (${placeholders})
  `).run(...keys.map(key => values[key]));

  return db.prepare(`
    SELECT *
    FROM tesla_plans
    WHERE id = ?
  `).get(Number(result.lastInsertRowid));
}

function updatePlan(planId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return null;

  db.prepare(`
    UPDATE tesla_plans
    SET ${keys.map(key => `${key} = ?`).join(', ')}
    WHERE id = ?
  `).run(...keys.map(key => patch[key]), planId);

  return db.prepare(`
    SELECT *
    FROM tesla_plans
    WHERE id = ?
  `).get(planId);
}

function getSettings() {
  return db.prepare(`
    SELECT *
    FROM tesla_settings
    WHERE id = 1
  `).get();
}

function getVehicleConfig(vin) {
  return db.prepare(`
    SELECT *
    FROM tesla_config
    WHERE vin = ?
  `).get(vin);
}

function getPendingManualEntry(vin) {
  return db.prepare(`
    SELECT *
    FROM tesla_manual_entries
    WHERE vin = ? AND status = 'pending'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(vin);
}

function consumeManualEntry(entryId) {
  db.prepare(`
    UPDATE tesla_manual_entries
    SET status = 'consumed'
    WHERE id = ?
  `).run(entryId);
}

function updateVehicleCache(vin, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`
    UPDATE tesla_config
    SET ${keys.map(key => `${key} = ?`).join(', ')},
        updated_at = ?
    WHERE vin = ?
  `).run(...keys.map(key => patch[key]), Date.now(), vin);
}

export function computeTargetHour(departuretime) {
  const { hour, minute } = parseHour(departuretime);
  if (hour < 8 || (hour === 8 && minute === 0)) return hour;
  return 6;
}

export function computeKwhNeeded(chargeLimitPct, currentSocPct, packCapacityKwh) {
  const deltaPct = Number(chargeLimitPct) - Number(currentSocPct);
  if (deltaPct <= 0) return 0;
  return (deltaPct / 100) * Number(packCapacityKwh);
}

export function computeEligibleWindowStart(prices, earlyOpenHour, settings) {
  const entries = normalizePriceEntries(prices);
  const postMidnight = entries.filter(entry => entry.hour < earlyOpenHour);
  const preMidnight = entries.filter(entry => entry.hour >= earlyOpenHour);

  if (!preMidnight.length || !postMidnight.length) return 0;

  for (let length = 1; length <= preMidnight.length; length += 1) {
    const cheapestPostMidnight = cheapestWindow(postMidnight, length);
    if (!cheapestPostMidnight) continue;

    for (let start = 0; start <= preMidnight.length - length; start += 1) {
      const candidate = preMidnight.slice(start, start + length);
      const candidateAvg = averagePrice(candidate);
      if (candidateAvg <= cheapestPostMidnight.avgPriceCents + settings.variance_threshold_cents) {
        return earlyOpenHour;
      }
    }
  }

  return 0;
}

export function computeWinterMinRate(overnightLowF, settings) {
  if (overnightLowF > settings.winter_temp_high_f) return 0;
  if (overnightLowF < settings.winter_temp_low_f) return settings.winter_min_amps_cold;

  const range = settings.winter_temp_high_f - settings.winter_temp_low_f;
  if (range <= 0) return settings.winter_min_amps_cold;

  const ratio = (settings.winter_temp_high_f - overnightLowF) / range;
  const interpolated = settings.winter_min_amps_mid
    + ((settings.winter_min_amps_cold - settings.winter_min_amps_mid) * ratio);

  return Math.floor(interpolated);
}

export function computeStrategyA(prices, windowStartHour, targetHour, kwhNeeded, normalRateKw, minRateKw, varianceThresholdCents) {
  const entries = normalizePriceEntries(prices);
  if (!entries.length) {
    return serializeStrategyResult([], 0, 0, 0, { windowTooShort: true });
  }

  const minPrice = Math.min(...entries.map(entry => entry.price));
  const eligibleEntries = entries.filter(entry => entry.price <= minPrice + varianceThresholdCents);
  const blocks = findContiguousBlocks(eligibleEntries);
  const bestBlock = [...blocks].sort((a, b) => {
    const avgDiff = averagePrice(a) - averagePrice(b);
    if (avgDiff !== 0) return avgDiff;
    return b.length - a.length;
  })[0] ?? entries;

  const windowHours = bestBlock.length || buildHourSequence(windowStartHour, targetHour).length;
  const idealRateKw = windowHours ? (kwhNeeded / windowHours) : normalRateKw;
  const appliedRateKw = Math.min(normalRateKw, Math.max(minRateKw, idealRateKw));
  const windowTooShort = kwhNeeded > (windowHours * normalRateKw);
  const avgPriceCents = averagePrice(bestBlock);

  return serializeStrategyResult(
    bestBlock,
    kwToAmps(appliedRateKw),
    avgPriceCents,
    blockCostDollars(avgPriceCents, kwhNeeded),
    { windowTooShort },
  );
}

export function computeStrategyB(prices, windowStartHour, targetHour, kwhNeeded, maxRateKw) {
  const entries = normalizePriceEntries(prices);
  const requiredHours = Math.max(1, Math.ceil(kwhNeeded / Math.max(maxRateKw, 0.01)));
  const best = cheapestWindow(entries, requiredHours) ?? { entries, avgPriceCents: averagePrice(entries) };

  return serializeStrategyResult(
    best.entries,
    kwToAmps(maxRateKw),
    best.avgPriceCents,
    blockCostDollars(best.avgPriceCents, kwhNeeded),
  );
}

export function computeStrategyC(prices, windowStartHour, targetHour, kwhNeeded, normalRateKw, minRateKw) {
  const entries = normalizePriceEntries(prices);
  const baselineHours = Math.max(1, Math.ceil(kwhNeeded / Math.max(normalRateKw, 0.01)));
  const candidateLengths = [baselineHours + 1, baselineHours + 2];
  const candidates = candidateLengths
    .map(length => cheapestWindow(entries, length))
    .filter(Boolean);

  const best = candidates.sort((a, b) => a.avgPriceCents - b.avgPriceCents)[0]
    ?? cheapestWindow(entries, baselineHours)
    ?? { entries, avgPriceCents: averagePrice(entries) };

  const reducedRateKw = best.entries.length ? (kwhNeeded / best.entries.length) : normalRateKw;
  const appliedRateKw = Math.min(normalRateKw, Math.max(minRateKw, reducedRateKw));

  return serializeStrategyResult(
    best.entries,
    kwToAmps(appliedRateKw),
    best.avgPriceCents,
    blockCostDollars(best.avgPriceCents, kwhNeeded),
  );
}

export function selectStrategy(strategyA, strategyB, strategyC, settings) {
  if (strategyA.windowTooShort && ((strategyB.estimatedCostDollars - strategyC.estimatedCostDollars) < 0.25)) {
    return 'C';
  }
  if ((strategyA.estimatedCostDollars - strategyB.estimatedCostDollars) > settings.burst_pref_threshold_dollars) {
    return 'B';
  }
  return 'A';
}

function buildSkippedPlan(vin, overrides = {}) {
  return insertPlan({
    vin,
    computed_at: Date.now(),
    status: 'skipped',
    alert: overrides.alert ?? null,
    strategy_comparison_json: JSON.stringify([]),
    ...overrides,
  });
}

function isSkippedPlan(plan) {
  return plan?.status === 'skipped';
}

export async function computePlan(vin) {
  const settings = getSettings();
  const vehicle = getVehicleConfig(vin);

  if (!vehicle || !settings) {
    return { status: 'skipped', reason: 'vehicle_not_configured' };
  }

  let socPct;
  let chargeLimitPct;
  let hpwcAmps;

  const manualEntry = getPendingManualEntry(vin);
  if (manualEntry) {
    socPct = manualEntry.soc_pct;
    chargeLimitPct = manualEntry.charge_limit_pct;
    hpwcAmps = manualEntry.hpwc_amps;
    consumeManualEntry(manualEntry.id);
  } else {
    try {
      const payload = await fetchVehicleData(vin, { wake: true });
      const chargeState = payload?.response?.charge_state ?? {};
      const vehicleState = payload?.response?.vehicle_state ?? {};
      socPct = Number(chargeState.battery_level ?? 0);
      chargeLimitPct = Number(chargeState.charge_limit_soc ?? vehicle.last_charge_limit_pct ?? 0);
      hpwcAmps = Number(chargeState.charger_pilot_current ?? chargeState.charge_current_request_max ?? vehicle.last_hpwc_amps ?? 0);

      updateVehicleCache(vin, {
        last_hpwc_amps: hpwcAmps || vehicle.last_hpwc_amps,
        last_charge_limit_pct: chargeLimitPct || vehicle.last_charge_limit_pct,
        cached_odometer: Number.isFinite(Number(vehicleState.odometer)) ? Math.round(Number(vehicleState.odometer)) : vehicle.cached_odometer,
      });
    } catch (error) {
      const alert = isVehicleSleepError(error) ? 'vehicle_asleep' : null;
      const skipped = buildSkippedPlan(vin, { alert });
      return { ...skipped, reason: 'fleet_unavailable' };
    }
  }

  let dayAheadPrices;
  try {
    dayAheadPrices = await fetchDayAheadPrices();
  } catch {
    const skipped = buildSkippedPlan(vin);
    return { ...skipped, reason: 'comed_unavailable' };
  }

  const targetHour = computeTargetHour(vehicle.departure_time);
  const windowStartHour = computeEligibleWindowStart(
    filterOvernightPrices(dayAheadPrices, settings.early_window_open_hour, targetHour),
    settings.early_window_open_hour,
    settings,
  );
  const overnightPrices = filterOvernightPrices(dayAheadPrices, windowStartHour, targetHour);
  const overnightLowF = await fetchOvernightLow(config.weatherLat, config.weatherLon, windowStartHour, targetHour);
  const minRateAmps = computeWinterMinRate(overnightLowF, settings);
  const kwhNeeded = computeKwhNeeded(chargeLimitPct, socPct, vehicle.pack_capacity_kwh);
  const normalRateKw = toKw(vehicle.normal_charge_amps);
  const minRateKw = toKw(minRateAmps);
  const maxRateKw = toKw(hpwcAmps || vehicle.last_hpwc_amps || vehicle.normal_charge_amps);

  const strategyA = computeStrategyA(
    overnightPrices,
    windowStartHour,
    targetHour,
    kwhNeeded,
    normalRateKw,
    minRateKw,
    settings.variance_threshold_cents,
  );
  const strategyB = computeStrategyB(
    overnightPrices,
    windowStartHour,
    targetHour,
    kwhNeeded,
    maxRateKw,
  );
  const strategyC = computeStrategyC(
    overnightPrices,
    windowStartHour,
    targetHour,
    kwhNeeded,
    normalRateKw,
    minRateKw,
  );

  const selectedKey = selectStrategy(strategyA, strategyB, strategyC, settings);
  const selectedStrategy = { A: strategyA, B: strategyB, C: strategyC }[selectedKey];
  const fullNightAvg = averagePrice(overnightPrices);

  return insertPlan({
    vin,
    computed_at: Date.now(),
    status: 'active',
    selected_strategy: selectedKey,
    eligible_window_start: formatTime(windowStartHour),
    window_start: selectedStrategy.windowStart,
    window_end: selectedStrategy.windowEnd,
    charge_amps: selectedStrategy.chargeAmps,
    kwh_needed: kwhNeeded,
    kwh_available: overnightPrices.length * maxRateKw,
    price_window_avg_cents: selectedStrategy.avgPriceCents,
    price_full_night_avg_cents: fullNightAvg,
    cost_strategy_a_dollars: strategyA.estimatedCostDollars,
    cost_strategy_b_dollars: strategyB.estimatedCostDollars,
    overnight_low_f: overnightLowF,
    min_rate_amps: minRateAmps,
    alert: strategyA.windowTooShort ? 'window_too_short' : null,
    day_ahead_prices_json: JSON.stringify(dayAheadPrices),
    soc_at_set_time: socPct,
    charge_limit_at_set_time: chargeLimitPct,
    strategy_comparison_json: JSON.stringify([
      { key: 'A', label: 'Spread', ...strategyA },
      { key: 'B', label: 'Burst', ...strategyB },
      { key: 'C', label: 'Hybrid', ...strategyC },
    ]),
  });
}

export async function pushPlan(plan, vin) {
  if (!plan || isSkippedPlan(plan) || !plan.window_start || !plan.window_end) {
    return plan;
  }

  const start = parseHour(plan.window_start);
  const end = parseHour(plan.window_end);

  try {
    await addChargeSchedule(vin, {
      startHour: start.hour,
      startMinute: start.minute,
      endHour: end.hour,
      endMinute: end.minute,
    });
    await setChargingAmps(vin, plan.charge_amps);

    return updatePlan(plan.id, {
      scheduled_start_pushed: plan.window_start,
      charge_amps_pushed: plan.charge_amps,
      alert: plan.alert === 'fleet_command_failed' ? null : plan.alert,
    });
  } catch {
    return updatePlan(plan.id, {
      alert: 'fleet_command_failed',
    });
  }
}

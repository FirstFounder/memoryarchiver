import db from '../db/client.js';
import { getPlugStatus, setPlugState } from './maevingControl.js';
import { fetchCurrentHourPrice } from './coMedPrices.js';
import { sessionReadingsStats, invalidateActiveSessionCache, CHARGE_COMPLETE_WATTS, CHARGE_COMPLETE_CONSECUTIVE } from './maevingMqtt.js';
import { recordSessionComplete, getConfig, computeChargeCurve } from './maevingCalibration.js';

export const MAEVING_CHARGE_RATE_KW = 1.2;
const MAEVING_BATTERY_KWH = 2.88;

const completionCounters = {}; // { [sessionId]: number }

// Tracks whether the 2 AM auto-probe has already fired today for each device.
// Key: device id (integer). Value: CT date string 'YYYY-MM-DD' of last probe.
const lastProbeDateByDevice = {};

// Devices currently in the evaluate phase of the probe (plug is on, waiting to read).
// Key: device id. Value: timestamp (ms) when plug was turned on.
const probeActiveSince = {};

let pollingInterval = null;
let schedulerLogger = null;

function getComedBaseRateCents() {
  const month = new Date().getMonth() + 1; // 1-12
  return (month >= 6 && month <= 9) ? 4.27 : 2.90;
}

const COMED_FIXED_SUPPLY_CENTS = 9.66; // $0.0966/kWh, same year-round

function getComedFixedTotalCents() {
  const month = new Date().getMonth() + 1;
  return COMED_FIXED_SUPPLY_CENTS + ((month >= 6 && month <= 9) ? 4.27 : 2.90);
  // Summer (Jun-Sep): 9.66 + 4.27 = 13.93 cents/kWh ($0.1393)
  // Winter (Oct-May): 9.66 + 2.90 = 12.56 cents/kWh ($0.1256)
}

function getCurrentCtHour() {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );
}

function getCtDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
  }).format(date);
}

// Convert a CT date string + CT hour/minute to a UTC ISO string.
// Tries both CST (UTC-6) and CDT (UTC-5) and takes the one that round-trips correctly.
function ctTimeToIso(ctDateStr, hour, minute = 0) {
  for (const offset of ['-06:00', '-05:00']) {
    const iso = `${ctDateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;
    const d = new Date(iso);
    const checkHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit',
        hour12: false,
      }).format(d),
    );
    if (checkHour === hour) return d.toISOString();
  }
  // Should never happen — fall back to CST
  return new Date(
    `${ctDateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-06:00`,
  ).toISOString();
}

// Returns the ISO string for the next 02:00 CT that is still in the future.
function fallbackScheduledStartAt() {
  const now = Date.now();
  for (let day = 0; day <= 1; day++) {
    const d = new Date(now + day * 86_400_000);
    const dateStr = getCtDateStr(d);
    const candidate = new Date(ctTimeToIso(dateStr, 2, 0));
    if (candidate.getTime() > now) return candidate.toISOString();
  }
  return new Date(now + 86_400_000).toISOString();
}

// Returns the next 02:00 CT that is still in the future.
function getFixed2AmStart() {
  const now = Date.now();
  for (let day = 0; day <= 1; day++) {
    const d = new Date(now + day * 86_400_000);
    const dateStr = getCtDateStr(d);
    const candidate = new Date(ctTimeToIso(dateStr, 2, 0));
    if (candidate.getTime() > now) return candidate.toISOString();
  }
  return new Date(now + 86_400_000).toISOString();
}

// Compute fixed 2 AM overnight start and cost estimate.
// socStart and socTarget are percentages (0–100).
// Returns { scheduledStartAt, estimatedCostDollars, priceWindowAvgCents }.
export async function computeOvernightStart(socStart, socTarget, _departureTime) {
  const kwhNeeded = Math.max(0, ((socTarget - socStart) / 100) * MAEVING_BATTERY_KWH);
  const fixedRateCents = getComedFixedTotalCents();
  const estimatedCostDollars = (fixedRateCents * kwhNeeded) / 100;
  return {
    scheduledStartAt: getFixed2AmStart(),
    estimatedCostDollars,
    priceWindowAvgCents: null,   // no live price available; cost is fixed-rate estimate
  };
}

// Exported so routes can get the fallback timestamp without importing the private helper.
export function getFallbackScheduledStartAt() {
  return fallbackScheduledStartAt();
}

async function runScheduledSessions() {
  const now = new Date().toISOString();
  const sessions = db
    .prepare(
      `SELECT s.*, d.ip
       FROM maeving_sessions s
       JOIN maeving_devices d ON d.id = s.device_id
       WHERE s.status = 'scheduled' AND s.scheduled_start_at <= ?`,
    )
    .all(now);

  for (const session of sessions) {
    try {
      await setPlugState(session.ip, true);
    } catch (err) {
      schedulerLogger?.warn(
        { err, sessionId: session.id },
        'Maeving scheduler: failed to set plug ON for session %d — still marking active',
        session.id,
      );
    }
    const activatedAt = new Date().toISOString();
    db.prepare(`
      UPDATE maeving_sessions
      SET status = 'active', started_at = ?
      WHERE id = ?
    `).run(activatedAt, session.id);

    // Write baseline reading at actual plug-on time so readingsStats has an anchored first value
    try {
      const liveStatus = await getPlugStatus(session.ip);
      const baselineAenergy = liveStatus?.aenergy?.total ?? null;
      const baselineApower = liveStatus?.apower ?? 0;
      const baselineCurrent = liveStatus?.current ?? 0;
      const baselineVoltage = liveStatus?.voltage ?? 0;
      if (baselineAenergy !== null) {
        db.prepare(`
          INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
          VALUES (?, ?, ?, ?, ?)
        `).run(session.device_id, baselineApower, baselineCurrent, baselineVoltage, baselineAenergy);
        schedulerLogger?.info(
          { sessionId: session.id, baselineAenergy },
          'Maeving scheduler: baseline reading written for session %d at activation',
          session.id,
        );
      } else {
        schedulerLogger?.warn(
          { sessionId: session.id },
          'Maeving scheduler: could not write baseline reading for session %d — aenergy null',
          session.id,
        );
      }
    } catch (err) {
      schedulerLogger?.warn(
        { err, sessionId: session.id },
        'Maeving scheduler: failed to write baseline reading for session %d',
        session.id,
      );
    }

    if (session.soc_target_pct === 100) {
      schedulerLogger?.info(
        { sessionId: session.id },
        'Maeving scheduler: session %d is 100%% target — monitoring for charger auto-shutoff only, no ETA cutoff',
        session.id,
      );
    } else {
      schedulerLogger?.info(
        { sessionId: session.id },
        'Maeving scheduler: session %d activated',
        session.id,
      );
    }
  }

  // --- 2 AM auto-probe for BG and MH ---
  const probeDevices = db.prepare(
    `SELECT * FROM maeving_devices WHERE enabled = 1 AND auto_probe = 1`
  ).all();
  const ctDateNow = getCtDateStr();
  const ctHourNow = getCurrentCtHour();
  for (const device of probeDevices) {
    // Skip if already probed today
    if (lastProbeDateByDevice[device.id] === ctDateNow) continue;
    // Skip if not in the 2 AM hour
    if (ctHourNow !== 2) continue;
    // Skip if there is already an active or scheduled session for this device
    const existingSession = db.prepare(
      `SELECT id FROM maeving_sessions WHERE device_id = ? AND status IN ('active','scheduled') LIMIT 1`
    ).get(device.id);
    if (existingSession) {
      // Don't probe — user already has something going. Mark as done for today.
      lastProbeDateByDevice[device.id] = ctDateNow;
      schedulerLogger?.info(
        { deviceId: device.id, siteKey: device.site_key },
        'Maeving auto-probe: existing session found for %s — skipping probe',
        device.site_key,
      );
      continue;
    }

    if (!probeActiveSince[device.id]) {
      // Initiate: turn plug on and record the time
      try {
        await setPlugState(device.ip, true);
        probeActiveSince[device.id] = Date.now();
        schedulerLogger?.info(
          { deviceId: device.id, siteKey: device.site_key },
          'Maeving auto-probe: plug ON for %s — will evaluate on next tick',
          device.site_key,
        );
      } catch (err) {
        schedulerLogger?.warn(
          { err, deviceId: device.id, siteKey: device.site_key },
          'Maeving auto-probe: failed to turn on plug for %s',
          device.site_key,
        );
      }
      continue;
    }

    // Evaluate phase: plug has been on for at least one tick — read status
    let probeStatus = null;
    let apower = null;
    try {
      probeStatus = await getPlugStatus(device.ip);
      apower = probeStatus?.apower ?? null;
    } catch (err) {
      schedulerLogger?.warn(
        { err, deviceId: device.id, siteKey: device.site_key },
        'Maeving auto-probe: failed to read plug status for %s — aborting probe',
        device.site_key,
      );
      // Clean up and mark done so we don't retry all night
      delete probeActiveSince[device.id];
      lastProbeDateByDevice[device.id] = ctDateNow;
      continue;
    }

    const PROBE_THRESHOLD_WATTS = 20;
    const isCharging = apower !== null && apower > PROBE_THRESHOLD_WATTS;

    if (isCharging) {
      // Charger is connected and drawing power — create a session
      const lastSession = db.prepare(
        `SELECT actual_soc_pct, soc_target_pct
         FROM maeving_sessions
         WHERE device_id = ? AND status IN ('complete','charger_complete')
         ORDER BY ended_at DESC LIMIT 1`
      ).get(device.id);
      const socStart = lastSession?.actual_soc_pct ?? lastSession?.soc_target_pct ?? 0;
      const socTarget = device.default_soc_target;
      const probeNow = new Date().toISOString();

      // Write baseline reading using the same status read used for the apower check
      const baselineAenergy = probeStatus?.aenergy?.total ?? null;
      if (baselineAenergy !== null) {
        try {
          db.prepare(
            `INSERT INTO maeving_readings (device_id, apower, current, voltage, aenergy_total)
             VALUES (?, ?, ?, ?, ?)`
          ).run(
            device.id,
            probeStatus?.apower ?? 0,
            probeStatus?.current ?? 0,
            probeStatus?.voltage ?? 0,
            baselineAenergy,
          );
        } catch (err) {
          schedulerLogger?.warn({ err }, 'Maeving auto-probe: failed to write baseline reading for %s', device.site_key);
        }
      } else {
        schedulerLogger?.warn(
          { deviceId: device.id, siteKey: device.site_key },
          'Maeving auto-probe: aenergy_total null for %s — wh_delivered will be computed from MQTT readings only',
          device.site_key,
        );
      }

      const kwhNeeded = Math.max(0, ((socTarget - socStart) / 100) * MAEVING_BATTERY_KWH);
      const fixedRateCents = getComedFixedTotalCents();
      const estimatedCostDollars = device.cost_free ? 0 : (fixedRateCents * kwhNeeded) / 100;

      db.prepare(`
        INSERT INTO maeving_sessions (
          device_id, status, charge_mode,
          soc_start_pct, soc_target_pct,
          started_at, created_at,
          estimated_cost_dollars
        ) VALUES (?, 'active', 'auto', ?, ?, ?, ?, ?)
      `).run(
        device.id, socStart, socTarget,
        probeNow, probeNow,
        estimatedCostDollars,
      );
      schedulerLogger?.info(
        { deviceId: device.id, siteKey: device.site_key, socStart, socTarget, apower },
        'Maeving auto-probe: charger detected for %s (%dW) — session created %d%%→%d%%',
        device.site_key, Math.round(apower), socStart, socTarget,
      );
    } else {
      // No load detected — shut plug off
      try {
        await setPlugState(device.ip, false);
      } catch (err) {
        schedulerLogger?.warn({ err }, 'Maeving auto-probe: failed to shut off plug for %s after no-load probe', device.site_key);
      }
      schedulerLogger?.info(
        { deviceId: device.id, siteKey: device.site_key, apower },
        'Maeving auto-probe: no charger detected for %s (%s W) — plug off',
        device.site_key, apower ?? 'null',
      );
    }

    // Mark probe complete for today regardless of result
    delete probeActiveSince[device.id];
    lastProbeDateByDevice[device.id] = ctDateNow;
  }

  // --- Active session auto-cutoff ---
  const activeSessions = db.prepare(`
    SELECT s.*, d.ip, d.site_key, d.cost_free
    FROM maeving_sessions s
    JOIN maeving_devices d ON d.id = s.device_id
    WHERE s.status = 'active' AND s.soc_target_pct IS NOT NULL AND s.soc_target_pct < 100
  `).all();

  const { effective_capacity_wh } = db.prepare(
    'SELECT effective_capacity_wh FROM maeving_config WHERE id = 1'
  ).get() ?? { effective_capacity_wh: 2880 };

  for (const session of activeSessions) {
    const stats = sessionReadingsStats(session.device_id, session.started_at);
    if (!stats || stats.wh_delivered == null) continue;

    const estimatedSoc = session.soc_start_pct +
      (stats.wh_delivered / effective_capacity_wh) * 100;

    if (estimatedSoc >= session.soc_target_pct) {
      schedulerLogger?.info(
        { sessionId: session.id, estimatedSoc: estimatedSoc.toFixed(1), target: session.soc_target_pct },
        'Maeving: target SOC reached — cutting power'
      );
      try {
        await setPlugState(session.ip, false);
      } catch (err) {
        schedulerLogger?.warn({ err }, 'Maeving: failed to cut power for session %d', session.id);
      }
      // Close the session
      const cutoffNow = new Date().toISOString();
      let cutoffCostDollars = null;
      let cutoffPriceAvgCents = session.price_window_avg_cents ?? null;

      if (!cutoffPriceAvgCents) {
        try {
          const priceRows = await fetchCurrentHourPrice();
          if (priceRows.length) {
            cutoffPriceAvgCents = priceRows[priceRows.length - 1].price;
          }
        } catch (err) {
          schedulerLogger?.warn({ err }, 'Maeving: failed to fetch ComEd price at auto-cutoff');
        }
      }

      if (cutoffPriceAvgCents && stats.wh_delivered) {
        const totalRateCents = cutoffPriceAvgCents + getComedBaseRateCents();
        cutoffCostDollars = (totalRateCents * (stats.wh_delivered / 1000)) / 100;
      }

      let cutoffFixedRateDollars = null;
      let cutoffHourlySavingsDollars = null;

      if (stats.wh_delivered && !session.cost_free) {
        cutoffFixedRateDollars = (getComedFixedTotalCents() * (stats.wh_delivered / 1000)) / 100;
        if (cutoffCostDollars != null) {
          cutoffHourlySavingsDollars = cutoffFixedRateDollars - cutoffCostDollars;
        }
      }

      let cutoffLfEquivalentCost = null;
      let cutoffLfEquivalentFixed = null;

      if (session.cost_free) {
        if (stats.wh_delivered != null && cutoffPriceAvgCents != null) {
          cutoffLfEquivalentCost = ((cutoffPriceAvgCents + getComedBaseRateCents()) * (stats.wh_delivered / 1000)) / 100;
          cutoffLfEquivalentFixed = (getComedFixedTotalCents() * (stats.wh_delivered / 1000)) / 100;
        }
        cutoffCostDollars = 0;
        cutoffPriceAvgCents = null;
        cutoffFixedRateDollars = 0;
        cutoffHourlySavingsDollars = 0;
      }

      db.prepare(`
        UPDATE maeving_sessions
        SET status = 'complete', ended_at = ?,
            wh_delivered = ?, peak_watts = ?, avg_watts = ?,
            actual_cost_dollars     = COALESCE(?, actual_cost_dollars),
            price_window_avg_cents  = COALESCE(price_window_avg_cents, ?),
            fixed_rate_cost_dollars = COALESCE(?, fixed_rate_cost_dollars),
            hourly_savings_dollars  = COALESCE(?, hourly_savings_dollars),
            lf_equivalent_cost_dollars = ?,
            lf_equivalent_fixed_dollars = ?
        WHERE id = ?
      `).run(cutoffNow, stats.wh_delivered, stats.peak_watts, stats.avg_watts,
             cutoffCostDollars, cutoffPriceAvgCents,
             cutoffFixedRateDollars, cutoffHourlySavingsDollars,
             cutoffLfEquivalentCost, cutoffLfEquivalentFixed, session.id);

      const cutoffSavingsDelta = session.cost_free
        ? (cutoffLfEquivalentCost ?? 0)
        : Math.max(0, (cutoffFixedRateDollars ?? 0) - (cutoffCostDollars ?? 0));
      db.prepare(`
        UPDATE maeving_config SET running_savings_dollars = MAX(0, running_savings_dollars + ?) WHERE 1=1
      `).run(cutoffSavingsDelta);

      if (session.soc_target_pct != null) {
        db.prepare('UPDATE maeving_config SET prev_max_soc_pct = ? WHERE id = 1').run(session.soc_target_pct);
      }

      // Clear calibration gate so the deferred observation can be consumed at next ride start.
      db.prepare('UPDATE maeving_sessions SET calibration_complete = 1 WHERE id = ?').run(session.id);
      recordSessionComplete(session.id);

      try {
        computeChargeCurve(session.id, db);
      } catch (err) {
        schedulerLogger?.warn({ err }, 'computeChargeCurve failed — non-fatal');
      }

      // Consume rides that were prestaged for this session
      for (let n = 1; n <= 8; n++) {
        const rideId = session[`leg_${n}_ride_id`];
        if (rideId != null) {
          db.prepare('DELETE FROM maeving_rides WHERE id = ?').run(rideId);
        }
      }

      invalidateActiveSessionCache(session.device_id);
    }
  }

  // --- 100% session completion detection ---
  const fullTargetSessions = db.prepare(`
    SELECT s.*, d.ip, d.site_key, d.cost_free
    FROM maeving_sessions s
    JOIN maeving_devices d ON d.id = s.device_id
    WHERE s.status = 'active' AND s.soc_target_pct = 100
  `).all();

  for (const session of fullTargetSessions) {
    let plugWatts = null;
    try {
      const status = await getPlugStatus(session.ip);
      plugWatts = status?.apower ?? null;
    } catch (err) {
      schedulerLogger?.warn({ err, sessionId: session.id },
        'Maeving: could not poll plug for 100%% session %d', session.id);
      completionCounters[session.id] = 0;
      continue;
    }

    if (plugWatts !== null && plugWatts < CHARGE_COMPLETE_WATTS) {
      completionCounters[session.id] = (completionCounters[session.id] ?? 0) + 1;
      schedulerLogger?.info({ sessionId: session.id, plugWatts,
        count: completionCounters[session.id] },
        'Maeving: 100%% session %d low-power reading %d/%d',
        session.id, completionCounters[session.id], CHARGE_COMPLETE_CONSECUTIVE);
    } else {
      completionCounters[session.id] = 0;
    }

    if ((completionCounters[session.id] ?? 0) >= CHARGE_COMPLETE_CONSECUTIVE) {
      schedulerLogger?.info({ sessionId: session.id },
        'Maeving: charger auto-shutoff confirmed for session %d — closing', session.id);
      delete completionCounters[session.id];

      try { await setPlugState(session.ip, false); } catch (err) {
        schedulerLogger?.warn({ err }, 'Maeving: failed to cut plug for session %d', session.id);
      }

      const stats = sessionReadingsStats(session.device_id, session.started_at);
      const completeNow = new Date().toISOString();

      let actualCostDollars = null;
      let fixedRateCostDollars = null;
      let hourlySavingsDollars = null;
      let priceAvgCents = session.price_window_avg_cents ?? null;
      let lfEquivalentCost = null;
      let lfEquivalentFixed = null;

      if (!session.cost_free && stats?.wh_delivered) {
        if (!priceAvgCents) {
          try {
            const priceRows = await fetchCurrentHourPrice();
            if (priceRows.length) priceAvgCents = priceRows[priceRows.length - 1].price;
          } catch { /* ignore */ }
        }
        if (priceAvgCents) {
          const totalRate = priceAvgCents + getComedBaseRateCents();
          actualCostDollars = (totalRate * (stats.wh_delivered / 1000)) / 100;
          const fixedRate = getComedFixedTotalCents();
          fixedRateCostDollars = (fixedRate * (stats.wh_delivered / 1000)) / 100;
          hourlySavingsDollars = fixedRateCostDollars - actualCostDollars;
        }
      } else if (session.cost_free) {
        if (stats?.wh_delivered != null) {
          if (!priceAvgCents) {
            try {
              const priceRows = await fetchCurrentHourPrice();
              if (priceRows.length) priceAvgCents = priceRows[priceRows.length - 1].price;
            } catch { /* ignore */ }
          }
          if (priceAvgCents) {
            lfEquivalentCost = ((priceAvgCents + getComedBaseRateCents()) * (stats.wh_delivered / 1000)) / 100;
            lfEquivalentFixed = (getComedFixedTotalCents() * (stats.wh_delivered / 1000)) / 100;
          }
        }
        actualCostDollars = 0;
        fixedRateCostDollars = 0;
        hourlySavingsDollars = 0;
      }

      db.prepare(`
        UPDATE maeving_sessions
        SET status = 'charger_complete', ended_at = ?,
            wh_delivered = ?, peak_watts = ?, avg_watts = ?,
            actual_cost_dollars = ?, price_window_avg_cents = ?,
            fixed_rate_cost_dollars = ?, hourly_savings_dollars = ?,
            lf_equivalent_cost_dollars = ?,
            lf_equivalent_fixed_dollars = ?
        WHERE id = ?
      `).run(completeNow,
        stats?.wh_delivered ?? null, stats?.peak_watts ?? null, stats?.avg_watts ?? null,
        actualCostDollars, priceAvgCents,
        fixedRateCostDollars, hourlySavingsDollars,
        lfEquivalentCost, lfEquivalentFixed,
        session.id);

      const completeSavingsDelta = session.cost_free
        ? (lfEquivalentCost ?? 0)
        : Math.max(0, (fixedRateCostDollars ?? 0) - (actualCostDollars ?? 0));
      db.prepare(`
        UPDATE maeving_config SET running_savings_dollars = MAX(0, running_savings_dollars + ?) WHERE 1=1
      `).run(completeSavingsDelta);

      if (session.soc_target_pct != null) {
        db.prepare('UPDATE maeving_config SET prev_max_soc_pct = ? WHERE id = 1').run(session.soc_target_pct);
      }

      // Clear calibration gate immediately; deferred observation captured at next ride start.
      db.prepare('UPDATE maeving_sessions SET calibration_complete = 1 WHERE id = ?').run(session.id);
      recordSessionComplete(session.id);

      try {
        computeChargeCurve(session.id, db);
      } catch (err) {
        schedulerLogger?.warn({ err }, 'computeChargeCurve failed — non-fatal');
      }

      // Consume rides that were prestaged for this session
      for (let n = 1; n <= 8; n++) {
        const rideId = session[`leg_${n}_ride_id`];
        if (rideId != null) {
          db.prepare('DELETE FROM maeving_rides WHERE id = ?').run(rideId);
        }
      }

      invalidateActiveSessionCache(session.device_id);
    }
  }
}

export function startMaevingScheduler(logger) {
  schedulerLogger = logger;
  pollingInterval = setInterval(() => {
    runScheduledSessions().catch((err) => {
      logger.error({ err }, 'Maeving scheduler: poll error');
    });
  }, 60_000);
  logger.info('Maeving scheduler started (60 s poll)');
}

export function stopMaevingScheduler() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  schedulerLogger?.info('Maeving scheduler stopped');
}

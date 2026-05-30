import db from '../db/client.js';
import { getPlugStatus, setPlugState } from './maevingControl.js';
import { fetchDayAheadPrices, fetchActualPrices, filterOvernightPrices, fetchCurrentHourPrice } from './coMedPrices.js';
import { sessionReadingsStats, invalidateActiveSessionCache, CHARGE_COMPLETE_WATTS, CHARGE_COMPLETE_CONSECUTIVE } from './maevingMqtt.js';

export const MAEVING_CHARGE_RATE_KW = 1.2;
const MAEVING_BATTERY_KWH = 2.88;
const OVERNIGHT_WINDOW_START_HOUR = 21;

const completionCounters = {}; // { [sessionId]: number }

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

// Returns the ISO string for the next 03:00 CT that is still in the future.
function fallbackScheduledStartAt() {
  const now = Date.now();
  for (let day = 0; day <= 1; day++) {
    const d = new Date(now + day * 86_400_000);
    const dateStr = getCtDateStr(d);
    const candidate = new Date(ctTimeToIso(dateStr, 3, 0));
    if (candidate.getTime() > now) return candidate.toISOString();
  }
  // Safety net: 24 h from now
  return new Date(now + 86_400_000).toISOString();
}

function findCheapestWindow(prices, windowLength) {
  const n = prices.length;
  if (!n) return null;
  const len = Math.min(windowLength, n);
  let best = null;
  for (let i = 0; i <= n - len; i++) {
    const slice = prices.slice(i, i + len);
    const avg = slice.reduce((s, e) => s + e.price, 0) / len;
    if (!best || avg < best.avgPriceCents) {
      best = { entries: slice, avgPriceCents: avg };
    }
  }
  return best;
}

// Compute the optimal overnight start time and cost estimate.
// Throws { code: 'PRICES_PENDING' } if prices are not yet available or it is before 19:00 CT.
export async function computeOvernightStart(socStart, socTarget, departureTime) {
  const kwhNeeded = Math.max(0, ((socTarget - socStart) / 100) * MAEVING_BATTERY_KWH);
  const requiredHours = Math.max(1, Math.ceil(kwhNeeded / MAEVING_CHARGE_RATE_KW));
  const targetHour = departureTime ? parseInt(departureTime.split(':')[0], 10) : 7;

  let prices;
  try {
    const [todayPrices, tomorrowPrices] = await Promise.allSettled([
      fetchActualPrices(),
      fetchDayAheadPrices(),
    ]);
    const combined = [
      ...(todayPrices.status === 'fulfilled' ? todayPrices.value : []),
      ...(tomorrowPrices.status === 'fulfilled' ? tomorrowPrices.value : []),
    ];
    // Deduplicate by millisUTC
    const seen = new Set();
    prices = combined.filter(e => {
      if (seen.has(e.millisUTC)) return false;
      seen.add(e.millisUTC);
      return true;
    });
    if (!prices.length) {
      const err = new Error('Day-ahead prices unavailable');
      err.code = 'PRICES_PENDING';
      throw err;
    }
  } catch (err) {
    if (err.code === 'PRICES_PENDING') throw err;
    const e = new Error('Day-ahead prices unavailable');
    e.code = 'PRICES_PENDING';
    throw e;
  }

  const overnightPrices = filterOvernightPrices(prices, OVERNIGHT_WINDOW_START_HOUR, targetHour);

  if (!overnightPrices.length) {
    const err = new Error('No overnight price data in response');
    err.code = 'PRICES_PENDING';
    throw err;
  }

  const avgAll = overnightPrices.reduce((s, e) => s + e.price, 0) / overnightPrices.length;
  const best = findCheapestWindow(overnightPrices, requiredHours) ?? {
    entries: overnightPrices,
    avgPriceCents: avgAll,
  };

  return {
    scheduledStartAt: new Date(best.entries[0].millisUTC).toISOString(),
    estimatedCostDollars: (best.avgPriceCents * kwhNeeded) / 100,
    priceWindowAvgCents: best.avgPriceCents,
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
      const now = new Date().toISOString();
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
      `).run(now, stats.wh_delivered, stats.peak_watts, stats.avg_watts,
             cutoffCostDollars, cutoffPriceAvgCents,
             cutoffFixedRateDollars, cutoffHourlySavingsDollars,
             cutoffLfEquivalentCost, cutoffLfEquivalentFixed, session.id);

      const cutoffSavingsDelta = session.cost_free
        ? (cutoffLfEquivalentCost ?? 0)
        : Math.max(0, (cutoffFixedRateDollars ?? 0) - (cutoffCostDollars ?? 0));
      db.prepare(`
        UPDATE maeving_config SET running_savings_dollars = MAX(0, running_savings_dollars + ?) WHERE 1=1
      `).run(cutoffSavingsDelta);

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
      const now = new Date().toISOString();

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
      `).run(now,
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

      invalidateActiveSessionCache(session.device_id);
    }
  }

  // --- Overnight price optimization for sessions still on fallback ---
  const unpricedSessions = db.prepare(`
    SELECT s.*, d.ip
    FROM maeving_sessions s
    JOIN maeving_devices d ON d.id = s.device_id
    WHERE s.status = 'scheduled'
      AND s.price_window_avg_cents IS NULL
      AND s.scheduled_start_at > ?
  `).all(new Date().toISOString());
  for (const session of unpricedSessions) {
    try {
      const result = await computeOvernightStart(
        session.soc_start_pct ?? 0,
        session.soc_target_pct ?? 100,
        session.departure_time,
      );
      db.prepare(`
        UPDATE maeving_sessions
        SET scheduled_start_at     = ?,
            estimated_cost_dollars = ?,
            price_window_avg_cents = ?
        WHERE id = ? AND status = 'scheduled'
      `).run(
        result.scheduledStartAt,
        result.estimatedCostDollars,
        result.priceWindowAvgCents,
        session.id,
      );
      schedulerLogger?.info(
        { sessionId: session.id, scheduledStartAt: result.scheduledStartAt },
        'Maeving scheduler: overnight price optimized for session %d',
        session.id,
      );
    } catch (err) {
      // PRICES_PENDING or network error — keep fallback, try again next poll
      schedulerLogger?.debug(
        { sessionId: session.id, err: err.message },
        'Maeving scheduler: prices not yet available for session %d — will retry',
        session.id,
      );
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

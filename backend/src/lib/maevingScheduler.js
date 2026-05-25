import db from '../db/client.js';
import { setPlugState } from './maevingControl.js';
import { fetchDayAheadPrices, filterOvernightPrices } from './coMedPrices.js';
import { sessionReadingsStats, invalidateActiveSessionCache } from './maevingMqtt.js';

export const MAEVING_CHARGE_RATE_KW = 1.2;
const MAEVING_BATTERY_KWH = 2.88;
const OVERNIGHT_WINDOW_START_HOUR = 21;

let pollingInterval = null;
let schedulerLogger = null;

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

// Returns ms until the next occurrence of targetHour:targetMinute CT (must be in the future).
function msUntilCtTime(targetHour, targetMinute = 0) {
  const now = Date.now();
  for (let day = 0; day <= 1; day++) {
    const d = new Date(now + day * 86_400_000);
    const dateStr = getCtDateStr(d);
    const candidate = new Date(ctTimeToIso(dateStr, targetHour, targetMinute));
    if (candidate.getTime() > now) return candidate.getTime() - now;
  }
  return null;
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
  const ctHour = getCurrentCtHour();

  const kwhNeeded = Math.max(0, ((socTarget - socStart) / 100) * MAEVING_BATTERY_KWH);
  const requiredHours = Math.max(1, Math.ceil(kwhNeeded / MAEVING_CHARGE_RATE_KW));
  const targetHour = departureTime ? parseInt(departureTime.split(':')[0], 10) : 7;

  if (ctHour < 19) {
    const err = new Error('Day-ahead prices not yet published (before 19:00 CT)');
    err.code = 'PRICES_PENDING';
    throw err;
  }

  let prices;
  try {
    prices = await fetchDayAheadPrices();
  } catch {
    const err = new Error('Day-ahead prices unavailable');
    err.code = 'PRICES_PENDING';
    throw err;
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

// Schedule a one-shot retry at 19:05 CT to re-derive the optimal start time.
// If it is already past 19:05 CT, the retry is skipped (fallback remains).
export function scheduleOvernightRetry(sessionId, socStart, socTarget, departureTime) {
  const delay = msUntilCtTime(19, 5);
  if (!delay || delay <= 0) {
    schedulerLogger?.warn(
      { sessionId },
      'Maeving scheduler: 19:05 CT already passed — keeping 03:00 fallback for session %d',
      sessionId,
    );
    return;
  }

  setTimeout(async () => {
    schedulerLogger?.info(
      { sessionId },
      'Maeving scheduler: retrying overnight price computation for session %d',
      sessionId,
    );
    try {
      const result = await computeOvernightStart(socStart, socTarget, departureTime);
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
        sessionId,
      );
      schedulerLogger?.info(
        { sessionId, scheduledStartAt: result.scheduledStartAt },
        'Maeving scheduler: overnight retry succeeded for session %d',
        sessionId,
      );
    } catch (err) {
      schedulerLogger?.warn(
        { sessionId, err: err.message },
        'Maeving scheduler: overnight retry failed — keeping 03:00 CT fallback for session %d',
        sessionId,
      );
    }
  }, delay);
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
    db.prepare(`UPDATE maeving_sessions SET status = 'active' WHERE id = ?`).run(session.id);
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
    SELECT s.*, d.ip, d.site_key
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
      db.prepare(`
        UPDATE maeving_sessions
        SET status = 'complete', ended_at = ?,
            wh_delivered = ?, peak_watts = ?, avg_watts = ?
        WHERE id = ?
      `).run(now, stats.wh_delivered, stats.peak_watts, stats.avg_watts, session.id);
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

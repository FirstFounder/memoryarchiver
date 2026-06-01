import db from '../db/client.js';

export const REBEL_MPG = 61.6;

// EIA v2 endpoint — PADD 2 Midwest, Regular All Formulations, retail.
// Illinois is not tracked individually; PADD 2 is the correct regional substitute.
// EIA publishes weekly on Tuesdays ~10am ET (as of April 7, 2025).
const EIA_URL =
  'https://api.eia.gov/v2/petroleum/pri/gnd/data/' +
  '?frequency=weekly&data[]=value' +
  '&facets[duoarea][]=R20&facets[product][]=EPMR&facets[process][]=PTE' +
  '&sort[0][column]=period&sort[0][direction]=desc&length=1';

const RETRY_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours between retry attempts

function getCached() {
  return db.prepare(
    'SELECT eia_gas_price_dollars, eia_gas_price_fetched_at FROM maeving_config WHERE id = 1'
  ).get();
}

function saveToCache(price) {
  db.prepare(`
    UPDATE maeving_config
    SET eia_gas_price_dollars = ?, eia_gas_price_fetched_at = datetime('now')
    WHERE id = 1
  `).run(price);
}

async function attemptFetch() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error('EIA_API_KEY not set');
  const res = await fetch(`${EIA_URL}&api_key=${key}`);
  if (!res.ok) throw new Error(`EIA API returned ${res.status}`);
  const json = await res.json();
  const raw = json?.response?.data?.[0]?.value;
  // EIA v2 returns value as a string; coerce to number.
  const price = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!isFinite(price)) throw new Error('Unexpected EIA response shape');
  return price;
}

// Returns the cached price synchronously. Returns null if no cache exists.
// Never fetches on-demand — scheduler owns all fetches.
export function getGasPriceCached() {
  const row = getCached();
  return row?.eia_gas_price_dollars ?? null;
}

// Compute rebel cost from cached price. Returns null if no cache.
export function computeRebelCostSync(miles) {
  const price = getGasPriceCached();
  if (price == null) return null;
  return (miles / REBEL_MPG) * price;
}

// Called once at server startup.
// Seeds the cache if empty, then schedules weekly refresh every Tuesday 16:00 UTC.
export async function initEiaScheduler(log) {
  const key = process.env.EIA_API_KEY;
  if (!key) {
    log?.warn('EIA_API_KEY not set — Rebel 250 cost comparisons unavailable');
    return;
  }

  // Seed cache if empty
  const cached = getCached();
  if (!cached?.eia_gas_price_dollars) {
    try {
      const price = await attemptFetch();
      saveToCache(price);
      log?.info({ price }, 'EIA gas price cache seeded at startup');
    } catch (err) {
      log?.warn({ err }, 'EIA seed fetch failed — will retry at next scheduled Tuesday window');
    }
  }

  scheduleWeeklyFetch(log);
}

// Schedules a setTimeout to fire at the next Tuesday 16:00 UTC, then
// hands off to runFetchWithRetry which retries every 4h until success.
function scheduleWeeklyFetch(log) {
  const msUntilNext = msUntilNextTuesdayFetch();
  log?.info(
    { hours: (msUntilNext / 3_600_000).toFixed(1) },
    'EIA weekly fetch scheduled'
  );
  setTimeout(() => runFetchWithRetry(log), msUntilNext);
}

// Attempts a fetch. On success, saves to cache and schedules next Tuesday.
// On failure, retries every RETRY_DELAY_MS (handles holiday-week Wednesday
// delays and transient API errors) without queuing another Tuesday window.
async function runFetchWithRetry(log) {
  try {
    const price = await attemptFetch();
    saveToCache(price);
    log?.info({ price }, 'EIA weekly gas price updated');
    scheduleWeeklyFetch(log); // success → next Tuesday
  } catch (err) {
    log?.warn(
      { err, retryInHours: RETRY_DELAY_MS / 3_600_000 },
      'EIA fetch failed — retrying'
    );
    setTimeout(() => runFetchWithRetry(log), RETRY_DELAY_MS);
    // Does NOT call scheduleWeeklyFetch — retry loop owns it until success
  }
}

// Returns milliseconds until next Tuesday at 16:00 UTC.
// ~11am ET / 10am CT — safely after EIA's 10am ET Tuesday publication.
// Always returns at least 1 minute in the future (never fires immediately).
function msUntilNextTuesdayFetch() {
  const now = new Date();
  const target = new Date(now);

  const day = now.getUTCDay(); // 0=Sun, 1=Mon, 2=Tue, ...
  const daysUntilTuesday = (2 - day + 7) % 7 || 7; // at least 1 day ahead
  target.setUTCDate(now.getUTCDate() + daysUntilTuesday);
  target.setUTCHours(16, 0, 0, 0);

  return target.getTime() - now.getTime();
}

// Backfill rebel_cost on maeving_rides and rebel_cost_total on maeving_sessions
// where null. Uses cached price synchronously. No-ops if cache is empty.
// Called once at server startup after initEiaScheduler.
export function backfillRebelCosts(log) {
  const price = getGasPriceCached();
  if (price == null) {
    log?.warn('EIA cache empty — skipping rebel cost backfill');
    return;
  }

  // Backfill maeving_rides with null rebel_cost
  const rides = db.prepare(`
    SELECT r.id, t.distance_miles
    FROM maeving_rides r
    JOIN maeving_trips t ON t.id = r.trip_id
    WHERE r.rebel_cost IS NULL AND t.distance_miles > 0
  `).all();

  const updateRide = db.prepare('UPDATE maeving_rides SET rebel_cost = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rides) {
      updateRide.run((r.distance_miles / REBEL_MPG) * price, r.id);
    }
  })();
  if (rides.length > 0) {
    log?.info({ count: rides.length }, 'Backfilled rebel_cost on rides');
  }

  // Backfill maeving_sessions with null rebel_cost_total that have at least one leg
  const sessions = db.prepare(`
    SELECT id,
      leg_1_trip_id, leg_2_trip_id, leg_3_trip_id, leg_4_trip_id,
      leg_5_trip_id, leg_6_trip_id, leg_7_trip_id, leg_8_trip_id
    FROM maeving_sessions
    WHERE status = 'complete' AND rebel_cost_total IS NULL AND leg_1_trip_id IS NOT NULL
  `).all();

  const updateSession = db.prepare(
    'UPDATE maeving_sessions SET rebel_cost_total = ?, rebel_cost_stale = 0 WHERE id = ?'
  );
  const getTripMiles = db.prepare('SELECT distance_miles FROM maeving_trips WHERE id = ?');
  db.transaction(() => {
    for (const s of sessions) {
      const tripIds = [1,2,3,4,5,6,7,8]
        .map((n) => s[`leg_${n}_trip_id`])
        .filter(Boolean);
      let total = 0;
      for (const tid of tripIds) {
        const trip = getTripMiles.get(tid);
        if (trip?.distance_miles > 0) total += (trip.distance_miles / REBEL_MPG) * price;
      }
      if (total > 0) updateSession.run(total, s.id);
    }
  })();
  if (sessions.length > 0) {
    log?.info({ count: sessions.length }, 'Backfilled rebel_cost_total on sessions');
  }
}

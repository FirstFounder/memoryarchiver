/**
 * Nightly encode queue.
 *
 * Encoding on iolo is slow enough that a backlog submitted during the day
 * would run all day.  Jobs submitted with the "tonight" option are parked with
 * status 'scheduled' and a `scheduled_for` timestamp — the unix epoch of the
 * NIGHT_QUEUE_START_HOUR boundary (1:00 AM America/Chicago by default) of the
 * night they were assigned to.  At most NIGHT_QUEUE_PER_NIGHT jobs (5) are
 * assigned to any one night, so thirteen submitted jobs spread over three
 * nights.
 *
 * No external scheduler is involved.  The encode worker already polls every
 * few seconds; it simply treats a scheduled job as eligible once its night has
 * arrived and the clock is still inside the night window.  That makes the
 * schedule survive restarts (a job whose night passed while the box was down
 * runs on the next night) with no Task Scheduler / cron entry to maintain.
 *
 * All wall-clock arithmetic goes through Intl so DST transitions are handled:
 * nights are "the next calendar day at 1 AM local", not "24 hours later".
 */

import config from '../config.js';

const TZ           = config.nightQueueTz;
const START_HOUR   = config.nightQueueStartHour;
const WINDOW_MS    = config.nightQueueWindowHours * 3_600_000;
const PER_NIGHT    = config.nightQueuePerNight;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12:   false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Wall-clock components of an instant in the configured timezone. */
function zonedParts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    year:   Number(p.year),
    month:  Number(p.month),
    day:    Number(p.day),
    hour:   Number(p.hour) % 24,   // some ICU builds render midnight as "24"
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** UTC offset of the configured timezone at a given instant, in ms. */
function zoneOffsetMs(ms) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(whole);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * Epoch ms for a wall-clock time in the configured timezone.
 * Month is 1-indexed; day may overflow (day 32 rolls into the next month).
 * Two passes converge because the offset only depends on the approximate instant.
 */
function epochMsForWallTime(year, month, day, hour) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour);
  let guess = asIfUtc;
  for (let i = 0; i < 3; i++) guess = asIfUtc - zoneOffsetMs(guess);
  return guess;
}

const toSecs = (ms) => Math.floor(ms / 1000);

/** The START_HOUR boundary on the calendar day containing `ms`. */
function boundaryOnDayOf(ms, dayOffset = 0) {
  const p = zonedParts(ms);
  return epochMsForWallTime(p.year, p.month, p.day + dayOffset, START_HOUR);
}

/** The night boundary following `nightMs` — next calendar day, same hour. */
function nextNightMs(nightMs) {
  return boundaryOnDayOf(nightMs, 1);
}

/** True while the clock is inside a night window (start → start + windowHours). */
export function isWithinNightWindow(nowMs = Date.now()) {
  // Check today's and yesterday's boundary so a window spanning midnight works.
  for (const offset of [0, -1]) {
    const start = boundaryOnDayOf(nowMs, offset);
    if (nowMs >= start && nowMs < start + WINDOW_MS) return true;
  }
  return false;
}

/**
 * The night new work should be measured from: tonight's boundary if it hasn't
 * arrived yet or its window is still open, otherwise the next one.
 * Returned in unix seconds.
 */
export function baseNightStart(nowMs = Date.now()) {
  const todays = boundaryOnDayOf(nowMs);
  if (nowMs < todays)               return toSecs(todays);            // before 1 AM
  if (nowMs < todays + WINDOW_MS)   return toSecs(todays);            // window open
  return toSecs(nextNightMs(todays));                                 // window closed
}

/**
 * How many slots a night has already committed.  Counts every job assigned to
 * that night regardless of status — a job that already ran (or failed) spent
 * its slot, and only deleting the row gives it back.
 */
function assignedCount(db, nightSecs) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM jobs WHERE scheduled_for = ?
  `).get(nightSecs).n;
}

/**
 * The earliest night with a free slot, in unix seconds.
 * Call inside the submit transaction so concurrent submits can't share a slot.
 */
export function nextAvailableNight(db, nowMs = Date.now()) {
  let night = baseNightStart(nowMs);
  for (let i = 0; i < 366; i++) {
    if (assignedCount(db, night) < PER_NIGHT) return night;
    night = toSecs(nextNightMs(night * 1000));
  }
  return night; // a year of full nights — pathological, but return something usable
}

/**
 * Re-pack every still-waiting job into the earliest nights that have room,
 * preserving order.  This keeps the queue dense after a job is deleted or
 * pulled forward, and rolls jobs whose night expired (box was down, or the
 * night's encodes overran the window) onto the next night rather than letting
 * them pile onto it on top of that night's own five.
 *
 * Returns the rows it moved: [{ id, scheduled_for }].
 */
export function reconcileSchedule(db, nowMs = Date.now()) {
  const waiting = db.prepare(`
    SELECT id, scheduled_for FROM jobs
    WHERE status = 'scheduled'
    ORDER BY scheduled_for ASC, created_at ASC, id ASC
  `).all();
  if (waiting.length === 0) return [];

  const base = baseNightStart(nowMs);

  // Slots on the base night (and later) already spent by jobs that have left
  // the queue — running, finished or failed — still count against capacity.
  const spent = new Map();
  for (const row of db.prepare(`
    SELECT scheduled_for AS night, COUNT(*) AS n FROM jobs
    WHERE status <> 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for >= ?
    GROUP BY scheduled_for
  `).all(base)) {
    spent.set(row.night, row.n);
  }

  const update = db.prepare(`
    UPDATE jobs SET scheduled_for = ?, updated_at = unixepoch() WHERE id = ?
  `);
  const changed = [];

  db.transaction(() => {
    let night = base;
    let used  = spent.get(night) ?? 0;

    for (const job of waiting) {
      while (used >= PER_NIGHT) {
        night = toSecs(nextNightMs(night * 1000));
        used  = spent.get(night) ?? 0;
      }
      if (job.scheduled_for !== night) {
        update.run(night, job.id);
        changed.push({ id: job.id, scheduled_for: night });
      }
      used++;
    }
  })();

  return changed;
}

/** e.g. "Thu Sep 4, 1:00 AM CDT" — for logs and API responses. */
export function formatNight(nightSecs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(nightSecs * 1000));
}

/** Settings the frontend needs to render the schedule. */
export const nightQueueSettings = Object.freeze({
  tz:          TZ,
  startHour:   START_HOUR,
  windowHours: config.nightQueueWindowHours,
  perNight:    PER_NIGHT,
});

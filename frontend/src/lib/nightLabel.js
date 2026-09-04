/**
 * Format a scheduled_for timestamp (unix seconds, always a night-window start)
 * for display in the encode queue — e.g. "Sat 1:00 AM".
 *
 * @param {number} secs  unix seconds
 * @param {string} tz    IANA timezone from /api/config (nightQueue.tz)
 */
export function formatNight(secs, tz) {
  if (!secs) return '';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short',
    hour:    'numeric',
    minute:  '2-digit',
  }).format(new Date(secs * 1000));
}

/** Longer form including the date — e.g. "Sat, Sep 5, 1:00 AM". */
export function formatNightLong(secs, tz) {
  if (!secs) return '';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(secs * 1000));
}

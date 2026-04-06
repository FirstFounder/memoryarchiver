import fs from 'fs';
import path from 'path';
import config from '../config.js';

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

/**
 * Parse a local ISO-8601 datetime string (e.g. "2026-04-05T16:30:00-0400")
 * and return { year, month (0-indexed), day, monthName }.
 * Falls back to the current local date if the string is absent or unparseable.
 */
export function parseDateComponents(isoLocal) {
  if (isoLocal) {
    const m = isoLocal.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const year  = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1; // 0-indexed
      const day   = parseInt(m[3], 10);
      return { year, month, day, monthName: MONTH_NAMES[month] };
    }
  }
  const now = new Date();
  return {
    year:      now.getFullYear(),
    month:     now.getMonth(),
    day:       now.getDate(),
    monthName: MONTH_NAMES[now.getMonth()],
  };
}

/**
 * Build the output filename from its components.
 * Format: "{Month} - s{YYYY}e{D}{VV} - {ShortDesc}.mp4"
 * D has no leading zeros; VV is always 2 digits with a leading zero.
 */
export function buildFilename({ monthName, year, day, version, shortDesc }) {
  const vv = String(version).padStart(2, '0');
  return `${monthName} - s${year}e${day}${vv} - ${shortDesc}.mp4`;
}

/**
 * Scan both NAS trees and the DB queue to find the highest VV already in use
 * for the given day/year, then return the next available version number (0-based).
 *
 * Must be called inside a BEGIN EXCLUSIVE transaction to prevent races.
 *
 * @param {object} db       - better-sqlite3 instance
 * @param {number} year
 * @param {number} month    - 0-indexed
 * @param {number} day
 */
export function computeNextVersion(db, year, month, day) {
  const monthName = MONTH_NAMES[month];
  let maxVersion = -1;

  // Regex that matches s{YEAR}e{DAY}{VV} where VV is exactly 2 digits.
  // The negative lookahead (?!\d) prevents matching e.g. day=1 within s2026e12XX.
  const pattern = new RegExp(`s${year}e${day}(\\d{2})(?!\\d)`);

  // ── Scan both NAS archive trees ───────────────────────────────────────────
  for (const tree of ['Fam', 'Vault']) {
    const dir = path.join(config.nasOutputRoot, tree, monthName, String(year));
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // directory doesn't exist yet — fine
    }
    for (const filename of entries) {
      const m = filename.match(pattern);
      if (m) {
        const vv = parseInt(m[1], 10);
        if (vv > maxVersion) maxVersion = vv;
      }
    }
  }

  // ── Scan queued / in-flight jobs in the DB ────────────────────────────────
  const rows = db.prepare(`
    SELECT output_filename FROM jobs
    WHERE status IN ('pending','processing')
      AND output_filename IS NOT NULL
  `).all();

  for (const { output_filename } of rows) {
    const m = output_filename.match(pattern);
    if (m) {
      const vv = parseInt(m[1], 10);
      if (vv > maxVersion) maxVersion = vv;
    }
  }

  return maxVersion + 1; // 0 if nothing found
}

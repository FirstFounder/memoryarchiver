import db from '../db/client.js';

const CHICAGO_TIMEZONE = 'America/Chicago';

function parsePriceRow(row) {
  const millisUTC = Number(
    row?.millisUTC
    ?? row?.millisutc
    ?? row?.millis
    ?? row?.date
    ?? row?.timestamp,
  );
  const price = Number(
    row?.price
    ?? row?.value
    ?? row?.price_cents
    ?? row?.totalLMP,
  );

  if (!Number.isFinite(millisUTC) || !Number.isFinite(price)) {
    return null;
  }

  return { millisUTC, price };
}

async function fetchPrices(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`ComEd pricing request failed: ${response.status} ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('ComEd pricing response was not valid JSON');
  }

  if (!Array.isArray(payload)) {
    throw new Error('ComEd pricing response was not an array');
  }

  const parsed = payload.map(parsePriceRow).filter(Boolean).sort((a, b) => a.millisUTC - b.millisUTC);
  if (!parsed.length) {
    throw new Error('ComEd pricing response did not contain parseable rows');
  }

  return parsed;
}

function getChicagoParts(millisUTC) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(millisUTC));

  const record = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    dateKey: `${record.year}-${record.month}-${record.day}`,
    hour: Number(record.hour),
  };
}

function getDateKeyInChicago(millisUTC = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(millisUTC));
}

function collectNightWindow(prices, baseDateKey, windowStartHour, targetHour) {
  const nextDay = new Date(`${baseDateKey}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDateKey = getDateKeyInChicago(nextDay.getTime());

  const selected = prices.filter((entry) => {
    const local = getChicagoParts(entry.millisUTC);
    if (windowStartHour <= targetHour) {
      return local.dateKey === baseDateKey && local.hour >= windowStartHour && local.hour < targetHour;
    }

    return (
      (local.dateKey === baseDateKey && local.hour >= windowStartHour)
      || (local.dateKey === nextDateKey && local.hour < targetHour)
    );
  });

  return selected.sort((a, b) => a.millisUTC - b.millisUTC);
}

function getCtDateKey(millisUTC = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
  }).format(new Date(millisUTC));
}

function toComEdDateParam(ctDateStr, hour, minute) {
  return `${ctDateStr.replace(/-/g, '')}${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

export async function fetchFiveMinuteRange(ctDateStr) {
  const dateStart = toComEdDateParam(ctDateStr, 0, 0);
  const dateEnd   = toComEdDateParam(ctDateStr, 23, 55);
  const url = `https://hourlypricing.comed.com/api?type=5minutefeed&datestart=${dateStart}&dateend=${dateEnd}&format=json`;
  return fetchPrices(url);
}

export async function fetchAndCacheDayAheadPrices() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowCtKey = getCtDateKey(tomorrow.getTime());
  const prices = await fetchFiveMinuteRange(tomorrowCtKey);
  if (!prices.length) {
    throw new Error('fetchAndCacheDayAheadPrices: empty result for ' + tomorrowCtKey);
  }
  db.prepare(`
    INSERT OR REPLACE INTO maeving_price_cache (price_date, prices_json, fetched_at, source)
    VALUES (?, ?, datetime('now'), '5minutefeed')
  `).run(tomorrowCtKey, JSON.stringify(prices));
  return prices;
}

export function getCachedPricesForDate(ctDateStr) {
  const row = db.prepare(
    'SELECT prices_json FROM maeving_price_cache WHERE price_date = ?'
  ).get(ctDateStr);
  if (!row) return null;
  try {
    return JSON.parse(row.prices_json);
  } catch {
    return null;
  }
}

export async function fetchCurrentHourPrice() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=currenthouraverage&format=json');
}

export async function fetchFiveMinuteFeed() {
  const entries = await fetchPrices('https://hourlypricing.comed.com/api?type=5minutefeed&format=json');
  return entries.sort((a, b) => a.millisUTC - b.millisUTC);
}

export function filterOvernightPrices(prices, windowStartHour, targetHour) {
  const sorted = [...prices].sort((a, b) => a.millisUTC - b.millisUTC);
  const todayKey = getDateKeyInChicago();
  const tomorrowDate = new Date(Date.now());
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrowKey = getDateKeyInChicago(tomorrowDate.getTime());

  const tonight = collectNightWindow(sorted, todayKey, windowStartHour, targetHour);
  if (tonight.length) return tonight;

  return collectNightWindow(sorted, tomorrowKey, windowStartHour, targetHour);
}
// Retained for Tesla charge scheduler compatibility — these use undocumented
// ComEd endpoints. Maeving scheduler uses fetchAndCacheDayAheadPrices() instead.
export async function fetchDayAheadPrices() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=daynexthouraverage&format=json');
}

export async function fetchActualPrices() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=dayaheadhouraverage&format=json');
}

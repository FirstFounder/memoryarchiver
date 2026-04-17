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

export async function fetchDayAheadPrices() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=daynexthouraverage&format=json');
}

export async function fetchActualPrices() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=dayaheadhouraverage&format=json');
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

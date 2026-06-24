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
// ---------------------------------------------------------------------------
// ComEd "Residential - Hourly Multiple" (Rate BESH) — static per-kWh charges
// Source: actual ComEd bills, account 4689242222
//   July 2024 bill  — establishes plan structure (flat DFC, no TOD split)
//   June 2026 bill  — current values for all static riders
//
// These rates are the same year-round (no seasonal variation on this plan).
// Update individual constants when ComEd files a tariff revision.
//
// NOT included here (tracked separately):
//   CFRA  — Carbon-Free Energy Resource Adj  → maeving_monthly_rates.cfra_cents
//   PEA   — Purchased Electricity Adjustment → maeving_monthly_rates.pea_cents
//
// NOT included (flat monthly, not per-kWh):
//   Customer Charge, Standard Metering Charge, Capacity Charge (per-kW demand),
//   Franchise Cost, State Tax, Municipal Tax
// ---------------------------------------------------------------------------

// Distribution Facility Charge — single flat rate, no TOD or seasonal split
// Source: July 2024 bill, $1.95 / 51 kWh = 3.817¢; ICC tariff; infrequent changes
const COMED_DFC_CENTS = 3.817;
// Transmission Services Charge — changes annually in June; next change Jan 2027
// Source: Plugin Illinois, effective June 2026 = 1.722¢/kWh
const COMED_TSC_CENTS = 1.722;
// Misc Procurement Components Charge
// Source: June 2026 bill, $0.03 / 26 kWh = 0.134¢
const COMED_MISC_PROCUREMENT_CENTS = 0.134;
// IL Electricity Distribution Charge (state IEDT)
// Source: June 2026 bill, 0.128¢/kWh
const COMED_IEDT_CENTS = 0.128;
// Renewable Portfolio Standard
// Source: June 2026 bill, 0.516¢/kWh
const COMED_RPS_CENTS = 0.516;
// Zero Emission Standard
// Source: June 2026 bill, 0.087¢/kWh
const COMED_ZES_CENTS = 0.087;
// Energy Efficiency Programs
// Source: June 2026 bill, 0.369¢/kWh
const COMED_EE_CENTS = 0.369;
// Energy Transition Assistance
// Source: June 2026 bill, 0.084¢/kWh
const COMED_ETA_CENTS = 0.084;

// Sum of all static per-kWh charges (excludes CFRA, PEA, commodity supply)
// = 3.817 + 1.722 + 0.134 + 0.128 + 0.516 + 0.087 + 0.369 + 0.084 = 6.857¢/kWh
const COMED_STATIC_BASE_CENTS =
  COMED_DFC_CENTS +
  COMED_TSC_CENTS +
  COMED_MISC_PROCUREMENT_CENTS +
  COMED_IEDT_CENTS +
  COMED_RPS_CENTS +
  COMED_ZES_CENTS +
  COMED_EE_CENTS +
  COMED_ETA_CENTS;
// COMED_STATIC_BASE_CENTS = 6.857

// Returns the static per-kWh base for cost calculations.
// No seasonal or time-of-day variation on the Residential - Hourly Multiple plan.
// Add getMonthlyAdjustmentCents(db) and the live hourly commodity price for total.
function getComedBaseRateCents() {
  return COMED_STATIC_BASE_CENTS;
}

// ComEd fixed-price supply rate (Rate BES — "Price to Compare" minus TSC)
// Price to Compare effective June 2026: 10.399¢/kWh (supply + TSC)
// Fixed supply alone: 10.399 - 1.722 = 8.677¢/kWh
// Source: Plugin Illinois, pluginillinois.org, effective June 1, 2026
// Note: TSC is already included in COMED_STATIC_BASE_CENTS, so the fixed supply
// constant represents only the supply component (equivalent to the hourly commodity).
const COMED_FIXED_SUPPLY_CENTS = 8.677;

// Total fixed-rate cost per kWh (fixed supply + all static base charges)
// = 8.677 + 6.857 = 15.534¢/kWh  (before CFRA/PEA monthly adjustment)
// Add getMonthlyAdjustmentCents(db) for the true current fixed-rate total.
function getComedFixedTotalCents() {
  return COMED_FIXED_SUPPLY_CENTS + COMED_STATIC_BASE_CENTS;
}

export function getMonthlyAdjustmentCents(db) {
  const now = new Date();
  const rateMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const row = db.prepare(
    'SELECT cfra_cents, pea_cents FROM maeving_monthly_rates WHERE rate_month = ?'
  ).get(rateMonth);
  if (!row) return 0;
  return (row.cfra_cents ?? 0) + (row.pea_cents ?? 0);
}

export async function fetchDayAheadPrices() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=daynexthouraverage&format=json');
}

export async function fetchActualPrices() {
  return fetchPrices('https://hourlypricing.comed.com/api?type=dayaheadhouraverage&format=json');
}

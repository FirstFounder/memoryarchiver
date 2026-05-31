import db from '../db/client.js';

const REBEL_MPG = 61.6;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RETRY_DELAY_MS = 6 * 60 * 60 * 1000;     // 6 hours
const MAX_ATTEMPTS = 3;

// EIA v2 data endpoint — Midwest (PADD 2) Regular All Formulations Retail Gasoline.
// Illinois is not tracked as a standalone geography in this dataset; PADD 2 is the
// appropriate Midwest regional average. Product EPMR, process PTE (retail sales).
const EIA_URL =
  'https://api.eia.gov/v2/petroleum/pri/gnd/data/' +
  '?frequency=weekly&data[]=value' +
  '&facets[duoarea][]=R20&facets[product][]=EPMR&facets[process][]=PTE' +
  '&sort[0][column]=period&sort[0][direction]=desc&length=1';

function getCached() {
  return db.prepare('SELECT eia_gas_price_dollars, eia_gas_price_fetched_at FROM maeving_config WHERE id = 1').get();
}

function isFresh(row) {
  if (!row?.eia_gas_price_dollars || !row?.eia_gas_price_fetched_at) return false;
  const age = Date.now() - new Date(row.eia_gas_price_fetched_at).getTime();
  return age < CACHE_TTL_MS;
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

function scheduleRetries(attemptsLeft) {
  if (attemptsLeft <= 0) return;
  setTimeout(async () => {
    try {
      const price = await attemptFetch();
      saveToCache(price);
    } catch {
      scheduleRetries(attemptsLeft - 1);
    }
  }, RETRY_DELAY_MS);
}

export async function fetchGasPrice() {
  const key = process.env.EIA_API_KEY;
  if (!key) return { price: null, stale: false };

  const cached = getCached();
  if (isFresh(cached)) {
    return { price: cached.eia_gas_price_dollars, stale: false };
  }

  try {
    const price = await attemptFetch();
    saveToCache(price);
    return { price, stale: false };
  } catch {
    scheduleRetries(MAX_ATTEMPTS - 1);
    if (cached?.eia_gas_price_dollars != null) {
      return { price: cached.eia_gas_price_dollars, stale: true };
    }
    return { price: null, stale: false };
  }
}

export async function computeRebelCost(miles) {
  const { price, stale } = await fetchGasPrice();
  if (price == null) return { cost: null, stale };
  return { cost: (miles / REBEL_MPG) * price, stale };
}

export async function initEiaCache(log) {
  const key = process.env.EIA_API_KEY;
  if (!key) {
    log?.warn('EIA_API_KEY not set — Rebel 250 cost comparisons will be unavailable');
    return;
  }
  const cached = getCached();
  if (isFresh(cached)) return;
  try {
    const price = await attemptFetch();
    saveToCache(price);
    log?.info({ price }, 'EIA gas price cache populated at startup');
  } catch (err) {
    log?.warn({ err }, 'EIA gas price fetch failed at startup — will retry in background');
    scheduleRetries(MAX_ATTEMPTS - 1);
  }
}

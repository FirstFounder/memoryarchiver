export function getCurrentMonthRates(db) {
  const now = new Date();
  const rateMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return db.prepare(`
    SELECT rate_month, cfra_cents, cfra_partial, cfra_status, pea_cents, pea_status,
           cfra_fetched_at, pea_fetched_at
    FROM maeving_monthly_rates
    WHERE rate_month = ?
  `).get(rateMonth) ?? null;
}

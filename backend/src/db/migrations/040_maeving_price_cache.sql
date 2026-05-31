-- Cache for ComEd 5-minute day-ahead price data fetched via the documented
-- 5minutefeed date-range API. One row per calendar date (CT). Enables both
-- overnight window optimization and future actual-vs-forecast comparison.
CREATE TABLE IF NOT EXISTS maeving_price_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  price_date  TEXT NOT NULL UNIQUE,       -- CT date, format 'YYYY-MM-DD'
  prices_json TEXT NOT NULL,              -- JSON array of {millisUTC, price}
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT NOT NULL DEFAULT '5minutefeed'
);

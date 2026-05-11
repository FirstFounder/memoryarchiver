CREATE TABLE IF NOT EXISTS receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_filename  TEXT NOT NULL UNIQUE,
  pdf_path      TEXT NOT NULL,
  store_number  INTEGER,
  store_address TEXT,
  receipt_date  TEXT,
  subtotal      REAL,
  tax_amount    REAL,
  total         REAL,
  item_count    INTEGER NOT NULL DEFAULT 0,
  parse_status  TEXT NOT NULL DEFAULT 'ok',
  parse_notes   TEXT,
  raw_pages     INTEGER NOT NULL DEFAULT 1,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receipt_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id      INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  page_number     INTEGER NOT NULL,
  description     TEXT NOT NULL,
  price           REAL NOT NULL,
  price_code      TEXT,
  is_weight_item  INTEGER NOT NULL DEFAULT 0,
  weight          REAL,
  rate_per_lb     REAL,
  quantity        INTEGER,
  unit_price      REAL,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(receipt_date);
CREATE INDEX IF NOT EXISTS idx_receipts_store ON receipts(store_number);
CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_items_desc ON receipt_items(description);

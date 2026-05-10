CREATE TABLE IF NOT EXISTS receipt_vendors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS receipts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id       INTEGER NOT NULL REFERENCES receipt_vendors(id),
  receipt_date    TEXT NOT NULL,
  purchase_amount REAL NOT NULL,
  item_count      INTEGER NOT NULL,
  subtotal        REAL,
  tax_amount      REAL,
  store_number    INTEGER,
  source_file     TEXT,
  imported_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at      TEXT,
  UNIQUE(vendor_id, receipt_date, purchase_amount, item_count)
);

CREATE TABLE IF NOT EXISTS receipt_item_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id     INTEGER NOT NULL REFERENCES receipt_vendors(id),
  description   TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(vendor_id, description)
);

CREATE TABLE IF NOT EXISTS receipt_line_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id     INTEGER NOT NULL REFERENCES receipts(id),
  item_type_id   INTEGER REFERENCES receipt_item_types(id),
  description    TEXT NOT NULL,
  price          REAL NOT NULL,
  price_code     TEXT,
  is_weight_item BOOLEAN NOT NULL DEFAULT 0,
  quantity       INTEGER,
  unit_price     REAL,
  line_order     INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO receipt_vendors (key, name) VALUES ('wfm', 'Woodman''s Food Market');

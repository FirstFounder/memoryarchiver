import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the directory for the DB file exists
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )
`);

// Apply migrations in order, once each.
const migrationsDir = path.join(__dirname, 'migrations');
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
for (const file of files) {
  const alreadyApplied = db.prepare(`
    SELECT 1
    FROM schema_migrations
    WHERE filename = ?
  `).get(file);

  if (alreadyApplied) continue;

  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  db.exec(sql);
  db.prepare(`
    INSERT INTO schema_migrations (filename, applied_at)
    VALUES (?, ?)
  `).run(file, Date.now());
}

export default db;

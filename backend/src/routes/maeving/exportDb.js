import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import db from '../../db/client.js';
import config from '../../config.js';

const keepTables = new Set([
  'schema_migrations',
  'maeving_devices',
  'maeving_sessions',
  'maeving_readings',
  'maeving_config',
  'maeving_trips',
  'maeving_rides',
  'maeving_price_cache',
  'owntracks_locations',
]);

export default async function maevingExportDbRoutes(fastify) {
  fastify.get('/api/maeving/export-db', async (req, reply) => {
    const tmpPath = path.join(path.dirname(config.dbPath), `maeving-export-${Date.now()}.db`);

    try {
      await db.backup(tmpPath);

      const tmpDb = new Database(tmpPath);

      const allTables = tmpDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);

      for (const tableName of allTables) {
        if (!keepTables.has(tableName)) {
          tmpDb.prepare(`DROP TABLE IF EXISTS "${tableName}"`).run();
        }
      }

      tmpDb
        .prepare(
          "DELETE FROM schema_migrations WHERE filename NOT LIKE '%maeving%' AND filename NOT LIKE '%owntracks%'",
        )
        .run();

      tmpDb.prepare('VACUUM').run();
      tmpDb.close();

      const stat = fs.statSync(tmpPath);
      const date = new Date().toISOString().slice(0, 10);

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="maeving-export-${date}.db"`);
      reply.header('Content-Length', stat.size);

      const stream = fs.createReadStream(tmpPath);
      stream.on('close', () => {
        fs.unlink(tmpPath, () => {});
      });

      return reply.send(stream);
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      req.log.error(err, 'Maeving DB export failed');
      return reply.code(500).send({ error: 'Export failed', detail: err.message });
    }
  });
}

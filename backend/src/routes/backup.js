import fs from 'fs';
import path from 'path';
import db from '../db/client.js';

export default async function backupRoutes(fastify) {
  fastify.get('/api/backup/db', async (req, reply) => {
    const timestamp = Date.now();
    const tmpPath = `/tmp/memoryarchiver-backup-${timestamp}.db`;

    try {
      await db.backup(tmpPath);

      const stat = fs.statSync(tmpPath);
      const date = new Date().toISOString().slice(0, 10);

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="memoryarchiver-${date}.db"`);
      reply.header('Content-Length', stat.size);

      const stream = fs.createReadStream(tmpPath);
      stream.on('close', () => {
        fs.unlink(tmpPath, () => {});
      });

      return reply.send(stream);
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      req.log.error(err, 'DB backup failed');
      return reply.code(500).send({ error: 'Backup failed' });
    }
  });
}

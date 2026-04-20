import db from '../../db/client.js';
import config from '../../config.js';

export default async function camerasRoutes(fastify) {

  // GET /api/hub/cameras
  fastify.get('/api/hub/cameras', async (_req, reply) => {
    if (!config.cameraPaths.length) return reply.send([]);

    // Ensure every configured path has a label row (seed on first encounter)
    const insert = db.prepare(`
      INSERT OR IGNORE INTO camera_labels (path, display)
      VALUES (?, ?)
    `);
    for (const pathName of config.cameraPaths) {
      const slug = pathName.split('/').pop();
      insert.run(pathName, slug);
    }

    // Build label map from DB
    const rows = db.prepare('SELECT path, display FROM camera_labels').all();
    const labelMap = new Map(rows.map(r => [r.path, r.display]));

    try {
      const auth = Buffer.from(`${config.mediamtxApiUser}:${config.mediamtxApiPass}`).toString('base64');
      const resp = await fetch(
        `http://localhost:${config.mediamtxApiPort}/v3/paths/list`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      if (!resp.ok) throw new Error(`mediamtx API returned ${resp.status}`);
      const data = await resp.json();

      const activePaths = new Map(
        (data.items ?? []).map(item => [item.name, item])
      );

      const cameras = config.cameraPaths.map(pathName => {
        const item = activePaths.get(pathName);
        const live = !!(item?.ready);
        return {
          name: pathName,
          label: labelMap.get(pathName) ?? pathName.split('/').pop(),
          live,
          hlsUrl: live ? `/hls-proxy/${pathName}/index.m3u8` : null,
          readersCount: item?.readersNum ?? 0,
        };
      });

      return reply.send(cameras);
    } catch {
      // Return all cameras as offline rather than a 500 — mediamtx may not be running
      return reply.send(
        config.cameraPaths.map(pathName => ({
          name: pathName,
          label: labelMap.get(pathName) ?? pathName.split('/').pop(),
          live: false,
          hlsUrl: null,
          readersCount: 0,
        }))
      );
    }
  });

  // PATCH /api/hub/cameras/:name/label
  // :name is the URL-encoded mediamtx path (e.g. "live%2Fcoopdoor")
  fastify.patch('/api/hub/cameras/:name/label', {
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 64 },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const pathName = decodeURIComponent(req.params.name);

    if (!config.cameraPaths.includes(pathName)) {
      return reply.code(404).send({ error: 'Camera not found' });
    }

    db.prepare(`
      INSERT INTO camera_labels (path, display, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT (path) DO UPDATE SET display = excluded.display, updated_at = excluded.updated_at
    `).run(pathName, req.body.label.trim());

    return reply.send({ name: pathName, label: req.body.label.trim() });
  });
}

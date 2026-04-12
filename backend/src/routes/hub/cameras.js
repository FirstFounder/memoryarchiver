import config from '../../config.js';

export default async function camerasRoutes(fastify) {
  fastify.get('/api/hub/cameras', async (_req, reply) => {
    if (!config.cameraPaths.length) return reply.send([]);

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
        const label = pathName.split('/').pop();
        return {
          name: pathName,
          label,
          live,
          hlsUrl: live ? `${config.cameraHlsBase}/${pathName}/index.m3u8` : null,
          readersCount: item?.readersNum ?? 0,
        };
      });

      return reply.send(cameras);
    } catch {
      // Return all cameras as offline rather than a 500 — mediamtx may not be running
      return reply.send(
        config.cameraPaths.map(pathName => ({
          name: pathName,
          label: pathName.split('/').pop(),
          live: false,
          hlsUrl: null,
          readersCount: 0,
        }))
      );
    }
  });
}

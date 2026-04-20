import config from '../../config.js';

export default async function cameraProxyRoutes(fastify) {

  // GET /api/hub/cameras — proxy to hub
  fastify.get('/api/hub/cameras', async (_req, reply) => {
    try {
      const res = await fetch(`${config.hubUrl}/api/hub/cameras`);
      if (!res.ok) return reply.code(res.status).send();
      return reply.send(await res.json());
    } catch {
      return reply.code(502).send({ error: 'Hub unreachable' });
    }
  });

  // PATCH /api/hub/cameras/:name/label — proxy to hub
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
    try {
      const res = await fetch(
        `${config.hubUrl}/api/hub/cameras/${req.params.name}/label`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        }
      );
      if (!res.ok) return reply.code(res.status).send();
      return reply.send(await res.json());
    } catch {
      return reply.code(502).send({ error: 'Hub unreachable' });
    }
  });
}

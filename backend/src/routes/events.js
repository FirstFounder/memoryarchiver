import emitter from '../lib/emitter.js';

/**
 * GET /api/events
 *
 * Server-Sent Events stream with named event types:
 *
 *   event: connected          — sent once on open
 *   event: job                — encoding job update  { id, status, progress, output_filename?, ... }
 *   event: sync               — sync job update      { id, status, progress, label, type, ... }
 *
 * Named events let the client attach separate addEventListener('job', ...) and
 * addEventListener('sync', ...) handlers instead of a single onmessage handler.
 *
 * A heartbeat comment (": ping") is sent every 20 s to keep proxies alive.
 */
export default async function eventsRoute(fastify) {
  fastify.get('/api/events', async (req, reply) => {
    const res = reply.raw;

    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    res.write('event: connected\ndata: {}\n\n');

    const onJobUpdate = (payload) => {
      res.write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onSyncUpdate = (payload) => {
      res.write(`event: sync\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onHubSyncUpdate = (payload) => {
      res.write(`event: hub-sync\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    emitter.on('job:update',      onJobUpdate);
    emitter.on('sync:update',     onSyncUpdate);
    emitter.on('hub-sync:update', onHubSyncUpdate);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      emitter.off('job:update',      onJobUpdate);
      emitter.off('sync:update',     onSyncUpdate);
      emitter.off('hub-sync:update', onHubSyncUpdate);
    };

    req.raw.on('close',   cleanup);
    req.raw.on('error',   cleanup);
    req.raw.on('aborted', cleanup);

    await new Promise(() => {});
  });
}

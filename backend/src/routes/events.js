import emitter from '../lib/emitter.js';

/**
 * GET /api/events
 *
 * Server-Sent Events stream.  The client subscribes once on app load and
 * receives real-time job updates without polling.
 *
 * Event format:
 *   data: { id, status, progress, outputFilename?, errorMsg? }\n\n
 *
 * A heartbeat comment (": ping") is sent every 20 s to keep proxies alive.
 */
export default async function eventsRoute(fastify) {
  fastify.get('/api/events', async (req, reply) => {
    const res = reply.raw;

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if present
    });
    res.flushHeaders?.();

    // Send a named 'connected' event so the client knows the stream is live
    res.write('event: connected\ndata: {}\n\n');

    const onUpdate = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    emitter.on('job:update', onUpdate);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 20_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      emitter.off('job:update', onUpdate);
    };

    req.raw.on('close',   cleanup);
    req.raw.on('error',   cleanup);
    req.raw.on('aborted', cleanup);

    // Never resolve — Fastify must not close the response
    await new Promise(() => {});
  });
}

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import path from 'path';

import config from './config.js';
import uploadRoutes    from './routes/upload.js';
import submitRoutes    from './routes/submit.js';
import jobsRoutes      from './routes/jobs.js';
import browseRoutes    from './routes/browse.js';
import eventsRoute     from './routes/events.js';
import syncRoutes      from './routes/sync.js';
import appConfigRoute  from './routes/appConfig.js';
import { startWorker, stopWorker } from './worker/index.js';
import { startSyncWorker, stopSyncWorker } from './worker/sync-worker.js';
import { startHubWorker, stopHubWorker } from './worker/hub-worker.js';
import hubRoutes from './routes/hub/index.js';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

// ── Multipart (file uploads) ──────────────────────────────────────────────────
// 12 GB limit accommodates several minutes of ProRes or high-bitrate HEVC
await fastify.register(multipart, {
  limits: { fileSize: 12 * 1024 ** 3 },
});

// ── Static frontend (production build) ───────────────────────────────────────
// In development, Vite serves the frontend on its own port and proxies /api.
// In production (after `npm run build`), Fastify serves the compiled assets.
try {
  await fastify.register(staticPlugin, {
    root:     config.staticRoot,
    prefix:   '/',
    wildcard: false,          // let explicit routes take priority
  });
  // SPA fallback: any unmatched GET returns index.html
  fastify.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html', config.staticRoot);
  });
} catch {
  // Static dir doesn't exist yet (dev mode before first build) — silently skip
  fastify.log.warn('Frontend dist directory not found — static serving disabled (dev mode).');
}

// ── API routes ────────────────────────────────────────────────────────────────
await fastify.register(uploadRoutes);
await fastify.register(submitRoutes);
await fastify.register(jobsRoutes);
await fastify.register(browseRoutes);
await fastify.register(eventsRoute);
await fastify.register(syncRoutes);
await fastify.register(appConfigRoute);

if (config.deviceRole === 'hub') {
  await fastify.register(hubRoutes);
  fastify.log.info('Device role: hub — hub routes registered');
} else {
  fastify.log.info('Device role: remote');
}

// ── Startup ───────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  startWorker();
  startSyncWorker();
  if (config.deviceRole === 'hub') startHubWorker();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal} — shutting down.`);
  stopWorker();
  stopSyncWorker();
  if (config.deviceRole === 'hub') stopHubWorker();
  await fastify.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

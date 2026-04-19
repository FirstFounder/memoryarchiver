import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import cors from '@fastify/cors';
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
import coopRoutes from './routes/coop/index.js';
import { startCoopScheduler, stopCoopScheduler } from './lib/coopScheduler.js';
import teslaRoutes from './routes/tesla/index.js';
import { startTeslaScheduler, stopTeslaScheduler } from './lib/teslaScheduler.js';
import caRoutes from './routes/ca/index.js';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

// ── CORS — allow requests from other internal nodes ───────────────────────────
// Remote nodes (iolo, jaana, iron) fetch /api/hub/cameras directly from noah's
// backend over the internal S2S links. Without this header the browser blocks
// cross-origin requests. Restricted to the internal 192.168.x.x subnets.
await fastify.register(cors, {
  origin: /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
  methods: ['GET', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
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

if (config.coopEnabled) {
  await fastify.register(coopRoutes);
  fastify.log.info('Coop enabled — coop routes registered');
}

if (config.teslaEnabled) {
  await fastify.register(teslaRoutes);
  fastify.log.info('Tesla enabled — Tesla routes registered');
}

if (config.caEnabled) {
  await fastify.register(caRoutes);
  fastify.log.info('CA enabled — CA routes registered');
}

// ── Startup ───────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  startWorker();
  startSyncWorker();
  if (config.deviceRole === 'hub') startHubWorker();
  if (config.coopEnabled) startCoopScheduler();
  if (config.teslaEnabled) startTeslaScheduler();
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
  if (config.coopEnabled) stopCoopScheduler();
  if (config.teslaEnabled) stopTeslaScheduler();
  await fastify.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedStatus = null;
let cacheTime = 0;

function parseStatusOutput(raw) {
  const lines = raw.split('\n');
  let health = 'error';
  const certs = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('container_status=')) {
      health = line.slice('container_status='.length).trim() === 'running' ? 'ok' : 'error';
      continue;
    }

    if (line.trim() === '---') {
      if (current) certs.push(current);
      current = {};
      continue;
    }

    if (!current) continue;

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }

  if (current && Object.keys(current).length) certs.push(current);

  const now = Date.now();
  const annotated = certs.map((cert) => {
    const expiresMs = cert.expires ? Date.parse(cert.expires) : NaN;
    const daysRemaining = Number.isNaN(expiresMs)
      ? null
      : Math.floor((expiresMs - now) / 86_400_000);

    let status = 'active';
    if (cert.revoked) status = 'revoked';
    else if (daysRemaining !== null && daysRemaining <= 30) status = 'expiring';

    return { ...cert, daysRemaining, status };
  });

  return { health, certs: annotated };
}

export default async function caRoutes(fastify) {
  fastify.get('/api/ca/status', async (_req, reply) => {
    const now = Date.now();
    if (cachedStatus && now - cacheTime < CACHE_TTL_MS) {
      return cachedStatus;
    }

    try {
      const { stdout } = await execFileAsync('sudo', [
        '/usr/local/bin/ca-status-read.sh',
      ]);

      cachedStatus = parseStatusOutput(stdout);
      cacheTime = now;
      return cachedStatus;
    } catch (err) {
      fastify.log.error('ca/status error: ' + err.message);
      return reply.code(500).send({ health: 'error', certs: [], error: err.message });
    }
  });
}

/**
 * Hub sync worker — runs only when DEVICE_ROLE=hub.
 *
 * Responsibilities:
 *  - Register one node-cron job per hub_destination at startup.
 *  - Support hot-reload of a single destination's schedule via reloadDestinationSchedule().
 *  - For each scheduled or manual run: manifest check → mount → rsync → unmount → manifest write.
 *  - Emit hub-sync SSE events at every phase transition and progress update.
 *  - Persist progress + status to hub_sync_jobs after every SSE emit.
 *  - Daily cleanup of hub_sync_jobs rows older than one year.
 */

import cron from 'node-cron';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

import db from '../db/client.js';
import emitter from '../lib/emitter.js';
import { writeManifest, manifestMatchesTree } from '../lib/manifest.js';

const execAsync = promisify(exec);

// destinationId → node-cron ScheduledTask
const cronTasks = new Map();

// Set of destinationIds with a sync currently in flight
const running = new Set();

// ── Public API ────────────────────────────────────────────────────────────────

export function startHubWorker() {
  resetStalledJobs();
  loadAndScheduleAll();
  scheduleCleanup();
  runCleanup(); // purge on startup too
  console.log('[hub-worker] Started');
}

export function stopHubWorker() {
  for (const task of cronTasks.values()) task.stop();
  cronTasks.clear();
}

/**
 * Cancel and re-register the cron job for one destination.
 * Called by PATCH /api/hub/destinations/:id after a schedule or enabled change.
 */
export function reloadDestinationSchedule(destinationId) {
  const existing = cronTasks.get(destinationId);
  if (existing) {
    existing.stop();
    cronTasks.delete(destinationId);
  }
  const dest = db.prepare('SELECT * FROM hub_destinations WHERE id = ?').get(destinationId);
  if (dest && dest.enabled) registerCron(dest);
}

/**
 * Enqueue an immediate sync for destinationId.
 * Returns the new jobId, or null if the destination is already running.
 * Exported so POST /api/hub/destinations/:id/sync can call it directly.
 */
export async function triggerSync(destinationId) {
  if (running.has(destinationId)) {
    console.log(`[hub-worker] Destination ${destinationId} already running — skipping trigger`);
    return null;
  }

  const dest = db.prepare('SELECT * FROM hub_destinations WHERE id = ?').get(destinationId);
  if (!dest) throw new Error(`hub_destinations row ${destinationId} not found`);
  if (!dest.enabled) {
    console.log(`[hub-worker] ${dest.hostname} is disabled — skipping trigger`);
    return null;
  }

  const jobId = db.prepare(`
    INSERT INTO hub_sync_jobs (destination_id, started_at, status)
    VALUES (?, datetime('now'), 'pending')
  `).run(destinationId).lastInsertRowid;

  emitEvent(dest, jobId, { type: 'job_update', status: 'pending', phase: 'manifest_check', progress: 0 });

  running.add(destinationId);
  runSyncJob(dest, jobId)
    .catch(err => console.error(`[hub-worker] Unhandled error in job ${jobId}:`, err))
    .finally(() => running.delete(destinationId));

  return jobId;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function resetStalledJobs() {
  const n = db.prepare(`
    UPDATE hub_sync_jobs
    SET status = 'error', error_msg = 'Worker restarted while job was in flight',
        finished_at = datetime('now')
    WHERE status IN ('pending', 'running')
  `).run().changes;
  if (n > 0) console.log(`[hub-worker] Reset ${n} stalled job(s) to error`);
}

function loadAndScheduleAll() {
  const destinations = db.prepare('SELECT * FROM hub_destinations').all();
  for (const dest of destinations) {
    if (dest.enabled) registerCron(dest);
  }
  console.log(`[hub-worker] Scheduled ${cronTasks.size} destination(s)`);
}

function registerCron(dest) {
  if (!cron.validate(dest.schedule)) {
    console.error(`[hub-worker] Invalid cron expression for ${dest.hostname}: "${dest.schedule}"`);
    return;
  }
  const task = cron.schedule(dest.schedule, () => {
    triggerSync(dest.id).catch(err =>
      console.error(`[hub-worker] triggerSync error for ${dest.hostname}:`, err),
    );
  }, { timezone: 'America/Chicago' });
  cronTasks.set(dest.id, task);
  console.log(`[hub-worker] Registered cron for ${dest.hostname}: ${dest.schedule}`);
}

function scheduleCleanup() {
  cron.schedule('0 3 * * *', runCleanup, { timezone: 'America/Chicago' });
}

function runCleanup() {
  const n = db.prepare(`
    DELETE FROM hub_sync_jobs WHERE started_at < datetime('now', '-1 year')
  `).run().changes;
  if (n > 0) console.log(`[hub-worker] Purged ${n} old job record(s)`);
}

// ── Core sync logic ───────────────────────────────────────────────────────────

async function runSyncJob(dest, jobId) {
  const mountPoints = JSON.parse(dest.mount_points);
  const startedAt = Date.now();

  db.prepare(`UPDATE hub_sync_jobs SET status = 'running' WHERE id = ?`).run(jobId);

  try {
    // ── Phase: manifest_check ─────────────────────────────────────────────────
    emitProgress(dest, jobId, { status: 'running', phase: 'manifest_check', progress: 0 });

    const famManifestPath  = `/volume1/RFA/.manifests/${dest.hostname}/fam.manifest`;
    const vaultManifestPath = `/volume1/RFA/.manifests/${dest.hostname}/vault.manifest`;

    const [famMatch, vaultMatch] = await Promise.all([
      manifestMatchesTree({ sourcePath: '/volume1/RFA/Fam',  manifestPath: famManifestPath }),
      manifestMatchesTree({ sourcePath: '/volume1/RFA/Vault', manifestPath: vaultManifestPath }),
    ]);

    if (famMatch && vaultMatch) {
      const duration = Math.round((Date.now() - startedAt) / 1000);
      db.transaction(() => {
        db.prepare(`
          UPDATE hub_sync_jobs
          SET status = 'skipped', skipped_reason = 'manifest_match',
              finished_at = datetime('now'), duration_seconds = ?
          WHERE id = ?
        `).run(duration, jobId);
        db.prepare(`
          UPDATE hub_destinations
          SET last_sync_at = datetime('now'), last_error = NULL,
              last_attempt = datetime('now')
          WHERE id = ?
        `).run(dest.id);
      })();
      emitEvent(dest, jobId, { type: 'skipped', status: 'skipped', phase: null, progress: null });
      return;
    }

    // ── Phase: mounting ───────────────────────────────────────────────────────
    emitProgress(dest, jobId, { status: 'running', phase: 'mounting', progress: 0 });

    // Deduplicate by local path — iolo/jaana/iron share one mount for both trees
    const uniqueMounts = [...new Map(mountPoints.map(mp => [mp.local, mp])).values()];
    const mounted = [];

    for (const mp of uniqueMounts) {
      await execAsync(`mkdir -p "${mp.local}"`);
      try {
        await execAsync(`mount -t nfs -o "${dest.mount_options}" "${mp.remote}" "${mp.local}"`);
        mounted.push(mp.local);
      } catch (mountErr) {
        // Unmount any already-mounted points before re-throwing
        for (const localPath of mounted) {
          await execAsync(`umount "${localPath}"`).catch(() => {});
        }
        throw new Error(`NFS mount failed for ${mp.remote}: ${mountErr.message.slice(0, 300)}`);
      }
    }

    // ── rsync phase(s) ────────────────────────────────────────────────────────
    let famBytes = 0, vaultBytes = 0;
    let famStatus = 'done', vaultStatus = 'done';
    let errorMsg = null;

    try {
      if (dest.parallel) {
        await runParallelRsync({ dest, jobId, mountPoints });
        // bytes captured inside parallel helper — read back from job row
        const row = db.prepare('SELECT fam_bytes, vault_bytes FROM hub_sync_jobs WHERE id = ?').get(jobId);
        famBytes = row?.fam_bytes ?? 0;
        vaultBytes = row?.vault_bytes ?? 0;
      } else {
        const result = await runSequentialRsync({ dest, jobId, mountPoints });
        famBytes   = result.famBytes;
        vaultBytes = result.vaultBytes;
        famStatus  = result.famStatus;
        vaultStatus = result.vaultStatus;
        errorMsg   = result.errorMsg;
      }
    } finally {
      // ── Phase: unmounting — always runs even if rsync errored ─────────────
      emitProgress(dest, jobId, { status: 'running', phase: 'unmounting', progress: dest.parallel ? null : 95 });
      for (const localPath of mounted) {
        await execAsync(`umount "${localPath}"`).catch(err =>
          console.warn(`[hub-worker] umount failed for ${localPath}:`, err.message),
        );
      }
    }

    // Re-read per-tree status from DB for parallel path (set inside runParallelRsync)
    if (dest.parallel) {
      const row = db.prepare('SELECT fam_status, vault_status, error_msg FROM hub_sync_jobs WHERE id = ?').get(jobId);
      famStatus  = row?.fam_status  ?? 'done';
      vaultStatus = row?.vault_status ?? 'done';
      errorMsg   = row?.error_msg   ?? null;
    }

    const overallStatus = (famStatus === 'error' || vaultStatus === 'error') ? 'error' : 'done';

    // ── Phase: writing_manifest (only on full success) ────────────────────────
    if (overallStatus === 'done') {
      emitProgress(dest, jobId, { status: 'running', phase: 'writing_manifest', progress: dest.parallel ? null : 98 });
      await fs.mkdir(`/volume1/RFA/.manifests/${dest.hostname}`, { recursive: true });
      await Promise.all([
        writeManifest({ sourcePath: '/volume1/RFA/Fam',  outputPath: famManifestPath }),
        writeManifest({ sourcePath: '/volume1/RFA/Vault', outputPath: vaultManifestPath }),
      ]);

      // ── Phase: disk_sleep (bang only) ──────────────────────────────────────
      if (dest.ssh_key_path) {
        emitProgress(dest, jobId, { status: 'running', phase: 'disk_sleep', progress: null });
        try {
          await execAsync(
            `ssh -i "${dest.ssh_key_path}" -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o ConnectTimeout=15` +
            ` root@${dest.ip} "hdparm -Y /dev/sda && hdparm -Y /dev/sdb"`,
          );
        } catch (sshErr) {
          // Non-fatal: sync succeeded; disk sleep is best-effort
          errorMsg = `post-sync disk sleep failed: ${sshErr.message.slice(0, 300)}`;
          console.warn(`[hub-worker] Disk sleep failed for ${dest.hostname}:`, sshErr.message);
          emitEvent(dest, jobId, { type: 'disk_sleep_failed', status: 'done', error: errorMsg });
        }
      }
    }

    // ── Finalize job row ──────────────────────────────────────────────────────
    const duration = Math.round((Date.now() - startedAt) / 1000);
    const totalBytes = (famBytes || 0) + (vaultBytes || 0);
    const avgBitrateKbps = duration > 0 ? Math.round(totalBytes / duration / 1024) : 0;

    db.transaction(() => {
      db.prepare(`
        UPDATE hub_sync_jobs
        SET status = ?, finished_at = datetime('now'), duration_seconds = ?,
            fam_bytes = ?, vault_bytes = ?, fam_status = ?, vault_status = ?,
            error_msg = ?, avg_bitrate_kbps = ?,
            progress = CASE WHEN ? = 'done' THEN 100 ELSE progress END
        WHERE id = ?
      `).run(overallStatus, duration, famBytes, vaultBytes, famStatus, vaultStatus,
        errorMsg, avgBitrateKbps, overallStatus, jobId);

      if (overallStatus === 'done') {
        db.prepare(`
          UPDATE hub_destinations
          SET last_sync_at = datetime('now'), last_error = NULL,
              last_attempt = datetime('now')
          WHERE id = ?
        `).run(dest.id);
      } else {
        db.prepare(`
          UPDATE hub_destinations
          SET last_error = ?, last_attempt = datetime('now')
          WHERE id = ?
        `).run((errorMsg ?? 'Unknown error').slice(0, 500), dest.id);
      }
    })();

    emitEvent(dest, jobId, {
      type: 'job_update',
      status: overallStatus,
      phase: null,
      progress: overallStatus === 'done' ? 100 : null,
      error: errorMsg ?? null,
    });

  } catch (err) {
    // Mount failure or other fatal pre/post-rsync error
    const duration = Math.round((Date.now() - startedAt) / 1000);
    const msg = err.message.slice(0, 2000);

    db.transaction(() => {
      db.prepare(`
        UPDATE hub_sync_jobs
        SET status = 'error', finished_at = datetime('now'),
            error_msg = ?, duration_seconds = ?
        WHERE id = ?
      `).run(msg, duration, jobId);
      db.prepare(`
        UPDATE hub_destinations
        SET last_error = ?, last_attempt = datetime('now')
        WHERE id = ?
      `).run(msg.slice(0, 500), dest.id);
    })();

    emitEvent(dest, jobId, { type: 'mount_error', status: 'error', error: msg.slice(0, 500) });
    console.error(`[hub-worker] Job ${jobId} (${dest.hostname}) failed:`, msg);
  }
}

// ── Sequential rsync (iolo, jaana, iron) ─────────────────────────────────────

async function runSequentialRsync({ dest, jobId, mountPoints }) {
  const famMP   = mountPoints.find(mp => mp.tree === 'fam');
  const vaultMP = mountPoints.find(mp => mp.tree === 'vault');

  const famDest   = buildRsyncDest(famMP);
  const vaultDest = buildRsyncDest(vaultMP);

  let famBytes = 0, vaultBytes = 0;
  let famStatus = 'done', vaultStatus = 'done';
  let errorMsg = null;

  // Fam: raw rsync progress 0–100 → scaled 0–50
  emitProgress(dest, jobId, { status: 'running', phase: 'rsync_fam', progress: 0 });
  try {
    const r = await runHubRsync({
      src: famMP.src,
      dest: famDest,
      bwlimit: dest.bwlimit,
      onProgress: pct => {
        const scaled = Math.round(pct * 50);
        db.prepare(`UPDATE hub_sync_jobs SET progress = ? WHERE id = ?`).run(scaled, jobId);
        emitProgress(dest, jobId, { status: 'running', phase: 'rsync_fam', progress: scaled });
      },
    });
    famBytes = r.bytes;
  } catch (err) {
    famStatus = 'error';
    errorMsg = err.message.slice(0, 500);
    console.error(`[hub-worker] Job ${jobId} fam rsync error:`, err.message);
  }

  // Vault: raw rsync progress 0–100 → scaled 50–100
  emitProgress(dest, jobId, { status: 'running', phase: 'rsync_vault', progress: 50 });
  try {
    const r = await runHubRsync({
      src: vaultMP.src,
      dest: vaultDest,
      bwlimit: dest.bwlimit,
      onProgress: pct => {
        const scaled = 50 + Math.round(pct * 50);
        db.prepare(`UPDATE hub_sync_jobs SET progress = ? WHERE id = ?`).run(scaled, jobId);
        emitProgress(dest, jobId, { status: 'running', phase: 'rsync_vault', progress: scaled });
      },
    });
    vaultBytes = r.bytes;
  } catch (err) {
    vaultStatus = 'error';
    if (!errorMsg) errorMsg = err.message.slice(0, 500);
    console.error(`[hub-worker] Job ${jobId} vault rsync error:`, err.message);
  }

  return { famBytes, vaultBytes, famStatus, vaultStatus, errorMsg };
}

// ── Parallel rsync (bang) ─────────────────────────────────────────────────────

async function runParallelRsync({ dest, jobId, mountPoints }) {
  const famMP   = mountPoints.find(mp => mp.tree === 'fam');
  const vaultMP = mountPoints.find(mp => mp.tree === 'vault');

  const famDest   = buildRsyncDest(famMP);
  const vaultDest = buildRsyncDest(vaultMP);

  let progressFam = 0, progressVault = 0;
  let famBytes = 0, vaultBytes = 0;
  let famStatus = 'done', vaultStatus = 'done';
  let errorMsg = null;

  const famTask = runHubRsync({
    src: famMP.src,
    dest: famDest,
    bwlimit: dest.bwlimit,
    onProgress: pct => {
      progressFam = Math.round(pct * 100);
      emitProgress(dest, jobId, {
        status: 'running',
        phase: 'rsync_fam',
        progress: null,
        progressFam,
        progressVault,
      });
    },
  }).then(r => { famBytes = r.bytes; }).catch(err => {
    famStatus = 'error';
    errorMsg = err.message.slice(0, 500);
  });

  const vaultTask = runHubRsync({
    src: vaultMP.src,
    dest: vaultDest,
    bwlimit: dest.bwlimit,
    onProgress: pct => {
      progressVault = Math.round(pct * 100);
      emitProgress(dest, jobId, {
        status: 'running',
        phase: 'rsync_vault',
        progress: null,
        progressFam,
        progressVault,
      });
    },
  }).then(r => { vaultBytes = r.bytes; }).catch(err => {
    vaultStatus = 'error';
    if (!errorMsg) errorMsg = err.message.slice(0, 500);
  });

  await Promise.all([famTask, vaultTask]);

  // Persist per-tree results for later read-back in runSyncJob
  db.prepare(`
    UPDATE hub_sync_jobs
    SET fam_bytes = ?, vault_bytes = ?, fam_status = ?, vault_status = ?, error_msg = ?
    WHERE id = ?
  `).run(famBytes, vaultBytes, famStatus, vaultStatus, errorMsg, jobId);
}

// ── rsync process wrapper ─────────────────────────────────────────────────────

/**
 * Run one rsync call and return { bytes } on success.
 * Uses --info=progress2 for overall-percentage progress.
 * Uses --stats for total bytes transferred (parsed from stdout).
 */
async function runHubRsync({ src, dest, bwlimit, onProgress }) {
  await execAsync(`mkdir -p "${dest}"`);

  const args = [
    '--archive',
    '--size-only',
    '--delete',
    '--no-perms',
    '--no-owner',
    '--no-group',
    '--info=progress2',
    '--stats',
  ];
  if (bwlimit) args.push(`--bwlimit=${bwlimit}`);
  args.push(src, dest);

  const proc = spawn('stdbuf', ['-o0', 'rsync', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const remnantOut = { value: '' };
  const remnantErr = { value: '' };
  const stdoutChunks = [];
  const stderrLines  = [];

  function parseProgress(text, remnant) {
    const combined = remnant.value + text;
    const parts = combined.split(/[\r\n]+/);
    remnant.value = parts.pop() ?? '';
    for (const line of parts) {
      const m = line.match(/(\d+)%/);
      if (m) onProgress(Math.min(0.99, parseInt(m[1], 10) / 100));
    }
  }

  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    stdoutChunks.push(text);
    parseProgress(text, remnantOut);
  });

  proc.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderrLines.push(text);
    parseProgress(text, remnantErr);
  });

  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        onProgress(1.0);
        const statsText = stdoutChunks.join('');
        const m = statsText.match(/Total transferred file size:\s*([\d,]+)/);
        const bytes = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
        resolve({ bytes });
      } else {
        const errText = stderrLines.join('').slice(-1500);
        reject(new Error(`rsync exited ${code}: ${errText}`));
      }
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function buildRsyncDest(mp) {
  return mp.dest_subdir ? `${mp.local}/${mp.dest_subdir}/` : `${mp.local}/`;
}

function emitProgress(dest, jobId, fields) {
  emitEvent(dest, jobId, { type: 'job_update', ...fields });
}

function emitEvent(dest, jobId, fields) {
  emitter.emit('hub-sync:update', {
    jobId,
    destinationId: dest.id,
    hostname: dest.hostname,
    updatedAt: new Date().toISOString(),
    ...fields,
  });
}

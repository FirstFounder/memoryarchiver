import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import config from '../config.js';

const execAsync = promisify(exec);
import { buildFadeFilters } from './fades.js';

const NAS_ROOT    = '/volume1/RFA';
const SQUAT_MOUNT = '/Volumes/iloRFA';
const STAGING_DIR = '/volume1/RFA/scratch/squat-staging';

function toSquatPath(ioloPath) {
  return SQUAT_MOUNT + ioloPath.slice(NAS_ROOT.length);
}

// Copy any source file not already on the RFA share into the staging directory.
// Returns { ioloPath, squatPath, staged } for each input.
function stageSourceFiles(jobId, srcPaths) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  try {
    fs.chownSync(STAGING_DIR, config.outputUid, config.outputGid);
    fs.chmodSync(STAGING_DIR, 0o775);
  } catch (err) {
    console.warn(`[squat] Could not set ownership on ${STAGING_DIR}:`, err.message);
  }

  return srcPaths.map((ioloPath) => {
    if (ioloPath.startsWith(NAS_ROOT)) {
      return { ioloPath, squatPath: toSquatPath(ioloPath), staged: false };
    }
    const basename = path.basename(ioloPath);
    const stagedIoloPath = path.join(STAGING_DIR, `${jobId}-${basename}`);
    fs.copyFileSync(ioloPath, stagedIoloPath);
    fs.chmodSync(stagedIoloPath, 0o664); // copyFileSync preserves source perms; ensure NFS-readable
    return { ioloPath, squatPath: toSquatPath(stagedIoloPath), staged: true };
  });
}

// Delete staged copies — fire and forget, non-fatal.
function cleanupStagedFiles(entries) {
  for (const entry of entries) {
    if (!entry.staged) continue;
    const stagedIoloPath = NAS_ROOT + entry.squatPath.slice(SQUAT_MOUNT.length);
    fs.unlink(stagedIoloPath, (err) => {
      if (err) console.warn(`[squat] Could not delete staged file ${stagedIoloPath}:`, err.message);
    });
  }
}

// Mirrors the audio bitrate table in pipeline.js — same resolution thresholds.
function audioBitrateForHeight(maxHeight) {
  if (maxHeight >= 1080) return '192k';
  return '128k';
}

async function checkHealth(host, port) {
  const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Squat health check failed: ${res.status}`);
  const body = await res.json();
  if (!body.nfsMounted) throw new Error('Squat NFS mount is not active');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntilDone(host, port) {
  const POLL_INTERVAL = 5_000;
  const TIMEOUT_MS    = 2 * 60 * 60 * 1000;
  const deadline      = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const res  = await fetch(`http://${host}:${port}/status`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    if (body.status === 'idle')    return;
    if (body.status === 'error')   throw new Error(`Squat encoder error: ${body.errorMsg}`);
    // status === 'encoding' — continue polling
  }
  throw new Error('Squat encode timed out after 2 hours');
}

export async function runSquatPipeline({ jobId, srcPaths, fileMeta, outputPath, longDesc, onProgress }) {
  const { squatHost: host, squatPort: port } = config;

  const stagedEntries   = stageSourceFiles(jobId, srcPaths);
  const squatSrcPaths   = stagedEntries.map(e => e.squatPath);
  const squatOutputPath = toSquatPath(outputPath); // output always on RFA

  try {
    // 1. Verify squat is reachable and NFS is mounted before dispatching
    await checkHealth(host, port);

    const N         = srcPaths.length;
    const maxHeight = Math.max(...fileMeta.map(m => m.height));
    const audioBitrate = audioBitrateForHeight(maxHeight);

    // 2. Build ffmpegArgs — everything except -i inputs and output path,
    //    which squat's service prepends/appends itself.
    const args = [];

    if (N === 1) {
      const { vf, af } = buildFadeFilters(fileMeta[0].duration, fileMeta[0].fps);
      args.push('-vf', vf, '-af', af);
    } else {
      const filterParts = [];
      for (let i = 0; i < N; i++) {
        const { vf, af } = buildFadeFilters(fileMeta[i].duration, fileMeta[i].fps);
        filterParts.push(`[${i}:v]${vf}[v${i}]`);
        filterParts.push(`[${i}:a]${af}[a${i}]`);
      }
      const vInputs = Array.from({ length: N }, (_, i) => `[v${i}]`).join('');
      const aInputs = Array.from({ length: N }, (_, i) => `[a${i}]`).join('');
      filterParts.push(`${vInputs}concat=n=${N}:v=1:a=0[vout]`);
      filterParts.push(`${aInputs}concat=n=${N}:v=0:a=1[aout]`);

      args.push(
        '-filter_complex', filterParts.join(';'),
        '-map', '[vout]',
        '-map', '[aout]',
      );
    }

    // VideoToolbox instead of libx265; -q:v replaces -crf
    args.push(
      '-c:v', 'hevc_videotoolbox',
      '-q:v', String(config.squatQuality),
      '-tag:v', 'hvc1',       // required for Apple/iOS playback
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-metadata', `comment=${longDesc}`,
      '-y',
    );

    // Ensure the output directory exists on iolo before squat tries to write via NFS
    const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    fs.mkdirSync(outputDir, { recursive: true });
    try {
      fs.chownSync(outputDir, config.outputUid, config.outputGid);
      fs.chmodSync(outputDir, 0o775);
    } catch (err) {
      console.warn(`[squat] Could not set ownership on ${outputDir}:`, err.message);
    }

    // 3. Dispatch encode job to squat
    const encodeRes = await fetch(`http://${host}:${port}/encode`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jobId,
        sourcePaths: squatSrcPaths,
        outputPath:  squatOutputPath,
        ffmpegArgs:  args,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!encodeRes.ok) {
      const text = await encodeRes.text().catch(() => '');
      throw new Error(`Squat /encode rejected (${encodeRes.status}): ${text}`);
    }

    // 4. Signal that the job is live on the remote encoder
    onProgress(0.01);

    // 5. Poll until squat reports idle (done) or error
    await pollUntilDone(host, port);

    // 6. Fix ownership — squat writes as UID 501 (jrennert), unknown on iolo
    try {
      console.log(`[squat] chowning ${outputPath} to ${config.outputUid}:${config.outputGid}`);
      await execAsync(`chmod 644 "${outputPath}"`);
      await execAsync(`chown ${config.outputUid}:${config.outputGid} "${outputPath}"`);
      console.log(`[squat] chown complete`);
    } catch (err) {
      console.warn(`[squat] Could not set ownership on ${outputPath}:`, err.message);
    }
  } finally {
    cleanupStagedFiles(stagedEntries);
  }
}

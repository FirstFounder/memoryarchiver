import fs from 'fs';
import path from 'path';
import { chown, chmod, copyFile } from 'fs/promises';
import config from '../config.js';
import { buildFadeFilters } from './fades.js';

const NAS_ROOT    = '/volume1/RFA';
const SQUAT_MOUNT = '/Volumes/iloRFA';

/**
 * Translate an iolo-local path under NAS_ROOT to squat's NFS mount path.
 * Only valid for paths already under NAS_ROOT — stage scratch/temp files first.
 */
function toSquatPath(ioloPath) {
  if (!ioloPath.startsWith(NAS_ROOT)) {
    throw new Error(`Path not on RFA share: ${ioloPath}`);
  }
  return SQUAT_MOUNT + ioloPath.slice(NAS_ROOT.length);
}

/**
 * Copy any source file that is not already under NAS_ROOT into UPLOAD_TEMP_DIR
 * so squat can reach it via the NFS mount.  Returns an array of { original,
 * staged } pairs for cleanup, and the translated squat-visible path array.
 */
async function stageSourcesForSquat(srcPaths) {
  const tempDir  = config.uploadTempDir;
  const stagedMap = []; // { original: string, staged: string | null }

  const squatPaths = await Promise.all(srcPaths.map(async (src) => {
    if (src.startsWith(NAS_ROOT)) {
      stagedMap.push({ original: src, staged: null });
      return toSquatPath(src);
    }

    // File is outside the RFA share (e.g. scratch or upload temp) — copy it
    // into UPLOAD_TEMP_DIR which IS under NAS_ROOT via /volume1/homes/...
    // Wait — UPLOAD_TEMP_DIR is under /volume1/homes, not /volume1/RFA either.
    // We need to stage into the RFA tree itself. Use a dedicated staging dir.
    const stagingDir = path.join(NAS_ROOT, '_squat_staging');
    fs.mkdirSync(stagingDir, { recursive: true });

    const tmpName = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(src)}`;
    const staged  = path.join(stagingDir, tmpName);

    await copyFile(src, staged);
    fs.chmodSync(staged, 0o644);  // ensure squat can read via NFS regardless of source permissions
    stagedMap.push({ original: src, staged });
    return toSquatPath(staged);
  }));

  return { squatPaths, stagedMap };
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

  // 1. Verify squat is reachable and NFS is mounted before dispatching
  await checkHealth(host, port);

  // 2. Stage any source files that are not under NAS_ROOT (scratch, upload temp)
  //    into /volume1/RFA/_squat_staging so squat can reach them via NFS.
  const { squatPaths: squatSrcPaths, stagedMap } = await stageSourcesForSquat(srcPaths);
  const squatOutputPath = toSquatPath(outputPath);

  const N          = srcPaths.length;
  const maxHeight  = Math.max(...fileMeta.map(m => m.height));
  const audioBitrate = audioBitrateForHeight(maxHeight);

  // Output frame rate — use the highest fps across all source clips.
  // -fps_mode cfr forces constant frame rate output, which is required for
  // iPhone HEVC footage whose VFR container avg_frame_rate (~59.94) causes
  // ffmpeg to silently downgrade the output to 30fps without this flag.
  const outputFps = Math.max(...fileMeta.map(m => m.fps));

  // 3. Build ffmpegArgs — everything except -i inputs and output path,
  //    which squat's service prepends/appends itself.
  const args = [];

  if (N === 1) {
    // Explicitly map only the first video and audio streams to drop iPhone
    // metadata/telemetry tracks (mebx, tmcd, etc.) that cause ffmpeg to exit 234.
    const { vf, af } = buildFadeFilters(fileMeta[0].duration, fileMeta[0].fps);
    args.push('-map', '0:v:0', '-map', '0:a:0', '-vf', vf, '-af', af);
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
    '-fps_mode', 'cfr',          // force constant frame rate output
    '-r', String(outputFps),     // lock output frame rate to probed source fps
    '-c:v', 'hevc_videotoolbox',
    '-q:v', String(config.squatQuality),
    '-tag:v', 'hvc1',            // required for Apple/iOS playback
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

  try {
    // 4. Dispatch encode job to squat
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

    // 5. Signal that the job is live on the remote encoder
    onProgress(0.01);

    // 6. Poll until squat reports idle (done) or error
    await pollUntilDone(host, port);

    // 7. Fix ownership — squat writes as UID 501 (jrennert), unknown on iolo
    try {
      await chmod(outputPath, 0o644);
      await chown(outputPath, config.outputUid, config.outputGid);
    } catch (err) {
      console.warn(`[squat] Could not set ownership on ${outputPath}:`, err.message);
    }
  } finally {
    // 8. Clean up any staged copies in _squat_staging (best-effort)
    for (const { staged } of stagedMap) {
      if (staged) {
        try { fs.unlinkSync(staged); } catch { /* best-effort */ }
      }
    }
  }
}

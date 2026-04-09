import { spawn } from 'child_process';
import fs from 'fs';
import { chown, chmod } from 'fs/promises';
import config from '../config.js';
import { buildFadeFilters } from './fades.js';

/**
 * H.265 encoding presets keyed by vertical resolution.
 * CRF and preset balance quality vs. encode time on the DS220+'s Celeron J4025.
 * -tag:v hvc1 is required for Apple QuickTime / iOS playback of H.265 in an MP4 container.
 */
function encodingParams(maxHeight) {
  if (maxHeight >= 2160) return { crf: 22, preset: 'medium', audioBitrate: '192k' };
  if (maxHeight >= 1080) return { crf: 22, preset: 'slow',   audioBitrate: '192k' };
  return                        { crf: 23, preset: 'slow',   audioBitrate: '128k' };
}

/**
 * Encode one job to its output file.
 *
 * @param {object}   opts
 * @param {string[]} opts.srcPaths      - ordered array of source file paths
 * @param {Array<{duration:number, height:number, fps:number}>} opts.fileMeta
 * @param {string}   opts.outputPath    - full path including filename
 * @param {string}   opts.longDesc      - written to the MP4 "comment" tag
 * @param {function} opts.onProgress    - called with a number 0–1
 * @returns {Promise<void>}
 */
export async function runPipeline({ srcPaths, fileMeta, outputPath, longDesc, onProgress }) {
  const N = srcPaths.length;
  const maxHeight = Math.max(...fileMeta.map(m => m.height));
  const { crf, preset, audioBitrate } = encodingParams(maxHeight);

  // Total source duration — used to calculate progress percentage
  const totalDuration = fileMeta.reduce((s, m) => s + m.duration, 0);

  // ── Build FFmpeg arguments ─────────────────────────────────────────────────
  const args = [];

  // Input files
  for (const src of srcPaths) {
    args.push('-i', src);
  }

  if (N === 1) {
    // Simple single-input path (avoids filter_complex overhead)
    const { vf, af } = buildFadeFilters(fileMeta[0].duration, fileMeta[0].fps);
    args.push('-vf', vf, '-af', af);
  } else {
    // Multi-input: build a filter_complex with per-clip fades then concat
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

  // Encoding parameters
  args.push(
    '-c:v', 'libx265',
    '-crf', String(crf),
    '-preset', preset,
    '-tag:v', 'hvc1',        // required for Apple QuickTime / iOS playback
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-threads', String(config.ffmpegThreads),
    '-metadata', `comment=${longDesc}`,
    '-progress', 'pipe:1',   // machine-readable progress to stdout
    '-nostats',              // suppress the human-readable stats on stderr
    '-y',                    // overwrite output without prompting
    outputPath,
  );

  // Ensure output directory exists
  fs.mkdirSync(outputPath.substring(0, outputPath.lastIndexOf('/')), { recursive: true });

  // Spawn: nice -n {level} ffmpeg ...
  const proc = spawn('nice', ['-n', String(config.niceLevel), config.ffmpegPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // ── Parse progress from stdout ─────────────────────────────────────────────
  let stdoutBuf = '';
  proc.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // retain partial last line

    for (const line of lines) {
      if (line.startsWith('out_time_ms=')) {
        const ms = parseInt(line.slice('out_time_ms='.length), 10);
        if (ms > 0 && totalDuration > 0) {
          const pct = Math.min(0.99, ms / 1_000_000 / totalDuration);
          onProgress(pct);
        }
      }
    }
  });

  // Capture stderr for error reporting
  const stderrChunks = [];
  proc.stderr.on('data', chunk => stderrChunks.push(chunk));

  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', async code => {
      if (code === 0) {
        onProgress(1.0);
        try {
          await chmod(outputPath, 0o644);
          await chown(outputPath, config.outputUid, config.outputGid);
        } catch (err) {
          // Non-fatal — file is encoded correctly; log and continue
          console.warn(`[pipeline] Could not set ownership on ${outputPath}:`, err.message);
        }
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().slice(-2000);
        reject(new Error(`FFmpeg exited ${code}:\n${stderr}`));
      }
    });
  });
}

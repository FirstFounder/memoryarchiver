import { execFile } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Run ffprobe on a single file and return structured metadata.
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   duration: number,   // seconds
 *   width: number,
 *   height: number,
 *   fps: number,
 *   createdTs: string   // ISO-8601 local datetime string (best available)
 * }>}
 */
export async function probe(filePath) {
  const { stdout } = await execFileAsync(config.ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const fmt  = data.format ?? {};
  const tags  = fmt.tags ?? {};
  const video = data.streams?.find(s => s.codec_type === 'video') ?? {};
  const vTags = video.tags ?? {};

  // ── Duration ─────────────────────────────────────────────────────────────
  // parseFloat("N/A") → NaN, so sanitise after parsing rather than relying on
  // the ?? fallback (which only guards against null/undefined, not bad strings).
  const rawDuration = parseFloat(fmt.duration ?? video.duration ?? '0');
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;

  // ── Resolution ────────────────────────────────────────────────────────────
  const width  = video.width  ?? 0;
  const height = video.height ?? 0;

  // ── Frame rate ────────────────────────────────────────────────────────────
  // r_frame_rate is a rational string like "60000/1001" or "30/1"
  let fps = 30;
  const rfr = video.r_frame_rate ?? video.avg_frame_rate;
  if (rfr) {
    const [n, d] = rfr.split('/').map(Number);
    if (d && d !== 0) fps = Math.round(n / d);
  }

  // ── Creation timestamp ────────────────────────────────────────────────────
  // Prefer com.apple.quicktime.creationdate — it carries the local timezone offset.
  // Fall back to format-level creation_time (UTC) or stream-level.
  // We store the raw string and parse its DATE components (YYYY-MM-DD) for the
  // filename; the time-of-day and offset are irrelevant for naming purposes.
  const createdTs =
    tags['com.apple.quicktime.creationdate'] ??
    vTags['com.apple.quicktime.creationdate'] ??
    tags['creation_time'] ??
    vTags['creation_time'] ??
    new Date().toISOString();

  return { duration, width, height, fps, createdTs };
}

import { spawn } from 'child_process';
import fs from 'fs';
import config from '../config.js';

/**
 * Run rsync from src to dest with a bandwidth cap and real-time progress.
 *
 * --info=progress2  gives a single updating line with an overall percentage,
 *                   both for single-file and multi-file (tree) transfers.
 *                   Available since rsync 3.1.0 (Synology ships 3.1.2).
 *
 * Progress is emitted to stderr when rsync writes to a terminal; when piped
 * it may go to stdout instead. We parse both streams for the % pattern so
 * the behaviour is consistent regardless of rsync's buffering choices.
 *
 * @param {{ src: string, dest: string, onProgress: (pct: number) => void }} opts
 */
export async function runRsync({ src, dest, onProgress }) {
  // Ensure the destination directory exists before rsync runs
  fs.mkdirSync(dest, { recursive: true });

  const args = [
    '-av',
    '--size-only',       // skip files whose size already matches on the destination;
                         // avoids re-transferring the entire archive when NFS timestamps
                         // differ from the source (the default mtime+size check would
                         // flag every file as changed). Safe for this archive because
                         // encoded MP4s are write-once and never modified in place.
    '--info=progress2',
    `--bwlimit=${config.rsyncBwlimit}`,
    src,
    dest,
  ];

  // stdbuf -o0  forces unbuffered stdout so each \r-terminated progress line
  // is flushed to our pipe immediately rather than arriving all at once when
  // rsync exits (the default block-buffering behaviour when stdout is not a TTY).
  const proc = spawn(
    'nice', ['-n', String(config.niceLevel), 'stdbuf', '-o0', 'rsync', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  function parseChunk(text, remnantRef) {
    const combined = remnantRef.value + text;
    // Split on both \r (terminal overwrite) and \n
    const parts = combined.split(/[\r\n]+/);
    remnantRef.value = parts.pop() ?? '';
    for (const line of parts) {
      const m = line.match(/(\d+)%/);
      if (m) {
        onProgress(Math.min(0.99, parseInt(m[1], 10) / 100));
      }
    }
  }

  const remnantStdout = { value: '' };
  const remnantStderr = { value: '' };
  const errorLines = [];

  proc.stdout.on('data', chunk => parseChunk(chunk.toString(), remnantStdout));

  proc.stderr.on('data', chunk => {
    const text = chunk.toString();
    errorLines.push(text);
    parseChunk(text, remnantStderr);
  });

  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) {
        onProgress(1.0);
        resolve();
      } else {
        const errText = errorLines.join('').slice(-1500);
        reject(new Error(`rsync exited with code ${code}:\n${errText}`));
      }
    });
  });
}

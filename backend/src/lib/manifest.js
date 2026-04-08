/**
 * Manifest utilities shared by hub-worker.js and sync-worker.js.
 *
 * Manifest format: `find <path> -type f -printf '%p %s\n'`
 * One line per file: absolute path, space, byte size.
 * No checksums, no timestamps, no attributes.
 */

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

/**
 * Write a path+size manifest of all files under sourcePath to outputPath.
 * Uses GNU find's -printf to avoid stat() overhead per file.
 * Non-destructive: writes to a .tmp file then renames atomically.
 *
 * @param {{ sourcePath: string, outputPath: string }} opts
 */
export async function writeManifest({ sourcePath, outputPath }) {
  const tmpPath = outputPath + '.tmp';
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmpPath);
    const proc = spawn('find', [sourcePath, '-type', 'f', '-printf', '%p %s\n'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.pipe(out);

    const errChunks = [];
    proc.stderr.on('data', chunk => errChunks.push(chunk));
    out.on('error', reject);
    proc.on('error', reject);
    proc.on('close', code => {
      out.end();
      if (code === 0) {
        resolve();
      } else {
        const msg = Buffer.concat(errChunks).toString().slice(0, 500);
        reject(new Error(`find exited ${code}: ${msg}`));
      }
    });
  });

  await fs.rename(tmpPath, outputPath);
}

/**
 * Read a manifest file and return a Set of "<path> <size>" strings.
 * Returns an empty Set if the file does not exist or cannot be read.
 *
 * @param {string} manifestPath
 * @returns {Promise<Set<string>>}
 */
export async function readManifest(manifestPath) {
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    return new Set(content.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Return true if the current tree under sourcePath exactly matches the
 * manifest stored at manifestPath. Returns false if the manifest is absent,
 * unreadable, or any difference is found (added, removed, or resized file).
 *
 * Streams the fresh find output line-by-line against the stored Set so the
 * full tree is never held in memory twice.
 *
 * @param {{ sourcePath: string, manifestPath: string }} opts
 * @returns {Promise<boolean>}
 */
export async function manifestMatchesTree({ sourcePath, manifestPath }) {
  const stored = await readManifest(manifestPath);
  if (stored.size === 0) return false;

  return new Promise((resolve) => {
    const proc = spawn('find', [sourcePath, '-type', 'f', '-printf', '%p %s\n'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let mismatch = false;
    let lineCount = 0;

    proc.stdout.on('data', chunk => {
      if (mismatch) return;
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        lineCount++;
        if (!stored.has(line)) {
          mismatch = true;
          proc.kill('SIGTERM');
          return;
        }
      }
    });

    proc.on('error', () => resolve(false));
    proc.on('close', () => {
      if (mismatch) return resolve(false);
      // Flush any partial last line
      if (buf) {
        lineCount++;
        if (!stored.has(buf)) return resolve(false);
      }
      // Both sets must be the same size — catches deletions (stored has extras)
      resolve(lineCount === stored.size);
    });
  });
}

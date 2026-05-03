import http from 'http';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT       = 9662;
const NFS_MOUNT  = '/Volumes/iloRFA';

// ── Single job slot ───────────────────────────────────────────────────────────
// Both encode and transcribe jobs share this mutex — squat serializes all work
// regardless of type, matching the design requirement.
let slotBusy = false;
let jobState = {
  status:  'idle',        // idle | encoding | transcribing | error
  jobId:   null,
  jobType: null,          // 'encode' | 'transcribe' | null
  result:  null,          // { text, segments } populated after transcription; cleared on next job
  errorMsg: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isNfsMounted() {
  try {
    return execSync('mount', { encoding: 'utf8' }).includes(NFS_MOUNT);
  } catch {
    return false;
  }
}

function respond(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

// ── Encode job ────────────────────────────────────────────────────────────────
function runEncode({ jobId, sourcePaths, outputPath, ffmpegArgs }) {
  slotBusy = true;
  jobState  = { status: 'encoding', jobId, jobType: 'encode', result: null, errorMsg: null };

  // Build full ffmpeg argument list: [-i src ...] <ffmpegArgs> <outputPath>
  const args = [];
  for (const src of sourcePaths) args.push('-i', src);
  args.push(...ffmpegArgs, outputPath);

  console.log(`[encode] Job ${jobId} — ffmpeg ${args.slice(0, 8).join(' ')} …`);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let lastStderr = '';
  proc.stderr.on('data', d => { lastStderr = d.toString().trim(); });

  proc.on('close', code => {
    if (code === 0) {
      console.log(`[encode] Job ${jobId} complete.`);
      jobState = { status: 'idle', jobId, jobType: 'encode', result: null, errorMsg: null };
    } else {
      const msg = lastStderr.slice(-500) || `ffmpeg exited with code ${code}`;
      console.error(`[encode] Job ${jobId} failed: ${msg}`);
      jobState = { status: 'error', jobId, jobType: 'encode', result: null, errorMsg: msg };
    }
    slotBusy = false;
  });

  proc.on('error', err => {
    console.error(`[encode] Job ${jobId} spawn error: ${err.message}`);
    jobState = { status: 'error', jobId, jobType: 'encode', result: null, errorMsg: err.message };
    slotBusy = false;
  });
}

// ── Transcribe job ────────────────────────────────────────────────────────────
function runTranscribe({ jobId, audioPath, model }) {
  slotBusy = true;
  jobState  = { status: 'transcribing', jobId, jobType: 'transcribe', result: null, errorMsg: null };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));

  const args = [
    '-m', model,
    '--beam_size', '10',
    '--best_of', '5',
    '--temperature', '0',
    '--condition_on_previous_text', 'True',
    '--no_speech_threshold', '0.3',
    '--compression_ratio_threshold', '2.0',
    '--output_format', 'json',
    '--output_dir', tmpDir,
    audioPath,
  ];

  console.log(`[transcribe] Job ${jobId} — model=${model} path=${audioPath}`);

  const proc = spawn('mlx_whisper', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let lastStderr = '';
  proc.stderr.on('data', d => { lastStderr = d.toString().trim(); });
  // mlx_whisper writes progress to stdout; swallow it
  proc.stdout.resume();

  proc.on('close', code => {
    if (code === 0) {
      try {
        const basename = path.basename(audioPath, path.extname(audioPath));
        const outFile  = path.join(tmpDir, `${basename}.json`);
        const raw      = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        const result   = { text: (raw.text ?? '').trim(), segments: raw.segments ?? [] };
        console.log(`[transcribe] Job ${jobId} complete — ${result.text.length} chars`);
        jobState = { status: 'idle', jobId, jobType: 'transcribe', result, errorMsg: null };
      } catch (err) {
        const msg = `Result parse error: ${err.message}`;
        console.error(`[transcribe] Job ${jobId} ${msg}`);
        jobState = { status: 'error', jobId, jobType: 'transcribe', result: null, errorMsg: msg };
      }
    } else {
      const msg = lastStderr.slice(-500) || `mlx_whisper exited with code ${code}`;
      console.error(`[transcribe] Job ${jobId} failed: ${msg}`);
      jobState = { status: 'error', jobId, jobType: 'transcribe', result: null, errorMsg: msg };
    }
    slotBusy = false;
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  });

  proc.on('error', err => {
    console.error(`[transcribe] Job ${jobId} spawn error: ${err.message}`);
    jobState = { status: 'error', jobId, jobType: 'transcribe', result: null, errorMsg: err.message };
    slotBusy = false;
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // GET /health
  if (method === 'GET' && url === '/health') {
    return respond(res, 200, { nfsMounted: isNfsMounted() });
  }

  // GET /status
  // result is populated when status returns to idle after a transcription job.
  // Iolo reads it on the poll that detects idle, then the next job dispatch clears it.
  if (method === 'GET' && url === '/status') {
    return respond(res, 200, { ...jobState });
  }

  // POST /encode
  if (method === 'POST' && url === '/encode') {
    if (slotBusy) return respond(res, 409, { error: 'Slot busy' });
    try {
      const body = await readBody(req);
      const { jobId, sourcePaths, outputPath, ffmpegArgs } = body;
      if (!jobId || !Array.isArray(sourcePaths) || !outputPath || !Array.isArray(ffmpegArgs)) {
        return respond(res, 400, { error: 'Missing required fields: jobId, sourcePaths, outputPath, ffmpegArgs' });
      }
      runEncode({ jobId, sourcePaths, outputPath, ffmpegArgs });
      return respond(res, 202, { accepted: true, jobId });
    } catch (err) {
      return respond(res, 400, { error: err.message });
    }
  }

  // POST /transcribe
  if (method === 'POST' && url === '/transcribe') {
    if (slotBusy) return respond(res, 409, { error: 'Slot busy' });
    try {
      const body = await readBody(req);
      const { jobId, audioPath, model } = body;
      if (!jobId || !audioPath || !model) {
        return respond(res, 400, { error: 'Missing required fields: jobId, audioPath, model' });
      }
      runTranscribe({ jobId, audioPath, model });
      return respond(res, 202, { accepted: true, jobId });
    } catch (err) {
      return respond(res, 400, { error: err.message });
    }
  }

  respond(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[encoder-service] Listening on port ${PORT}`);
  console.log(`[encoder-service] NFS mount point: ${NFS_MOUNT} — mounted: ${isNfsMounted()}`);
});

server.on('error', err => {
  console.error('[encoder-service] Server error:', err);
  process.exit(1);
});

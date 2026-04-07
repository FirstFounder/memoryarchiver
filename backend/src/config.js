import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = Object.freeze({
  port: Number(process.env.PORT ?? 3000),

  dbPath: process.env.DB_PATH
    ?? path.resolve(__dirname, '../../data/memoryarchiver.db'),

  uploadTempDir: process.env.UPLOAD_TEMP_DIR
    ?? path.resolve(__dirname, '../uploads'),

  nasOutputRoot: process.env.NAS_OUTPUT_ROOT ?? '/volume1/RFA',
  nasScatchRoot: process.env.NAS_SCRATCH_ROOT ?? '/volume1/scratch/Pictures',
  scratchDirs: (process.env.SCRATCH_DIRS ?? 'JNR,MHR,CHR,RAH,GHR')
    .split(',').map(s => s.trim()).filter(Boolean),

  ffmpegPath:  process.env.FFMPEG_PATH  ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  ffmpegThreads: Number(process.env.FFMPEG_THREADS ?? 3),
  niceLevel: Number(process.env.NICE_LEVEL ?? 10),

  // Sync
  syncDestRoot:   process.env.SYNC_DEST_ROOT     ?? '/var/services/homes/noahRFA',
  // rsync --bwlimit is in KB/s (1024-byte units). 625 ≈ 5 Mbps.
  rsyncBwlimit:   Number(process.env.RSYNC_BWLIMIT_KBPS ?? 625),

  // Hub / remote architecture
  deviceRole:      process.env.DEVICE_ROLE ?? 'remote',  // 'remote' | 'hub'
  pushTargets:     (process.env.PUSH_TARGETS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  nfsDestinations: (process.env.NFS_DESTINATIONS ?? '').split(',').map(s => s.trim()).filter(Boolean),

  // Static frontend build output — served by Fastify
  staticRoot: path.resolve(__dirname, '../../frontend/dist'),
});

export default config;

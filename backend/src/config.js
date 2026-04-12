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

  outputUid: Number(process.env.OUTPUT_UID ?? 1026),  // philander's UID
  outputGid: Number(process.env.OUTPUT_GID ?? 100),   // 'users' group GID

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

  // Coop door controller (janus Raspberry Pi)
  // Set in .env: COOP_ENABLED, COOP_JANUS_IP, COOP_SSH_KEY, COOP_ALERT_EMAIL
  coopEnabled:    process.env.COOP_ENABLED === 'true',
  coopJanusIp:    process.env.COOP_JANUS_IP    ?? '192.168.104.7',
  coopSshKey:     process.env.COOP_SSH_KEY      ?? '/root/.ssh/app_coop',
  coopAlertEmail: process.env.COOP_ALERT_EMAIL  ?? 'jeff.rennert@gmail.com',

  // SMTP config for Gmail App Password (nodemailer)
  // Set in .env: SMTP_USER, SMTP_PASS
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',

  // HUB_URL: base URL of the hub node's backend, used by non-hub nodes to
  // fetch camera status. Set on all non-hub nodes.
  // e.g. HUB_URL=http://192.168.21.6:9153
  // On the hub itself this can be empty or set to its own address — unused.
  hubUrl: process.env.HUB_URL ?? '',

  // Camera relay (hub role only)
  // MEDIAMTX_API_PORT: mediamtx management API port (9998 on noah)
  // MEDIAMTX_API_USER: mediamtx API basic auth username
  // MEDIAMTX_API_PASS: mediamtx API basic auth password
  // CAMERA_PATHS: comma-separated mediamtx path names to expose (e.g. live/coopdoor)
  // CAMERA_HLS_BASE: base URL for HLS streams returned to the frontend (e.g. http://192.168.21.6:8888)
  mediamtxApiPort: Number(process.env.MEDIAMTX_API_PORT ?? 9998),
  mediamtxApiUser: process.env.MEDIAMTX_API_USER ?? 'api',
  mediamtxApiPass: process.env.MEDIAMTX_API_PASS ?? '',
  cameraPaths: (process.env.CAMERA_PATHS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  cameraHlsBase: process.env.CAMERA_HLS_BASE ?? '',

  // Static frontend build output — served by Fastify
  staticRoot: path.resolve(__dirname, '../../frontend/dist'),
});

export default config;

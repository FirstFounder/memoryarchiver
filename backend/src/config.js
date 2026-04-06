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

  ffmpegPath:  process.env.FFMPEG_PATH  ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  ffmpegThreads: Number(process.env.FFMPEG_THREADS ?? 3),
  niceLevel: Number(process.env.NICE_LEVEL ?? 10),

  // Static frontend build output — served by Fastify
  staticRoot: path.resolve(__dirname, '../../frontend/dist'),
});

export default config;

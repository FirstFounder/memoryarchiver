import { EventEmitter } from 'events';

// Singleton event bus. The worker emits here; SSE route listens here.
// Safe for single-process PM2 deployment (no cluster mode needed).
//
// Events emitted:
//   'job:update'  payload: { id, status, progress, outputFilename?, errorMsg? }
const emitter = new EventEmitter();
emitter.setMaxListeners(50); // allow up to 50 simultaneous SSE clients

export default emitter;

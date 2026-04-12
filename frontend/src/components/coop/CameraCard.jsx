import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

export function CameraCard({ camera }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  useEffect(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (!camera.live || !camera.hlsUrl || !videoRef.current) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(camera.hlsUrl);
      hls.attachMedia(videoRef.current);
      hlsRef.current = hls;
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      videoRef.current.src = camera.hlsUrl;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [camera.live, camera.hlsUrl]);

  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-slate-100 font-semibold text-base capitalize">{camera.label}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          camera.live
            ? 'bg-green-900/40 text-green-400'
            : 'bg-slate-800 text-slate-500'
        }`}>
          {camera.live ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      {/* Player */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full rounded aspect-video bg-black"
      />

      {/* Readers count — only when live and nonzero */}
      {camera.live && camera.readersCount > 0 && (
        <p className="text-xs text-slate-500">
          {camera.readersCount} viewer{camera.readersCount !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}

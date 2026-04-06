import { useRef } from 'react';

function fmtDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtRes(w, h, fps) {
  if (!w || !h) return '—';
  const label = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : `${h}p`;
  return fps ? `${label}/${fps}fps` : label;
}

/**
 * Ordered list of selected source files.  Supports drag-to-reorder and removal.
 *
 * Props:
 *   files    — array of file metadata objects
 *   onChange — called with the new reordered/filtered array
 */
export function FileList({ files, onChange }) {
  const dragIdx = useRef(null);

  if (!files.length) return null;

  const remove = (idx) => onChange(files.filter((_, i) => i !== idx));

  const onDragStart = (idx) => (e) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (idx) => (e) => {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    const next = [...files];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(idx, 0, moved);
    dragIdx.current = idx;
    onChange(next);
  };

  const onDragEnd = () => { dragIdx.current = null; };

  return (
    <div className="mt-3 rounded-lg border border-slate-700 divide-y divide-slate-700/50">
      {files.map((f, idx) => (
        <div
          key={f.tempPath ?? f.path ?? idx}
          draggable
          onDragStart={onDragStart(idx)}
          onDragOver={onDragOver(idx)}
          onDragEnd={onDragEnd}
          className="flex items-center gap-3 px-3 py-2.5 cursor-grab active:cursor-grabbing hover:bg-slate-700/30 transition-colors"
        >
          <span className="text-slate-500 text-xs w-4 text-center select-none">⠿</span>
          <span className="text-slate-300 text-sm font-mono truncate flex-1" title={f.origName ?? f.path}>
            {f.origName ?? f.path?.split('/').pop()}
          </span>
          <span className="text-slate-500 text-xs shrink-0">
            {fmtRes(f.width, f.height, f.fps)}
          </span>
          <span className="text-slate-500 text-xs shrink-0 w-10 text-right">
            {fmtDuration(f.duration)}
          </span>
          <button
            onClick={() => remove(idx)}
            className="ml-1 text-slate-600 hover:text-red-400 transition-colors text-sm leading-none"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

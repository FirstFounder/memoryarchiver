import { useRef, useState } from 'react';
import { uploadFiles } from '../api/upload.js';

/**
 * Drag-and-drop + click-to-browse upload zone for .MOV files.
 *
 * Props:
 *   onUploaded(metaArray) — called with the array returned by POST /api/upload
 *   disabled              — true while an upload is in progress
 */
export function DropZone({ onUploaded, disabled }) {
  const inputRef  = useRef(null);
  const [dragging, setDragging]   = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError]         = useState(null);

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f =>
      f.name.toLowerCase().endsWith('.mov')
    );
    if (!files.length) {
      setError('Please select .MOV files only.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const meta = await uploadFiles(files);
      onUploaded(meta);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (disabled || uploading) return;
    handleFiles(e.dataTransfer.files);
  };

  const onDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const borderClass = dragging
    ? 'border-indigo-400 bg-indigo-950/30'
    : 'border-slate-600 hover:border-slate-400';

  const isDisabled = disabled || uploading;

  return (
    <div>
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !isDisabled && inputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
          transition-colors duration-150 select-none
          ${borderClass}
          ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        {uploading ? (
          <p className="text-slate-300 text-sm">Uploading and probing files…</p>
        ) : (
          <>
            <p className="text-slate-300 text-sm font-medium">
              Drop .MOV files here
            </p>
            <p className="text-slate-500 text-xs mt-1">or click to browse your Mac</p>
          </>
        )}
      </div>

      {error && (
        <p className="mt-2 text-red-400 text-xs">{error}</p>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".mov,.MOV"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}

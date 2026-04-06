import { useBrowse } from '../hooks/useBrowse.js';

/**
 * In-app browser for the NAS scratch directories.
 *
 * Props:
 *   onSelect(paths: string[]) — called with array of selected NAS subpaths
 *   onClose()                 — called when the user dismisses the browser
 */
export function FileBrowser({ onSelect, onClose }) {
  const {
    currentPath, breadcrumbs, entries, selected,
    loading, error, navigate, toggleSelect, clearSelection,
  } = useBrowse();

  const handleSelect = () => {
    if (selected.size === 0) return;
    onSelect(Array.from(selected));
    clearSelection();
    onClose();
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Breadcrumb bar ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 text-xs text-slate-400 mb-3 flex-wrap">
        <button
          onClick={() => navigate('')}
          className="hover:text-slate-200 transition-colors"
        >
          Scratch
        </button>
        {breadcrumbs.map((crumb, idx) => {
          const subpath = breadcrumbs.slice(0, idx + 1).join('/');
          return (
            <span key={subpath} className="flex items-center gap-1">
              <span className="text-slate-600">/</span>
              <button
                onClick={() => navigate(subpath)}
                className="hover:text-slate-200 transition-colors"
              >
                {crumb}
              </button>
            </span>
          );
        })}
      </div>

      {/* ── Entry list ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 rounded-lg border border-slate-700 divide-y divide-slate-700/50">
        {loading && (
          <div className="p-4 text-slate-500 text-sm text-center">Loading…</div>
        )}
        {error && (
          <div className="p-4 text-red-400 text-sm">{error}</div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="p-4 text-slate-500 text-sm text-center">No .MOV files here.</div>
        )}
        {entries.map(entry => (
          <div
            key={entry.subpath}
            className={`
              flex items-center gap-3 px-3 py-2.5 text-sm
              ${entry.type === 'dir'
                ? 'cursor-pointer hover:bg-slate-700/40'
                : 'cursor-default'}
              ${selected.has(entry.subpath) ? 'bg-indigo-900/30' : ''}
            `}
            onClick={() => {
              if (entry.type === 'dir') navigate(entry.subpath);
            }}
          >
            {entry.type === 'file' && (
              <input
                type="checkbox"
                checked={selected.has(entry.subpath)}
                onChange={() => toggleSelect(entry.subpath)}
                onClick={e => e.stopPropagation()}
                className="accent-indigo-500 w-4 h-4 shrink-0"
              />
            )}
            <span className="text-base leading-none shrink-0">
              {entry.type === 'dir' ? '📁' : '🎞️'}
            </span>
            <span className={`truncate ${entry.type === 'dir' ? 'text-sky-300' : 'text-slate-200'}`}>
              {entry.name}
            </span>
            {entry.type === 'dir' && (
              <span className="ml-auto text-slate-600 text-xs">›</span>
            )}
          </div>
        ))}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-700">
        <span className="text-xs text-slate-500">
          {selected.size > 0 ? `${selected.size} file${selected.size > 1 ? 's' : ''} selected` : 'Select .MOV files above'}
        </span>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-400 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSelect}
            disabled={selected.size === 0}
            className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Use Selected
          </button>
        </div>
      </div>
    </div>
  );
}

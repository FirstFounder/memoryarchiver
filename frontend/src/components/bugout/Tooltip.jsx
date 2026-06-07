import { useState, useEffect, useRef } from 'react';

export function Tooltip({ children, text }) {
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!pinned) return;
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setPinned(false);
      }
    }
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [pinned]);

  if (!text) return children;

  return (
    <span ref={ref} className="relative group/tip inline-flex items-center">
      <span
        onClick={e => { e.stopPropagation(); setPinned(p => !p); }}
        className="cursor-default select-none"
      >
        {children}
      </span>
      <span
        className={`pointer-events-none absolute bottom-full left-0 mb-1.5 z-50 bg-slate-700 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 whitespace-pre-wrap max-w-xs shadow-xl ${
          pinned ? 'block' : 'hidden group-hover/tip:block'
        }`}
      >
        {text}
      </span>
    </span>
  );
}

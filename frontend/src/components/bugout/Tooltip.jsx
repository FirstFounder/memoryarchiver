export function Tooltip({ children, text }) {
  if (!text) return children;
  return (
    <span className="relative group/tip inline-flex items-center">
      {children}
      <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 z-50 hidden group-hover/tip:block bg-slate-700 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 whitespace-pre-wrap max-w-xs shadow-xl">
        {text}
      </span>
    </span>
  );
}

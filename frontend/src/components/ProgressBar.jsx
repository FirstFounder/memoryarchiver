/**
 * Horizontal progress bar.
 * Props:
 *   value  — 0.0 to 1.0
 *   color  — optional Tailwind bg class (default: indigo)
 */
export function ProgressBar({ value = 0, color = 'bg-indigo-500' }) {
  const pct = Math.min(100, Math.max(0, Math.round(value * 100)));
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

import { useEffect, useMemo, useRef } from 'react';

const ITEM_HEIGHT = 72;
const VISIBLE_ROWS = 5;

export function SOCRoller({
  min,
  max,
  value,
  onChange,
  label,
}) {
  const scrollerRef = useRef(null);
  const settleTimerRef = useRef(null);
  const values = useMemo(
    () => Array.from({ length: max - min + 1 }, (_, index) => min + index),
    [min, max],
  );
  const pad = ITEM_HEIGHT * Math.floor(VISIBLE_ROWS / 2);

  useEffect(() => () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  useEffect(() => {
    const container = scrollerRef.current;
    if (!container) return;
    const nextTop = (value - min) * ITEM_HEIGHT;
    if (Math.abs(container.scrollTop - nextTop) > 2) {
      container.scrollTo({ top: nextTop, behavior: 'smooth' });
    }
  }, [min, value]);

  function applySelection(scrollTop) {
    const nextValue = Math.min(max, Math.max(min, Math.round(scrollTop / ITEM_HEIGHT) + min));
    if (nextValue !== value) onChange(nextValue);
  }

  function handleScroll(event) {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    const currentTop = event.currentTarget.scrollTop;
    settleTimerRef.current = setTimeout(() => {
      applySelection(currentTop);
    }, 90);
  }

  function scrollToValue(nextValue) {
    const container = scrollerRef.current;
    if (!container) return;
    container.scrollTo({ top: (nextValue - min) * ITEM_HEIGHT, behavior: 'smooth' });
    onChange(nextValue);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">{label}</p>
        <p className="text-5xl font-semibold leading-none text-slate-100 tabular-nums">{value}%</p>
      </div>

      <div className="relative overflow-hidden rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="pointer-events-none absolute inset-x-4 top-1/2 h-[72px] -translate-y-1/2 rounded-2xl border border-[color:var(--color-accent)]/40 bg-[color:var(--color-accent)]/10" />
        <div
          ref={scrollerRef}
          className="h-[360px] overflow-y-auto overscroll-contain scroll-smooth [scroll-snap-type:y_mandatory] [scrollbar-width:none]"
          onScroll={handleScroll}
          aria-label={label}
        >
          <div style={{ paddingTop: `${pad}px`, paddingBottom: `${pad}px` }}>
            {values.map(item => {
              const selected = item === value;
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => scrollToValue(item)}
                  className={`flex h-[72px] w-full snap-center items-center justify-center text-center transition-all ${
                    selected
                      ? 'text-[3.25rem] font-semibold text-slate-50'
                      : 'text-2xl text-slate-500'
                  }`}
                >
                  <span className={selected ? 'scale-100' : 'scale-90'}>{item}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

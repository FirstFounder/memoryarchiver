import { useCallback, useEffect, useRef, useState } from 'react';
import { getDevices, getSession, getSessions, startSession, stopSession } from '../../api/maeving.js';
import { SOCRoller } from '../tesla/SOCRoller.jsx';

const TOTAL_WH = 2880; // 2 × 1.44 kWh packs

function formatEta(session, summary, liveApower) {
  const whDelivered = summary?.wh_delivered ?? 0;
  const avgWatts = summary?.avg_watts ?? (liveApower > 10 ? liveApower : 250);
  const socStart = session.soc_start_pct ?? 0;
  const socTarget = session.soc_target_pct ?? 100;
  const estimatedSoc = Math.min(socTarget, socStart + (whDelivered / TOTAL_WH) * 100);
  const remainingWh = Math.max(0, (socTarget - estimatedSoc) / 100 * TOTAL_WH);
  if (avgWatts < 10) return null;
  const etaMin = (remainingWh / avgWatts) * 60;
  const h = Math.floor(etaMin / 60);
  const m = Math.round(etaMin % 60);
  if (h === 0) return `~${m} min remaining`;
  if (m === 0) return `~${h} hr remaining`;
  return `~${h} hr ${m} min remaining`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function MaevingPanel() {
  const [devices, setDevices] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [activeSessions, setActiveSessions] = useState({});   // deviceId → session
  const [sessionDetails, setSessionDetails] = useState(null); // details for active session
  const [recentSessions, setRecentSessions] = useState([]);
  const [socStart, setSocStart] = useState(50);
  const [socTarget, setSocTarget] = useState(90);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const detailsIntervalRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [devs, sessions, recent] = await Promise.all([
        getDevices(),
        getSessions({ status: 'active' }),
        getSessions({}),
      ]);
      setDevices(devs);
      setSelectedId(prev => prev ?? devs[0]?.id ?? null);
      const map = {};
      for (const s of sessions) map[s.device_id] = s;
      setActiveSessions(map);
      setRecentSessions(recent.filter(s => s.status !== 'active').slice(0, 5));
    } catch {
      // silent — stale data is fine
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Poll active session details separately for live Wh estimate
  const activeSession = activeSessions[selectedId] ?? null;

  useEffect(() => {
    if (detailsIntervalRef.current) {
      clearInterval(detailsIntervalRef.current);
      detailsIntervalRef.current = null;
    }
    if (!activeSession) {
      setSessionDetails(null);
      return;
    }

    async function fetchDetails() {
      try {
        const d = await getSession(activeSession.id);
        setSessionDetails(d);
      } catch { /* ignore */ }
    }

    fetchDetails();
    detailsIntervalRef.current = setInterval(fetchDetails, 30_000);
    return () => clearInterval(detailsIntervalRef.current);
  }, [activeSession?.id]);

  const selectedDevice = devices.find(d => d.id === selectedId) ?? null;
  const liveState = selectedDevice?.live ?? null;
  const liveApower = liveState?.apower ?? 0;

  async function handleStart() {
    if (!selectedId || starting) return;
    setStarting(true);
    setError('');
    try {
      const session = await startSession({
        device_id: selectedId,
        soc_start_pct: socStart,
        soc_target_pct: socTarget,
      });
      setActiveSessions(prev => ({ ...prev, [selectedId]: session }));
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!activeSession || stopping) return;
    setStopping(true);
    setError('');
    try {
      await stopSession(activeSession.id);
      setActiveSessions(prev => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
      setSessionDetails(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(false);
    }
  }

  const eta = activeSession ? formatEta(activeSession, sessionDetails?.readings_summary, liveApower) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">

      {/* Device selector */}
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-4 sm:p-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Maeving RM1S</p>
        <div className="grid grid-cols-3 gap-3 sm:flex sm:flex-wrap">
          {devices.map(device => {
            const isSelected = device.id === selectedId;
            const live = device.live;
            const isOnline = live?.online === true;
            const watts = live?.apower ?? 0;
            return (
              <button
                key={device.id}
                type="button"
                onClick={() => { setSelectedId(device.id); setError(''); }}
                className={`min-h-16 rounded-2xl border px-5 py-4 text-left transition-colors ${
                  isSelected
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 text-slate-50'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300 hover:border-slate-500'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isOnline ? 'bg-green-400' : 'bg-slate-600'}`} />
                  <span className="font-semibold">{device.site_key}</span>
                </span>
                {isOnline && watts > 10 ? (
                  <span className="mt-0.5 block text-sm text-amber-400">{Math.round(watts)} W</span>
                ) : (
                  <span className="mt-0.5 block text-sm text-slate-500">{device.label}</span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Session panel */}
      {selectedDevice && (
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          {activeSession ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Charging</p>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <p className="text-xs text-slate-500">Started</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">{formatDate(activeSession.started_at)}</p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <p className="text-xs text-slate-500">SOC range</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    {activeSession.soc_start_pct ?? '—'}% → {activeSession.soc_target_pct ?? '—'}%
                  </p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <p className="text-xs text-slate-500">Live power</p>
                  <p className={`mt-1 text-sm font-semibold ${liveApower > 10 ? 'text-amber-400' : 'text-slate-400'}`}>
                    {liveApower > 0 ? `${Math.round(liveApower)} W` : '—'}
                  </p>
                </div>
                <div className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <p className="text-xs text-slate-500">Wh delivered</p>
                  <p className="mt-1 text-sm font-semibold text-slate-200">
                    {sessionDetails?.readings_summary?.wh_delivered != null
                      ? `${Math.round(sessionDetails.readings_summary.wh_delivered)} Wh`
                      : '—'}
                  </p>
                </div>
              </div>

              {eta && (
                <div className="rounded-2xl border border-emerald-700/50 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-300">
                  {eta}
                </div>
              )}

              {error && (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
              )}

              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="min-h-14 rounded-2xl border border-red-700/60 bg-red-900/30 px-6 text-base font-semibold text-red-300 transition-colors hover:bg-red-900/60 disabled:opacity-60"
              >
                {stopping ? 'Cutting power…' : 'Cut Power'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Plug In</p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller min={0} max={100} value={socStart} onChange={setSocStart} label="Current SOC" />
                </div>
                <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] p-4">
                  <SOCRoller min={50} max={100} value={socTarget} onChange={setSocTarget} label="Target SOC" />
                </div>
              </div>

              {error && (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
              )}

              <button
                type="button"
                onClick={handleStart}
                disabled={starting}
                className="min-h-14 rounded-2xl bg-[color:var(--color-accent)] px-6 text-base font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-60"
              >
                {starting ? 'Logging…' : 'Plugged In'}
              </button>
            </div>
          )}
        </section>
      )}

      {/* Recent sessions */}
      {recentSessions.length > 0 && (
        <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Recent Sessions</p>
          <div className="flex flex-col gap-2">
            {recentSessions.map(session => {
              const device = devices.find(d => d.id === session.device_id);
              return (
                <div
                  key={session.id}
                  className="flex items-center justify-between rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3 text-sm"
                >
                  <span className="font-semibold text-slate-300">{device?.site_key ?? '?'}</span>
                  <span className="text-slate-500">{formatDate(session.started_at)}</span>
                  <span className="text-slate-400">
                    {session.wh_delivered != null ? `${Math.round(session.wh_delivered)} Wh` : '—'}
                  </span>
                  <span className="text-slate-500">
                    {session.soc_start_pct ?? '—'}% → {session.soc_target_pct ?? '—'}%
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

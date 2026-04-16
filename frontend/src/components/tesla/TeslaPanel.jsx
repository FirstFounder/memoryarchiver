import { useEffect, useState } from 'react';
import { getVehicles, getVehicleStatus, pollVehicle } from '../../api/tesla.js';
import { useTeslaStore } from '../../store/teslaStore.js';

const MODE_META = {
  connectivity: 'bg-amber-900/50 text-amber-200 border border-amber-700/60',
  active: 'bg-indigo-900/50 text-indigo-200 border border-indigo-700/60',
};

function connectivityLabel(vehicle, status) {
  if (!vehicle.hasCredentials) return 'No credentials';
  if (status?.error) return 'Fleet error';
  if (status?.state) return status.state;
  return 'Offline';
}

function VehicleStatusCard({ vehicle }) {
  const status = useTeslaStore(s => s.vehicleStatus[vehicle.vin]);
  const setVehicleStatus = useTeslaStore(s => s.setVehicleStatus);
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState(null);

  async function handlePoll() {
    if (polling) return;
    setPolling(true);
    try {
      const result = await pollVehicle(vehicle.vin);
      setPollResult(result);
      if (!result.error) {
        setVehicleStatus(vehicle.vin, {
          ...(status ?? {}),
          state: result.state ?? status?.state ?? 'online',
          lastKnown: {
            ...(status?.lastKnown ?? {}),
            battery_level: result.battery_level,
            charge_limit_soc: result.charge_limit_soc,
            charger_pilot_current: result.charger_pilot_current,
          },
        });
      }
    } finally {
      setPolling(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold text-slate-100">{vehicle.nickname}</p>
          <p className="text-xs text-slate-500">{vehicle.vin.slice(-6)}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${MODE_META[vehicle.mode] ?? MODE_META.connectivity}`}>
          {vehicle.mode}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <div>
          <p className="text-slate-500">Connectivity</p>
          <p className="mt-1 text-base capitalize text-slate-100">{connectivityLabel(vehicle, status)}</p>
        </div>
        <button
          type="button"
          onClick={handlePoll}
          disabled={polling}
          className="rounded-lg border border-indigo-800 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:border-indigo-600 hover:bg-indigo-900/30 disabled:opacity-40"
        >
          {polling ? 'Polling…' : 'Poll Now'}
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-slate-700/70 bg-slate-900/50 p-3 text-sm text-slate-300">
        {vehicle.mode === 'connectivity' ? (
          <p>Scheduling disabled — connectivity mode</p>
        ) : (
          <p>No plan computed yet</p>
        )}
      </div>

      {status?.error && (
        <p className="mt-3 rounded-lg bg-red-950/40 p-3 text-xs text-red-300">{status.message}</p>
      )}

      {pollResult && (
        <div className={`mt-3 rounded-lg border p-3 text-sm ${
          pollResult.error
            ? 'border-red-800/70 bg-red-950/40 text-red-300'
            : 'border-slate-700/70 bg-slate-900/60 text-slate-200'
        }`}>
          {pollResult.error ? (
            <p>{pollResult.message}</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Battery</p>
                <p className="mt-1 text-lg font-semibold">{pollResult.battery_level ?? '—'}%</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Limit</p>
                <p className="mt-1 text-lg font-semibold">{pollResult.charge_limit_soc ?? '—'}%</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Pilot</p>
                <p className="mt-1 text-lg font-semibold">{pollResult.charger_pilot_current ?? '—'}A</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TeslaPanel() {
  const vehicles = useTeslaStore(s => s.vehicles);
  const setVehicles = useTeslaStore(s => s.setVehicles);
  const setVehicleStatus = useTeslaStore(s => s.setVehicleStatus);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const rows = await getVehicles();
        if (cancelled) return;
        setVehicles(rows);
        rows.forEach(async (vehicle) => {
          try {
            const status = await getVehicleStatus(vehicle.vin);
            if (!cancelled) setVehicleStatus(vehicle.vin, status);
          } catch (err) {
            if (!cancelled) {
              setVehicleStatus(vehicle.vin, { error: 'fleet_error', message: err.message });
            }
          }
        });
      } catch {
        if (!cancelled) setVehicles([]);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col">
      <div className="mb-4 flex items-center justify-between border-t border-slate-800 pt-4">
        <h2 className="text-sm font-semibold text-slate-200">Tesla Connectivity</h2>
      </div>

      {vehicles.length === 0 && (
        <p className="py-8 text-center text-xs text-slate-600">Loading Tesla vehicles…</p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {vehicles.map(vehicle => (
          <VehicleStatusCard key={vehicle.vin} vehicle={vehicle} />
        ))}
      </div>
    </div>
  );
}

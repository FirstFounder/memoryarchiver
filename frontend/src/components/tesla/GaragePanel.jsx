import { useEffect, useMemo, useRef, useState } from 'react';
import { getMqttState, getVehicles, patchVehicleConfig, setChargeLimit } from '../../api/tesla.js';
import { useTeslaStore } from '../../store/teslaStore.js';

const STALE_MS = 15 * 60 * 1000;

function isMqttDataFresh(updatedAt) {
  if (!updatedAt) return false;
  return (Date.now() - new Date(updatedAt).getTime()) < STALE_MS;
}

function updatedAgo(updatedAt) {
  if (!updatedAt) return null;
  const delta = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
  return `Updated ${delta}m ago`;
}

function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const m = Number(minutes);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function StateBadge({ state }) {
  if (!state) return <span className="text-slate-500">—</span>;
  let cls = 'rounded-full px-2.5 py-0.5 text-xs font-medium capitalize border ';
  if (state === 'online' || state === 'charging') {
    cls += 'bg-green-900/50 text-green-200 border-green-700/60';
  } else if (state === 'asleep' || state === 'offline') {
    cls += 'bg-amber-900/50 text-amber-200 border-amber-700/60';
  } else if (state === 'driving') {
    cls += 'bg-blue-900/50 text-blue-200 border-blue-700/60';
  } else {
    cls += 'bg-slate-800/60 text-slate-300 border-slate-600/60';
  }
  return <span className={cls}>{state}</span>;
}

function LiveStatusSection({ mqttCar, fresh }) {
  const stale = !fresh;

  function val(v, format) {
    if (stale || v == null) return '—';
    return format ? format(v) : v;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">Live Status</p>
        {stale && (
          <span className="rounded-full border border-amber-700/60 bg-amber-900/40 px-2 py-0.5 text-xs text-amber-300">
            MQTT stale
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">State</dt>
          <dd className="mt-1">
            {stale || !mqttCar?.state
              ? <span className="text-slate-500">—</span>
              : <StateBadge state={mqttCar.state} />}
          </dd>
        </div>

        <div>
          <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">SOC</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {val(mqttCar?.battery_level, v => `${v}%`)}
          </dd>
        </div>

        <div>
          <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Charge Limit</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {val(mqttCar?.charge_limit_soc, v => `${v}%`)}
          </dd>
        </div>

        <div>
          <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">HPWC</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {val(mqttCar?.charge_current_request_max, v => `${v}A`)}
          </dd>
        </div>

        {!stale && mqttCar?.plugged_in === true && (
          <>
            <div>
              <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Power</dt>
              <dd className="mt-1 font-medium text-slate-100">
                {mqttCar.charger_power != null ? `${mqttCar.charger_power} kW` : '—'}
              </dd>
            </div>

            {mqttCar.time_to_full_charge != null && mqttCar.time_to_full_charge > 0 && (
              <div>
                <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Time to Full</dt>
                <dd className="mt-1 font-medium text-slate-100">{mqttCar.time_to_full_charge}h</dd>
              </div>
            )}
          </>
        )}

        <div>
          <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Scheduled Start</dt>
          <dd className="mt-1 font-medium text-slate-100">
            {val(mqttCar?.scheduled_charging_start_time, formatMinutes)}
          </dd>
        </div>
      </dl>

      {mqttCar?._updatedAt && (
        <p className="text-xs text-slate-600">{updatedAgo(mqttCar._updatedAt)}</p>
      )}
    </div>
  );
}

function ChargeLimitSection({ vin, initialLimit }) {
  const [sliderValue, setSliderValue] = useState(initialLimit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const committedVin = useRef(vin);

  useEffect(() => {
    committedVin.current = vin;
    setSliderValue(initialLimit);
    setError('');
  }, [vin, initialLimit]);

  async function commitLimit(value) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await setChargeLimit(committedVin.current, value);
    } catch (err) {
      setError(err.message ?? 'Failed to set charge limit');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">Charge Limit</p>
        <span className="text-sm font-semibold text-slate-100">{sliderValue}%</span>
        {saving && (
          <span className="ml-1 h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
        )}
      </div>

      <input
        type="range"
        min={50}
        max={100}
        step={1}
        value={sliderValue}
        onChange={e => setSliderValue(Number(e.target.value))}
        onPointerUp={e => commitLimit(Number(e.currentTarget.value))}
        onKeyUp={e => commitLimit(Number(e.currentTarget.value))}
        className="w-full accent-[color:var(--color-accent)]"
      />

      <div className="flex justify-between text-xs text-slate-600">
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>

      {error && (
        <p className="rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
    </div>
  );
}

function DepartureSection({ vin, initialTime, vehicles, setVehicles }) {
  const [departureTime, setDepartureTime] = useState(initialTime);
  const [saving, setSaving] = useState(false);
  const commitVin = useRef(vin);

  useEffect(() => {
    commitVin.current = vin;
    setDepartureTime(initialTime);
  }, [vin, initialTime]);

  async function handleChange(newTime) {
    setDepartureTime(newTime);
    if (saving) return;
    setSaving(true);
    try {
      const updated = await patchVehicleConfig(commitVin.current, { departure_time: newTime });
      setVehicles(vehicles.map(v => (v.vin === commitVin.current ? { ...v, ...updated } : v)));
    } catch {
      // silent — value already shown in input
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">Departure</p>
        {saving && (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
        )}
      </div>
      <input
        type="time"
        value={departureTime}
        onChange={e => handleChange(e.target.value)}
        className="w-full rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3 text-xl font-semibold text-slate-100 [color-scheme:dark] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
    </div>
  );
}

export function GaragePanel() {
  const vehicles = useTeslaStore(s => s.vehicles);
  const selectedGarageVin = useTeslaStore(s => s.selectedGarageVin);
  const setVehicles = useTeslaStore(s => s.setVehicles);
  const setSelectedGarageVin = useTeslaStore(s => s.setSelectedGarageVin);

  const [mqttData, setMqttData] = useState(null);

  const selectedVehicle = useMemo(
    () => vehicles.find(v => v.vin === selectedGarageVin) ?? vehicles[0] ?? null,
    [vehicles, selectedGarageVin],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadVehicles() {
      try {
        const rows = await getVehicles();
        if (cancelled) return;
        setVehicles(rows);
        if (!selectedGarageVin && rows[0]) {
          setSelectedGarageVin(rows[0].vin);
        }
      } catch {
        if (!cancelled) setVehicles([]);
      }
    }

    loadVehicles();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (selectedVehicle && selectedVehicle.vin !== selectedGarageVin) {
      setSelectedGarageVin(selectedVehicle.vin);
    }
  }, [selectedVehicle, selectedGarageVin, setSelectedGarageVin]);

  useEffect(() => {
    let cancelled = false;

    async function fetchMqtt() {
      try {
        const data = await getMqttState();
        if (!cancelled) setMqttData(data);
      } catch {
        // silent — MQTT may be disabled
      }
    }

    fetchMqtt();
    const interval = setInterval(fetchMqtt, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!vehicles.length) {
    return (
      <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-8 text-center text-slate-400">
        No Tesla vehicles configured yet.
      </div>
    );
  }

  const carId = selectedVehicle?.teslamate_car_id;
  const mqttCar = mqttData && carId != null
    ? (mqttData[carId] ?? mqttData[String(carId)] ?? null)
    : null;
  const mqttFresh = mqttCar ? isMqttDataFresh(mqttCar._updatedAt) : false;

  const initialLimit = Number(
    mqttFresh && mqttCar?.charge_limit_soc != null
      ? mqttCar.charge_limit_soc
      : selectedVehicle?.last_charge_limit_pct ?? 90,
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-4 sm:p-6">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Garage</p>
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
          {vehicles.map(vehicle => {
            const selected = selectedVehicle?.vin === vehicle.vin;
            return (
              <button
                key={vehicle.vin}
                type="button"
                onClick={() => setSelectedGarageVin(vehicle.vin)}
                className={`min-h-16 rounded-2xl border px-5 py-4 text-left transition-colors ${
                  selected
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 text-slate-50'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300 hover:border-slate-500'
                }`}
              >
                <span className="block text-lg font-semibold">{vehicle.display_name ?? vehicle.nickname}</span>
                <span className="mt-0.5 block text-sm font-normal text-slate-500">{vehicle.model_label ?? vehicle.nickname}</span>
              </button>
            );
          })}
        </div>
      </section>

      {selectedVehicle && (
        <section className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <LiveStatusSection mqttCar={mqttCar} fresh={mqttFresh} />
          </div>

          <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <ChargeLimitSection
              vin={selectedVehicle.vin}
              initialLimit={initialLimit}
            />
          </div>

          <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <DepartureSection
              vin={selectedVehicle.vin}
              initialTime={selectedVehicle.departure_time ?? '07:30'}
              vehicles={vehicles}
              setVehicles={setVehicles}
            />
          </div>
        </section>
      )}
    </div>
  );
}

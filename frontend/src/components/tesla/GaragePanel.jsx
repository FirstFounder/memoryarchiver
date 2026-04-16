import { useEffect, useMemo, useState } from 'react';
import { getManualEntry, getVehicles, submitManualEntry } from '../../api/tesla.js';
import { useTeslaStore } from '../../store/teslaStore.js';
import { SOCRoller } from './SOCRoller.jsx';

export function GaragePanel() {
  const vehicles = useTeslaStore(s => s.vehicles);
  const manualEntries = useTeslaStore(s => s.manualEntries);
  const selectedGarageVin = useTeslaStore(s => s.selectedGarageVin);
  const setVehicles = useTeslaStore(s => s.setVehicles);
  const setManualEntry = useTeslaStore(s => s.setManualEntry);
  const setSelectedGarageVin = useTeslaStore(s => s.setSelectedGarageVin);

  const selectedVehicle = useMemo(
    () => vehicles.find(vehicle => vehicle.vin === selectedGarageVin) ?? vehicles[0] ?? null,
    [vehicles, selectedGarageVin],
  );

  const pendingEntry = selectedVehicle ? manualEntries[selectedVehicle.vin] ?? null : null;

  const [socPct, setSocPct] = useState(50);
  const [chargeLimitPct, setChargeLimitPct] = useState(90);
  const [hpwcAmps, setHpwcAmps] = useState(48);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

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
    if (!selectedVehicle) return;

    let cancelled = false;
    setMessage('');

    async function loadManualEntry() {
      try {
        const entry = await getManualEntry(selectedVehicle.vin);
        if (cancelled) return;
        setManualEntry(selectedVehicle.vin, entry);
        setSocPct(entry?.soc_pct ?? 50);
        setChargeLimitPct(entry?.charge_limit_pct ?? selectedVehicle.last_charge_limit_pct ?? 90);
        setHpwcAmps(entry?.hpwc_amps ?? selectedVehicle.last_hpwc_amps ?? 48);
      } catch {
        if (cancelled) return;
        setManualEntry(selectedVehicle.vin, null);
        setSocPct(50);
        setChargeLimitPct(selectedVehicle.last_charge_limit_pct ?? 90);
        setHpwcAmps(selectedVehicle.last_hpwc_amps ?? 48);
      }
    }

    loadManualEntry();
    return () => { cancelled = true; };
  }, [selectedVehicle?.vin]);

  async function handleSubmit() {
    if (!selectedVehicle || saving) return;
    setSaving(true);
    setMessage('');

    try {
      const result = await submitManualEntry(selectedVehicle.vin, { socPct, chargeLimitPct, hpwcAmps });
      setManualEntry(selectedVehicle.vin, result.entry);
      setVehicles(vehicles.map(vehicle => (
        vehicle.vin === selectedVehicle.vin
          ? {
              ...vehicle,
              last_hpwc_amps: hpwcAmps,
              last_charge_limit_pct: chargeLimitPct,
            }
          : vehicle
      )));
      setMessage(`Logged for tonight: SOC ${socPct}%, limit ${chargeLimitPct}%, ${hpwcAmps}A HPWC`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!vehicles.length) {
    return (
      <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-8 text-center text-slate-400">
        No Tesla vehicles configured yet.
      </div>
    );
  }

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
                className={`min-h-16 rounded-2xl border px-5 py-4 text-left text-lg font-semibold transition-colors ${
                  selected
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 text-slate-50'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300 hover:border-slate-500'
                }`}
              >
                <span className="block">{vehicle.nickname}</span>
                <span className="mt-1 block text-sm font-normal text-slate-500">{vehicle.vin.slice(-6)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {selectedVehicle && (
        <section className="grid gap-6 lg:grid-cols-[1fr_1fr_300px]">
          <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <SOCRoller min={1} max={100} value={socPct} onChange={setSocPct} label="Current SOC" />
          </div>

          <div className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <SOCRoller min={50} max={100} value={chargeLimitPct} onChange={setChargeLimitPct} label="Charge Limit" />
          </div>

          <div className="flex flex-col gap-6 rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
            <div>
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">HPWC</p>
              <div className="grid grid-cols-2 gap-3">
                {[48, 80].map(option => {
                  const selected = hpwcAmps === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setHpwcAmps(option)}
                      className={`min-h-20 rounded-2xl border text-2xl font-semibold transition-colors ${
                        selected
                          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-white'
                          : 'border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] text-slate-300'
                      }`}
                    >
                      {option}A
                    </button>
                  );
                })}
              </div>
            </div>

            {pendingEntry && (
              <div className="rounded-2xl border border-emerald-700/50 bg-emerald-900/20 p-4 text-base text-emerald-200">
                Pending entry: SOC {pendingEntry.soc_pct}%, limit {pendingEntry.charge_limit_pct}%, {pendingEntry.hpwc_amps}A HPWC — tap Log Entry to update.
              </div>
            )}

            {message && (
              <div className={`rounded-2xl border p-4 text-base ${
                message.startsWith('Logged for tonight')
                  ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-200'
                  : 'border-red-800/60 bg-red-950/40 text-red-300'
              }`}>
                {message}
              </div>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="mt-auto min-h-16 rounded-2xl bg-[color:var(--color-accent)] px-6 text-xl font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-60"
            >
              {saving ? 'Logging…' : 'Log Entry'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  getCredentialStatus,
  getSettings,
  getVehicles,
  patchSettings,
  patchVehicleConfig,
  saveCredentials,
} from '../../api/tesla.js';
import { useTeslaStore } from '../../store/teslaStore.js';

function CredentialStatus({ status }) {
  let text = 'Checking token…';
  let cls = 'text-slate-400';

  if (status) {
    if (!status.hasCredentials) {
      text = 'No credentials';
      cls = 'text-amber-300';
    } else if (status.tokenValid) {
      text = 'Token valid';
      cls = 'text-emerald-300';
    } else {
      text = 'Token refresh failed';
      cls = 'text-red-300';
    }
  }

  return <p className={`text-sm ${cls}`}>{text}</p>;
}

export function TeslaSettingsModal({ onClose }) {
  const vehicles = useTeslaStore(s => s.vehicles);
  const settings = useTeslaStore(s => s.settings);
  const setVehicles = useTeslaStore(s => s.setVehicles);
  const setSettings = useTeslaStore(s => s.setSettings);
  const [credentialForm, setCredentialForm] = useState({
    clientId: '',
    clientSecret: '',
    refreshToken: '',
  });
  const [credentialStatus, setCredentialStatus] = useState(null);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [message, setMessage] = useState('');

  const [vehicleDrafts, setVehicleDrafts] = useState({});
  const [settingsDraft, setSettingsDraft] = useState({});
  const orderedVehicles = useMemo(() => vehicles.slice().sort((a, b) => a.nickname.localeCompare(b.nickname)), [vehicles]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [status, rows, schedulerSettings] = await Promise.all([getCredentialStatus(), getVehicles(), getSettings()]);
        if (cancelled) return;
        setCredentialStatus(status);
        setVehicles(rows);
        setSettings(schedulerSettings);
      } catch {
        if (!cancelled) setCredentialStatus({ hasCredentials: false, tokenValid: false });
      }
    }

    load();
    return () => { cancelled = true; };
  }, [setSettings, setVehicles]);

  useEffect(() => {
    setVehicleDrafts(Object.fromEntries(orderedVehicles.map(vehicle => [
      vehicle.vin,
      {
        display_name: vehicle.display_name ?? '',
        model_label: vehicle.model_label ?? '',
        departure_time: vehicle.departure_time,
        pack_capacity_kwh: String(vehicle.pack_capacity_kwh ?? ''),
        normal_charge_amps: String(vehicle.normal_charge_amps ?? ''),
        mode: vehicle.mode,
      },
    ])));
  }, [orderedVehicles]);

  useEffect(() => {
    setSettingsDraft({
      variance_threshold_cents: settings?.variance_threshold_cents ?? '',
      burst_pref_threshold_dollars: settings?.burst_pref_threshold_dollars ?? '',
      winter_temp_high_f: settings?.winter_temp_high_f ?? '',
      winter_temp_low_f: settings?.winter_temp_low_f ?? '',
      winter_min_amps_mid: settings?.winter_min_amps_mid ?? '',
      winter_min_amps_cold: settings?.winter_min_amps_cold ?? '',
    });
  }, [settings]);

  async function handleCredentialSave(event) {
    event.preventDefault();
    if (savingCredentials) return;
    setSavingCredentials(true);
    setMessage('');

    try {
      await saveCredentials(credentialForm);
      const nextStatus = await getCredentialStatus();
      setCredentialStatus(nextStatus);
      setMessage('Tesla credentials saved.');
      setCredentialForm({ clientId: '', clientSecret: '', refreshToken: '' });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSavingCredentials(false);
    }
  }

  async function handleVehicleSave(vin) {
    const draft = vehicleDrafts[vin];
    if (!draft) return;

    try {
      const updated = await patchVehicleConfig(vin, {
        display_name: draft.display_name,
        model_label: draft.model_label,
        departure_time: draft.departure_time,
        pack_capacity_kwh: Number(draft.pack_capacity_kwh),
        normal_charge_amps: Number(draft.normal_charge_amps),
        mode: draft.mode,
      });
      setVehicles(vehicles.map(vehicle => vehicle.vin === vin ? updated : vehicle));
      setMessage(`Saved settings for ${updated.nickname}.`);
    } catch (err) {
      setMessage(err.message);
    }
  }

  function updateVehicleDraft(vin, patch) {
    setVehicleDrafts(state => ({
      ...state,
      [vin]: {
        ...(state[vin] ?? {}),
        ...patch,
      },
    }));
  }

  async function handleSettingsBlur(field) {
    const value = settingsDraft[field];
    try {
      const updated = await patchSettings({ [field]: value });
      setSettings(updated);
      setMessage('Scheduler settings saved.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex h-[min(92vh,820px)] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">Tesla Settings</h2>
            <p className="mt-1 text-sm text-slate-400">Fleet credentials and per-vehicle defaults.</p>
          </div>
          <button type="button" onClick={onClose} className="text-3xl leading-none text-slate-500 hover:text-slate-200">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
            <h3 className="text-lg font-semibold text-slate-100">Fleet API Credentials</h3>
            <form className="mt-4 grid gap-4" onSubmit={handleCredentialSave}>
              <label className="grid gap-2 text-sm text-slate-300">
                <span>Client ID</span>
                <input
                  value={credentialForm.clientId}
                  onChange={(event) => setCredentialForm(state => ({ ...state, clientId: event.target.value }))}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                <span>Client Secret</span>
                <input
                  type="password"
                  value={credentialForm.clientSecret}
                  onChange={(event) => setCredentialForm(state => ({ ...state, clientSecret: event.target.value }))}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
              <label className="grid gap-2 text-sm text-slate-300">
                <span>Refresh Token</span>
                <input
                  type="password"
                  value={credentialForm.refreshToken}
                  onChange={(event) => setCredentialForm(state => ({ ...state, refreshToken: event.target.value }))}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CredentialStatus status={credentialStatus} />
                <button
                  type="submit"
                  disabled={savingCredentials}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-60"
                >
                  {savingCredentials ? 'Saving…' : 'Save Credentials'}
                </button>
              </div>
            </form>
          </section>

          <section className="mt-6 grid gap-4">
            {orderedVehicles.map(vehicle => {
              const draft = vehicleDrafts[vehicle.vin] ?? {};
              return (
                <div key={vehicle.vin} className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-100">{vehicle.nickname}</h3>
                      <p className="text-sm text-slate-500">{vehicle.vin}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-3">
                    <label className="grid gap-2 text-sm text-slate-300">
                      <span>Display name</span>
                      <input
                        value={draft.display_name ?? ''}
                        onChange={(event) => updateVehicleDraft(vehicle.vin, { display_name: event.target.value })}
                        className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      <span>Model label</span>
                      <input
                        value={draft.model_label ?? ''}
                        onChange={(event) => updateVehicleDraft(vehicle.vin, { model_label: event.target.value })}
                        className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      <span>Departure time</span>
                      <input
                        type="time"
                        value={draft.departure_time ?? ''}
                        onChange={(event) => updateVehicleDraft(vehicle.vin, { departure_time: event.target.value })}
                        className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      <span>Pack capacity (kWh)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={draft.pack_capacity_kwh ?? ''}
                        onChange={(event) => updateVehicleDraft(vehicle.vin, { pack_capacity_kwh: event.target.value })}
                        className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      <span>Normal charge amps</span>
                      <input
                        type="number"
                        value={draft.normal_charge_amps ?? ''}
                        onChange={(event) => updateVehicleDraft(vehicle.vin, { normal_charge_amps: event.target.value })}
                        className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                      />
                    </label>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {['connectivity', 'active'].map(mode => {
                      const selected = draft.mode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => updateVehicleDraft(vehicle.vin, { mode })}
                          className={`rounded-full border px-4 py-2 text-sm font-medium capitalize transition-colors ${
                            selected
                              ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                              : 'border-slate-700 bg-slate-900 text-slate-400'
                          }`}
                        >
                          {mode}
                        </button>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => handleVehicleSave(vehicle.vin)}
                      className="ml-auto rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:border-indigo-500 hover:text-indigo-200"
                    >
                      Save Vehicle Settings
                    </button>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
            <h3 className="text-lg font-semibold text-slate-100">Scheduler Settings</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {[
                ['variance_threshold_cents', 'Variance threshold (¢)', '0.1'],
                ['burst_pref_threshold_dollars', 'Burst preference threshold ($)', '0.05'],
                ['winter_temp_high_f', 'Winter temp high (°F)', '1'],
                ['winter_temp_low_f', 'Winter temp low (°F)', '1'],
                ['winter_min_amps_mid', 'Winter min amps mid', '1'],
                ['winter_min_amps_cold', 'Winter min amps cold', '1'],
              ].map(([field, label, step]) => (
                <label key={field} className="grid gap-2 text-sm text-slate-300">
                  <span>{label}</span>
                  <input
                    type="number"
                    step={step}
                    value={settingsDraft[field] ?? ''}
                    onChange={(event) => setSettingsDraft(state => ({ ...state, [field]: event.target.value }))}
                    onBlur={() => handleSettingsBlur(field)}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 outline-none focus:border-indigo-500"
                  />
                </label>
              ))}
            </div>
          </section>

          {message && (
            <p className={`mt-6 text-sm ${message.includes('saved') || message.includes('Saved') ? 'text-emerald-300' : 'text-red-300'}`}>
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

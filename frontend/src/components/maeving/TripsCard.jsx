import { useEffect, useState } from 'react';
import { getTrips, createTrip, updateTrip, deleteTrip } from '../../api/maeving.js';

function PencilIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  );
}

function TripForm({ initialDesc = '', initialMiles = '', onSave, onCancel }) {
  const [desc, setDesc] = useState(initialDesc);
  const [miles, setMiles] = useState(initialMiles);

  return (
    <div className="flex flex-wrap gap-2">
      <input
        className="min-w-40 flex-1 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
        placeholder="Description"
        value={desc}
        onChange={e => setDesc(e.target.value)}
      />
      <input
        type="number"
        step="0.1"
        min="0"
        className="w-28 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
        placeholder="Miles"
        value={miles}
        onChange={e => setMiles(e.target.value)}
      />
      <button
        type="button"
        onClick={() => onSave(desc, parseFloat(miles))}
        className="rounded-xl bg-[color:var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[color:var(--color-accent-hover)]"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-xl border border-[color:var(--color-border)] px-4 py-2 text-sm text-slate-400 transition-colors hover:border-slate-500"
      >
        Cancel
      </button>
    </div>
  );
}

export function TripsCard() {
  const [trips, setTrips] = useState([]);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      setTrips(await getTrips());
    } catch { /* silent */ }
  }

  useEffect(() => { load(); }, []);

  async function handleAdd(desc, miles) {
    setError('');
    if (!desc || Number.isNaN(miles)) { setError('Description and distance required.'); return; }
    try {
      await createTrip({ description: desc, distance_miles: miles });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleEdit(tripId, desc, miles) {
    setError('');
    if (!desc || Number.isNaN(miles)) { setError('Description and distance required.'); return; }
    try {
      await updateTrip(tripId, { description: desc, distance_miles: miles });
      setEditId(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(id) {
    setError('');
    try {
      await deleteTrip(id);
      setDeleteConfirmId(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(trip) {
    setEditId(trip.id);
    setAdding(false);
    setDeleteConfirmId(null);
    setError('');
  }

  function startAdd() {
    setAdding(true);
    setEditId(null);
    setDeleteConfirmId(null);
    setError('');
  }

  function truncate(str, n = 30) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Trips</p>
          <button
            type="button"
            onClick={startAdd}
            className="rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-500"
          >
            + Add Trip
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {adding && (
          <div className="mb-3">
            <TripForm
              onSave={handleAdd}
              onCancel={() => { setAdding(false); setError(''); }}
            />
          </div>
        )}

        {trips.length === 0 && !adding && (
          <p className="text-sm text-slate-500">No trips yet.</p>
        )}

        <div className="flex flex-col gap-2">
          {trips.map(trip => {
            if (editId === trip.id) {
              return (
                <div
                  key={trip.id}
                  className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3"
                >
                  <TripForm
                    initialDesc={trip.description}
                    initialMiles={String(trip.distance_miles)}
                    onSave={(desc, miles) => handleEdit(trip.id, desc, miles)}
                    onCancel={() => { setEditId(null); setError(''); }}
                  />
                </div>
              );
            }

            if (deleteConfirmId === trip.id) {
              return (
                <div
                  key={trip.id}
                  className="flex items-center gap-3 rounded-2xl border border-red-800/40 bg-red-950/20 px-4 py-3 text-sm"
                >
                  <span className="flex-1 text-slate-300">
                    Delete &ldquo;{truncate(trip.description)}&rdquo;?
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(trip.id)}
                    className="font-semibold text-red-400 hover:text-red-300"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(null)}
                    className="text-slate-500 hover:text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              );
            }

            return (
              <div
                key={trip.id}
                className="flex items-center justify-between rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3"
              >
                <span className="flex-1 text-sm text-slate-300">{trip.description}</span>
                <span className="mr-4 text-sm text-slate-500">{trip.distance_miles} mi</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(trip)}
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-[color:var(--color-surface-1)] hover:text-slate-200"
                    title="Edit"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDeleteConfirmId(trip.id); setEditId(null); setError(''); }}
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-950/40 hover:text-red-300"
                    title="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { getLegs, createLeg, updateLeg, deleteLeg, toggleLegHidden } from '../../api/maeving.js';

const PAGE_SIZE = 10;

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

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
      <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
    </svg>
  );
}

function EyeSlashIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clipRule="evenodd" />
      <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.064 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
    </svg>
  );
}

function LegForm({ initialDesc = '', initialMiles = '', onSave, onCancel }) {
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

export function LegsCard() {
  const [legs, setLegs] = useState([]);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  async function load() {
    try {
      setLegs(await getLegs());
      setPage(0);
    } catch { /* silent */ }
  }

  useEffect(() => { load(); }, []);

  async function handleAdd(desc, miles) {
    setError('');
    if (!desc || Number.isNaN(miles)) { setError('Description and distance required.'); return; }
    try {
      await createLeg({ description: desc, distance_miles: miles });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleEdit(legId, desc, miles) {
    setError('');
    if (!desc || Number.isNaN(miles)) { setError('Description and distance required.'); return; }
    try {
      await updateLeg(legId, { description: desc, distance_miles: miles });
      setEditId(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(id) {
    setError('');
    try {
      await deleteLeg(id);
      setDeleteConfirmId(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit(leg) {
    setEditId(leg.id);
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

  async function handleToggleHidden(id, hidden) {
    setError('');
    try {
      await toggleLegHidden(id, hidden);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function truncate(str, n = 30) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  const totalPages = Math.ceil(legs.length / PAGE_SIZE);
  const visibleLegs = legs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <section className="rounded-[2rem] border border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">Legs</p>
          <button
            type="button"
            onClick={startAdd}
            className="rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-500"
          >
            + Add Leg
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {adding && (
          <div className="mb-3">
            <LegForm
              onSave={handleAdd}
              onCancel={() => { setAdding(false); setError(''); }}
            />
          </div>
        )}

        {legs.length === 0 && !adding && (
          <p className="text-sm text-slate-500">No legs yet.</p>
        )}

        <div className="flex flex-col gap-2">
          {visibleLegs.map(leg => {
            if (editId === leg.id) {
              return (
                <div
                  key={leg.id}
                  className="rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3"
                >
                  <LegForm
                    initialDesc={leg.description}
                    initialMiles={String(leg.distance_miles)}
                    onSave={(desc, miles) => handleEdit(leg.id, desc, miles)}
                    onCancel={() => { setEditId(null); setError(''); }}
                  />
                </div>
              );
            }

            if (deleteConfirmId === leg.id) {
              return (
                <div
                  key={leg.id}
                  className="flex items-center gap-3 rounded-2xl border border-red-800/40 bg-red-950/20 px-4 py-3 text-sm"
                >
                  <span className="flex-1 text-slate-300">
                    Delete &ldquo;{truncate(leg.description)}&rdquo;?
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(leg.id)}
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
                key={leg.id}
                className="flex items-center justify-between rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface-0)] px-4 py-3"
              >
                <span className={`flex-1 text-sm text-slate-300${leg.hidden ? ' opacity-40 italic' : ''}`}>
                  {leg.description}
                </span>
                <span className="mr-4 text-sm text-slate-500">{leg.distance_miles} mi</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(leg)}
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-[color:var(--color-surface-1)] hover:text-slate-200"
                    title="Edit"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleHidden(leg.id, leg.hidden ? 0 : 1)}
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-[color:var(--color-surface-1)] hover:text-slate-200"
                    title={leg.hidden ? 'Unhide' : 'Hide'}
                  >
                    {leg.hidden ? <EyeSlashIcon /> : <EyeIcon />}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDeleteConfirmId(leg.id); setEditId(null); setError(''); }}
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

        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 transition-colors hover:border-slate-500 disabled:opacity-40"
            >
              Previous
            </button>
            <span>{page + 1} / {totalPages}</span>
            <button
              type="button"
              disabled={page === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-xl border border-[color:var(--color-border)] px-3 py-1.5 transition-colors hover:border-slate-500 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

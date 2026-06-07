import { useState } from 'react';

export function DoCard({ activities, checklist, onCheckActivity, onUncheckActivity, overnightMode, onToggleOvernight }) {
  const [selected, setSelected] = useState('');

  const checkedIds = new Set(
    checklist.filter(r => r.entity_type === 'activity').map(r => r.entity_id),
  );
  const checklistActivities = checklist
    .filter(r => r.entity_type === 'activity')
    .map(r => {
      const activity = activities.find(a => a.id === r.entity_id);
      return activity ? { ...activity, cl: r } : null;
    })
    .filter(Boolean);

  const availableActivities = activities.filter(a => {
    if (a.is_hidden) return false;
    if (checkedIds.has(a.id)) return false;
    if (overnightMode) return a.is_overnight === 1;
    return true;
  });

  function handleSelect(e) {
    const id = Number(e.target.value);
    if (!id) return;
    const activity = activities.find(a => a.id === id);
    if (activity) onCheckActivity(activity);
    setSelected('');
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-slate-100 font-semibold">Stuff I Want to Do</h3>
        <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={overnightMode}
            onChange={e => onToggleOvernight(e.target.checked)}
            className="accent-indigo-500"
          />
          Overnight trip
        </label>
      </div>

      <select
        value={selected}
        onChange={handleSelect}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 mb-3 text-sm"
      >
        <option value="">— add activity to list —</option>
        {availableActivities.map(a => (
          <option key={a.id} value={a.id}>
            {a.name}{a.is_overnight === 1 ? ' 🌙' : ''}
          </option>
        ))}
      </select>

      {checklistActivities.length === 0 ? (
        <p className="text-slate-500 text-sm">No activities on list yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {checklistActivities.map(({ id, name, is_overnight, cl }) => (
            <li key={id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cl.is_checked === 1}
                onChange={() => onUncheckActivity({ id, name })}
                className="accent-indigo-500 w-4 h-4 shrink-0"
              />
              <span className={cl.is_checked === 1 ? 'line-through text-slate-500 text-sm' : 'text-slate-100 text-sm'}>
                {name}
              </span>
              {is_overnight === 1 && (
                <span className="text-xs">🌙</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

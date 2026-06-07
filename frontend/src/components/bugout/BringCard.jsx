import { useState } from 'react';

export function BringCard({ items, checklist, onCheckItem, onUncheckItem }) {
  const [selected, setSelected] = useState('');

  const checkedIds = new Set(
    checklist.filter(r => r.entity_type === 'item').map(r => r.entity_id),
  );
  const checklistItems = checklist
    .filter(r => r.entity_type === 'item')
    .map(r => {
      const item = items.find(i => i.id === r.entity_id);
      return item ? { ...item, cl: r } : null;
    })
    .filter(Boolean);

  const availableItems = items.filter(i => !i.is_hidden && !checkedIds.has(i.id));

  function handleSelect(e) {
    const id = Number(e.target.value);
    if (!id) return;
    const item = items.find(i => i.id === id);
    if (item) onCheckItem(item, 'manual');
    setSelected('');
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4">
      <h3 className="text-slate-100 font-semibold mb-3">Stuff I Need to Bring</h3>

      <select
        value={selected}
        onChange={handleSelect}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 mb-3 text-sm"
      >
        <option value="">— add item to list —</option>
        {availableItems.map(item => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>

      {checklistItems.length === 0 ? (
        <p className="text-slate-500 text-sm">No items on list yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {checklistItems.map(({ id, name, cl }) => (
            <li key={id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cl.is_checked === 1}
                onChange={() => onUncheckItem({ id, name }, cl)}
                className="accent-indigo-500 w-4 h-4 shrink-0"
              />
              <span className={cl.is_checked === 1 ? 'line-through text-slate-500 text-sm' : 'text-slate-100 text-sm'}>
                {name}
              </span>
              {cl.source === 'auto' && (
                <span className="text-xs bg-slate-700 text-slate-400 rounded px-1 py-0.5 ml-1">auto</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

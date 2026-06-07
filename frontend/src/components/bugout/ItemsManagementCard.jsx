import { useState } from 'react';
import { Tooltip } from './Tooltip.jsx';

function ItemForm({ initial, onSubmit, onCancel, submitLabel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [tags, setTags] = useState(initial?.tags ?? '');
  const [isOvernight, setIsOvernight] = useState(initial?.is_overnight === 1);

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({ name, description, tags, is_overnight: isOvernight });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <input
        type="text"
        placeholder="Item Name *"
        value={name}
        onChange={e => setName(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-sm"
        required
      />
      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={e => setDescription(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-sm"
      />
      <input
        type="text"
        placeholder="tag1, tag2"
        value={tags}
        onChange={e => setTags(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-sm"
      />
      <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={isOvernight}
          onChange={e => setIsOvernight(e.target.checked)}
          className="accent-indigo-500"
        />
        Overnight-mandatory
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!name.trim()}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-3 py-1.5 text-sm"
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="border border-slate-600 text-slate-300 hover:text-slate-100 rounded-lg px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function ItemsManagementCard({ items, onAdd, onUpdate, onToggleHidden, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [addKey, setAddKey] = useState(0);

  return (
    <div className="bg-slate-800/40 border border-slate-700 rounded-xl">
      <button
        onClick={() => setExpanded(e => !e)}
        className="cursor-pointer flex items-center justify-between w-full text-slate-300 font-semibold px-4 py-3"
      >
        <span>Items</span>
        <span>{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-4">
          <ItemForm
            key={addKey}
            onSubmit={body => { onAdd(body); setAddKey(k => k + 1); }}
            submitLabel="Add Item"
          />

          {items.length > 0 && (
            <ul className="flex flex-col gap-2 border-t border-slate-700 pt-3">
              {items.map(item => (
                <li key={item.id} className={`flex flex-col gap-1 ${item.is_hidden ? 'opacity-50' : ''}`}>
                  {editingId === item.id ? (
                    <ItemForm
                      initial={item}
                      onSubmit={body => { onUpdate(item.id, body); setEditingId(null); }}
                      onCancel={() => setEditingId(null)}
                      submitLabel="Save"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <Tooltip text={item.description}>
                          <span className={`font-medium text-sm ${item.is_hidden ? 'italic text-slate-500' : 'text-slate-100'}`}>
                            {item.name}
                          </span>
                        </Tooltip>
                        {item.is_overnight === 1 && (
                          <span className="ml-1 text-xs text-slate-400">🌙</span>
                        )}
                        {item.tags && (
                          <span className="ml-2 text-xs text-slate-500">{item.tags}</span>
                        )}
                      </div>
                      <button
                        onClick={() => setEditingId(item.id)}
                        className="border border-slate-600 text-slate-300 hover:text-slate-100 rounded-lg px-2 py-1 text-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onToggleHidden(item.id, !item.is_hidden)}
                        className="border border-slate-600 text-slate-300 hover:text-slate-100 rounded-lg px-2 py-1 text-xs"
                      >
                        {item.is_hidden ? 'Show' : 'Hide'}
                      </button>
                      <button
                        onClick={() => onDelete(item.id)}
                        className="border border-red-800 text-red-400 hover:text-red-200 rounded-lg px-2 py-1 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

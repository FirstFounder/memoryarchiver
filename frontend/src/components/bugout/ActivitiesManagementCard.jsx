import { useState } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { ALL_PROFILES, PROFILE_LABELS, PROFILE_COLORS } from './bugoutProfiles.js';

function ActivityForm({ initial, currentProfile, onSubmit, onCancel, submitLabel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [tags, setTags] = useState(initial?.tags ?? '');
  const [isOvernight, setIsOvernight] = useState(initial?.is_overnight === 1);
  const [sharedWith, setSharedWith] = useState(() => new Set(initial?.shared_with ?? []));

  const isNative = !initial?.origin_profile;
  const otherProfiles = ALL_PROFILES.filter(p => p !== currentProfile);

  function toggleShare(profile) {
    setSharedWith(prev => {
      const next = new Set(prev);
      next.has(profile) ? next.delete(profile) : next.add(profile);
      return next;
    });
  }

  function handleSubmit(e) {
    e.preventDefault();
    const body = { name, description, tags, is_overnight: isOvernight };
    if (initial && isNative) body.shared_with = [...sharedWith];
    onSubmit(body);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <input
        type="text"
        placeholder="Activity Name *"
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
        Overnight activity
      </label>

      {initial && isNative && (
        <div className="border-t border-slate-700 pt-2 mt-1">
          <p className="text-xs text-slate-400 mb-1.5">Share with:</p>
          <div className="flex flex-wrap gap-3">
            {otherProfiles.map(p => {
              const color = PROFILE_COLORS[p];
              return (
                <label key={p} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sharedWith.has(p)}
                    onChange={() => toggleShare(p)}
                    className="accent-indigo-500"
                  />
                  <span style={{ color: color.text }}>{PROFILE_LABELS[p]}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

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

export function ActivitiesManagementCard({ activities, currentProfile, onAdd, onUpdate, onToggleHidden, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [addKey, setAddKey] = useState(0);

  return (
    <div className="bg-slate-800/40 border border-slate-700 rounded-xl">
      <button
        onClick={() => setExpanded(e => !e)}
        className="cursor-pointer flex items-center justify-between w-full text-slate-300 font-semibold px-4 py-3"
      >
        <span>Activities</span>
        <span>{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-4">
          <ActivityForm
            key={addKey}
            currentProfile={currentProfile}
            onSubmit={body => { onAdd(body); setAddKey(k => k + 1); }}
            submitLabel="Add Activity"
          />

          {activities.length > 0 && (
            <ul className="flex flex-col gap-2 border-t border-slate-700 pt-3">
              {activities.map(activity => {
                const originColor = activity.origin_profile ? PROFILE_COLORS[activity.origin_profile] : null;
                return (
                  <li
                    key={activity.id}
                    className={`flex flex-col gap-1 rounded ${activity.is_hidden ? 'opacity-50' : ''}`}
                    style={originColor ? {
                      borderLeft: `3px solid ${originColor.border}`,
                      paddingLeft: '8px',
                      background: originColor.bg,
                    } : {}}
                  >
                    {editingId === activity.id ? (
                      <ActivityForm
                        initial={activity}
                        currentProfile={currentProfile}
                        onSubmit={body => { onUpdate(activity.id, body); setEditingId(null); }}
                        onCancel={() => setEditingId(null)}
                        submitLabel="Save"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <Tooltip text={activity.description}>
                            <span className={`font-medium text-sm ${activity.is_hidden ? 'italic text-slate-500' : 'text-slate-100'}`}>
                              {activity.name}
                            </span>
                          </Tooltip>
                          {activity.is_overnight === 1 && (
                            <span className="ml-1 text-xs">🌙</span>
                          )}
                          {activity.tags && (
                            <span className="ml-2 text-xs text-slate-500">{activity.tags}</span>
                          )}
                          {originColor && (
                            <span className="ml-2 text-xs rounded px-1 py-0.5" style={{ color: originColor.text, background: originColor.bg }}>
                              {PROFILE_LABELS[activity.origin_profile]}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => setEditingId(activity.id)}
                          className="border border-slate-600 text-slate-300 hover:text-slate-100 rounded-lg px-2 py-1 text-xs"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => onToggleHidden(activity.id, !activity.is_hidden)}
                          className="border border-slate-600 text-slate-300 hover:text-slate-100 rounded-lg px-2 py-1 text-xs"
                        >
                          {activity.is_hidden ? 'Show' : 'Hide'}
                        </button>
                        <button
                          onClick={() => onDelete(activity.id)}
                          className="border border-red-800 text-red-400 hover:text-red-200 rounded-lg px-2 py-1 text-xs"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

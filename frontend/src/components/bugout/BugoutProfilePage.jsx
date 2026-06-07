import { useState, useEffect, useCallback } from 'react';
import {
  getItems, createItem, updateItem,
  getActivities, createActivity, updateActivity,
  getChecklist, upsertChecklist, deleteChecklistEntry, deleteAutoChecklistForActivity,
} from '../../api/bugout.js';
import { BringCard } from './BringCard.jsx';
import { DoCard } from './DoCard.jsx';
import { ItemsManagementCard } from './ItemsManagementCard.jsx';
import { ActivitiesManagementCard } from './ActivitiesManagementCard.jsx';

function getTagSet(tagsString) {
  return new Set((tagsString || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
}

function tagsIntersect(tagsA, tagsB) {
  const setA = getTagSet(tagsA);
  const setB = getTagSet(tagsB);
  return [...setA].some(t => setB.has(t));
}

export function BugoutProfilePage({ profile }) {
  const [items, setItems] = useState([]);
  const [activities, setActivities] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [overnightMode, setOvernightMode] = useState(() => {
    try { return localStorage.getItem(`bugout_overnight_${profile}`) === 'true'; } catch { return false; }
  });

  const reloadAll = useCallback(async () => {
    const [i, a, c] = await Promise.all([getItems(profile), getActivities(profile), getChecklist(profile)]);
    setItems(i);
    setActivities(a);
    setChecklist(c);
  }, [profile]);

  useEffect(() => { reloadAll(); }, [reloadAll]);

  function handleToggleOvernight(val) {
    setOvernightMode(val);
    try { localStorage.setItem(`bugout_overnight_${profile}`, String(val)); } catch {}
  }

  async function handleCheckItem(item, source) {
    await upsertChecklist(profile, { entity_type: 'item', entity_id: item.id, is_checked: 0, source });
    const c = await getChecklist(profile);
    setChecklist(c);
  }

  async function handleUncheckItem(item, cl) {
    if (cl.is_checked === 0) {
      await deleteChecklistEntry(profile, 'item', item.id);
    } else {
      await upsertChecklist(profile, { entity_type: 'item', entity_id: item.id, is_checked: cl.is_checked === 1 ? 0 : 1, source: cl.source, auto_from_activity_id: cl.auto_from_activity_id });
    }
    const c = await getChecklist(profile);
    setChecklist(c);
  }

  async function handleCheckActivity(activity) {
    await upsertChecklist(profile, { entity_type: 'activity', entity_id: activity.id, is_checked: 0, source: 'manual' });

    // Auto-populate items by tag match and overnight
    const currentChecklist = await getChecklist(profile);
    const checkedItemIds = new Set(currentChecklist.filter(r => r.entity_type === 'item').map(r => r.entity_id));
    const candidates = items.filter(item => {
      if (item.is_hidden) return false;
      if (checkedItemIds.has(item.id)) return false;
      return true;
    });

    const toAdd = [];
    const seen = new Set();
    for (const item of candidates) {
      if (tagsIntersect(item.tags, activity.tags) && !seen.has(item.id)) {
        toAdd.push(item);
        seen.add(item.id);
      }
    }
    if (activity.is_overnight === 1) {
      for (const item of candidates) {
        if (item.is_overnight === 1 && !seen.has(item.id)) {
          toAdd.push(item);
          seen.add(item.id);
        }
      }
    }

    for (const item of toAdd) {
      await upsertChecklist(profile, {
        entity_type: 'item',
        entity_id: item.id,
        is_checked: 0,
        source: 'auto',
        auto_from_activity_id: activity.id,
      });
    }

    const c = await getChecklist(profile);
    setChecklist(c);
  }

  async function handleUncheckActivity(activity) {
    await deleteAutoChecklistForActivity(profile, activity.id);
    await deleteChecklistEntry(profile, 'activity', activity.id);
    const c = await getChecklist(profile);
    setChecklist(c);
  }

  async function handleAddItem(body) {
    await createItem(profile, body);
    await reloadAll();
  }

  async function handleUpdateItem(id, body) {
    await updateItem(profile, id, body);
    await reloadAll();
  }

  async function handleToggleItemHidden(id, hidden) {
    await updateItem(profile, id, { is_hidden: hidden ? 1 : 0 });
    await reloadAll();
  }

  async function handleAddActivity(body) {
    await createActivity(profile, body);
    await reloadAll();
  }

  async function handleUpdateActivity(id, body) {
    await updateActivity(profile, id, body);
    await reloadAll();
  }

  async function handleToggleActivityHidden(id, hidden) {
    await updateActivity(profile, id, { is_hidden: hidden ? 1 : 0 });
    await reloadAll();
  }

  return (
    <div className="flex flex-col gap-4">
      <BringCard
        items={items}
        checklist={checklist}
        onCheckItem={handleCheckItem}
        onUncheckItem={handleUncheckItem}
      />

      <ItemsManagementCard
        items={items}
        onAdd={handleAddItem}
        onUpdate={handleUpdateItem}
        onToggleHidden={handleToggleItemHidden}
      />

      <DoCard
        activities={activities}
        checklist={checklist}
        onCheckActivity={handleCheckActivity}
        onUncheckActivity={handleUncheckActivity}
        overnightMode={overnightMode}
        onToggleOvernight={handleToggleOvernight}
      />

      <ActivitiesManagementCard
        activities={activities}
        onAdd={handleAddActivity}
        onUpdate={handleUpdateActivity}
        onToggleHidden={handleToggleActivityHidden}
      />
    </div>
  );
}

import { useEffect } from 'react';
import { getCoopStatus, getLastCoopCheck } from '../../api/coop.js';
import { useCoopStore } from '../../store/coopStore.js';
import { DoorCard } from './DoorCard.jsx';
import { SchedulerCard } from './SchedulerCard.jsx';

export function CoopPanel() {
  const applyStatus = useCoopStore(s => s.applyStatus);
  const setLastCheck = useCoopStore(s => s.setLastCheck);

  useEffect(() => {
    getCoopStatus().then(applyStatus).catch(() => applyStatus({ error: 'unreachable' }));
    getLastCoopCheck().then(setLastCheck).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <DoorCard />
      <SchedulerCard />
    </div>
  );
}

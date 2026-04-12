import { useEffect, useRef, useState } from 'react';
import { getCoopStatus, getLastCoopCheck } from '../../api/coop.js';
import { useCoopStore } from '../../store/coopStore.js';
import { DoorCard } from './DoorCard.jsx';
import { SchedulerCard } from './SchedulerCard.jsx';
import { CameraCard } from './CameraCard.jsx';

function CameraSection() {
  const [cameras, setCameras] = useState([]);
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch('/api/hub/cameras');
        if (!cancelled && res.ok) setCameras(await res.json());
      } catch { /* mediamtx offline — leave last state */ }
    }

    poll();

    const id = setInterval(() => {
      const anyOffline = camerasRef.current.some(c => !c.live);
      if (anyOffline) poll();
    }, 15000);

    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!cameras.length) return null;

  return (
    <section className="mt-6 w-full">
      <h2 className="text-slate-200 font-semibold text-sm mb-3">Cameras</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {cameras.map(cam => (
          <CameraCard key={cam.name} camera={cam} />
        ))}
      </div>
    </section>
  );
}

export function CoopPanel() {
  const applyStatus = useCoopStore(s => s.applyStatus);
  const setLastCheck = useCoopStore(s => s.setLastCheck);

  useEffect(() => {
    getCoopStatus().then(applyStatus).catch(() => applyStatus({ error: 'unreachable' }));
    getLastCoopCheck().then(setLastCheck).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col lg:flex-row gap-4">
        <DoorCard />
        <SchedulerCard />
      </div>
      <CameraSection />
    </div>
  );
}

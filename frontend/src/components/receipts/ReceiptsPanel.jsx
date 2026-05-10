import { useEffect, useCallback } from 'react';
import { useReceiptsStore } from '../../store/receiptsStore.js';
import { getReceipts } from '../../api/receipts.js';
import { UploadCard } from './UploadCard.jsx';
import { RecentImportsTable } from './RecentImportsTable.jsx';

export function ReceiptsPanel() {
  const { loaded, setReceipts } = useReceiptsStore();

  const refresh = useCallback(() => {
    getReceipts()
      .then(setReceipts)
      .catch(err => console.error('[ReceiptsPanel] load:', err));
  }, [setReceipts]);

  useEffect(() => {
    if (!loaded) refresh();
  }, [loaded, refresh]);

  return (
    <div className="flex flex-col gap-6">
      <UploadCard onImported={refresh} />
      <RecentImportsTable />
    </div>
  );
}

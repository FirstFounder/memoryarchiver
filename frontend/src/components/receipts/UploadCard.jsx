import { useState, useEffect, useRef } from 'react';
import { getVendors, uploadReceipt } from '../../api/receipts.js';

function importSummary(result) {
  const { receipts } = result;
  if (!receipts?.length) return 'Imported.';
  const totalItems    = receipts.reduce((s, r) => s + (r.itemCount ?? 0), 0);
  const totalNewTypes = receipts.reduce((s, r) => s + (r.newItemTypes ?? 0), 0);
  if (receipts.length === 1) {
    return `Receipt imported · ${totalItems} items · ${totalNewTypes} new item type${totalNewTypes !== 1 ? 's' : ''}`;
  }
  return `${receipts.length} receipts imported · ${totalItems} items total · ${totalNewTypes} new item type${totalNewTypes !== 1 ? 's' : ''}`;
}

export function UploadCard({ onImported }) {
  const fileInputRef = useRef(null);

  const [vendors,   setVendors]   = useState([]);
  const [vendorKey, setVendorKey] = useState('');
  const [file,      setFile]      = useState(null);
  const [uploading, setUploading] = useState(false);
  const [success,   setSuccess]   = useState(null);
  const [duplicate, setDuplicate] = useState(false);
  const [error,     setError]     = useState(null);

  useEffect(() => {
    getVendors()
      .then(rows => {
        setVendors(rows);
        if (rows.length > 0) setVendorKey(rows[0].key);
      })
      .catch(err => console.error('[UploadCard] vendors:', err));
  }, []);

  function reset() {
    setFile(null);
    setSuccess(null);
    setDuplicate(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleFileChange(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setSuccess(null);
    setDuplicate(false);
    setError(null);
  }

  async function doUpload(force = false) {
    if (!file || !vendorKey) return;
    setUploading(true);
    setError(null);
    setDuplicate(false);
    try {
      const result = await uploadReceipt(file, vendorKey, force);
      setSuccess(result);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onImported?.();
    } catch (err) {
      if (err.status === 409) {
        setDuplicate(true);
      } else {
        setError(err.message);
      }
    } finally {
      setUploading(false);
    }
  }

  const canUpload = !!file && !!vendorKey && !uploading;

  return (
    <div className="rounded-xl border border-slate-800 p-4 flex flex-col gap-3 bg-slate-900/40">
      <h2 className="text-slate-200 font-semibold text-sm">Import Receipt</h2>

      <div className="flex flex-wrap items-end gap-3">
        {/* Vendor selector */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Vendor</label>
          <select
            value={vendorKey}
            onChange={e => setVendorKey(e.target.value)}
            className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          >
            {vendors.map(v => (
              <option key={v.key} value={v.key}>{v.name}</option>
            ))}
          </select>
        </div>

        {/* File picker */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500 flex items-center gap-1">
            PDF file
            <span
              className="text-slate-600 cursor-help"
              title="HEIC not yet supported"
            >
              ⓘ
            </span>
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors"
            >
              {file ? file.name : 'Choose PDF…'}
            </button>
            {file && (
              <button
                onClick={reset}
                className="text-slate-500 hover:text-slate-300 text-sm transition-colors"
                title="Clear"
              >
                ✕
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Upload button */}
        <button
          onClick={() => doUpload(false)}
          disabled={!canUpload}
          className="px-4 py-1.5 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
        >
          {uploading ? 'Importing…' : 'Import'}
        </button>
      </div>

      {/* Duplicate warning */}
      {duplicate && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
          <span>This receipt may already exist (same date/total/count). Import anyway?</span>
          <button
            onClick={() => doUpload(true)}
            disabled={uploading}
            className="shrink-0 px-3 py-1 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs transition-colors"
          >
            {uploading ? '…' : 'Import anyway'}
          </button>
          <button
            onClick={reset}
            className="shrink-0 text-amber-500 hover:text-amber-300 text-xs transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-red-400 text-sm">{error}</p>
      )}

      {/* Success */}
      {success && (
        <p className="text-green-400 text-sm">{importSummary(success)}</p>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { browseDir } from '../api/browse.js';

/**
 * Manages navigation state for the NAS file browser.
 *
 * @returns {{
 *   currentPath: string,
 *   breadcrumbs: string[],
 *   entries: object[],
 *   selected: Set<string>,         // set of subpath strings
 *   loading: boolean,
 *   error: string|null,
 *   navigate: (subpath: string) => void,
 *   toggleSelect: (subpath: string) => void,
 *   clearSelection: () => void,
 * }}
 */
export function useBrowse() {
  const [currentPath, setCurrentPath] = useState('');
  const [breadcrumbs, setBreadcrumbs]  = useState([]);
  const [entries,     setEntries]      = useState([]);
  const [selected,    setSelected]     = useState(new Set());
  const [loading,     setLoading]      = useState(false);
  const [error,       setError]        = useState(null);

  const load = useCallback(async (subpath) => {
    setLoading(true);
    setError(null);
    try {
      const data = await browseDir(subpath);
      setCurrentPath(data.currentPath);
      setBreadcrumbs(data.breadcrumbs);
      setEntries(data.entries);
      setSelected(new Set()); // clear selection on navigation
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load root on mount
  useEffect(() => { load(''); }, [load]);

  const navigate = useCallback((subpath) => load(subpath), [load]);

  const toggleSelect = useCallback((subpath) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(subpath) ? next.delete(subpath) : next.add(subpath);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  return { currentPath, breadcrumbs, entries, selected, loading, error, navigate, toggleSelect, clearSelection };
}

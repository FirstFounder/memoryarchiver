import config from '../config.js';
import path from 'path';

// Allowlist of browseable NAS roots exposed to the UI.
// Users can navigate into subdirectories of these roots and select .MOV files,
// but cannot traverse above them or submit arbitrary filesystem paths.
export const SCRATCH_DIRS = config.scratchDirs;

export const ALLOWED_ROOTS = SCRATCH_DIRS.map(d =>
  path.join(config.nasScatchRoot, d)
);

/**
 * Returns true if the resolved absolutePath is at or below one of the
 * allowed scratch roots. Used to validate browse and submit requests.
 */
export function isAllowedPath(absolutePath) {
  const resolved = path.resolve(absolutePath);
  return ALLOWED_ROOTS.some(root => resolved.startsWith(root + path.sep) || resolved === root);
}

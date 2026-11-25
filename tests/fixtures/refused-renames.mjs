import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

/**
 * Loaded before a forked program (`--import`): every rename onto one of the paths of REFUSED_RENAMES (a JSON
 * list) is refused for good, with an error that is never tried again (EIO, a disk that fails). What
 * `held-renames.mjs` does for an instant within a test, for a program of its own (the installer of an
 * update, scripts/apply-update.mjs).
 */
const refused = new Set(JSON.parse(process.env.REFUSED_RENAMES || '[]').map(path => resolve(path))),
  rename = fs.rename;
fs.rename = async (from, to) => {
  if (refused.has(resolve(to)))
    throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: 'EIO' });
  return rename(from, to);
};
syncBuiltinESMExports();

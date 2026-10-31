import { createHash } from 'node:crypto';

/** Local project assets address ordinary scripts by exact filename. */
export function localScriptIdentity(name: string): string {
  if (name === 'index.js') return '-1';
  if (name === 'clientIndex.js') return '-2';
  return `local-script-${createHash('sha256').update(name).digest('hex')}`;
}

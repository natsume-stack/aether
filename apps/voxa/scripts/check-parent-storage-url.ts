import assert from 'node:assert/strict';
import { resolveParentEditStorageURL } from '../src/apis';

assert.equal(
  resolveParentEditStorageURL(
    '?parentType=engine&storageOrigin=http%3A%2F%2Flocalhost%3A3002%2Fruntime%2Fedit%2Fproject-id',
    '',
    'http://localhost:3001/?parentType=engine',
  ),
  'http://localhost:3002/runtime/edit/project-id/block',
);
assert.equal(
  resolveParentEditStorageURL(
    '?parentType=engine&storageOrigin=http%3A%2F%2Flocalhost%3A3002',
    '',
    'http://127.0.0.1:3001/?parentType=engine',
  ),
  'http://localhost:3002/runtime/edit/block',
);
assert.equal(
  resolveParentEditStorageURL(
    '?parentType=engine',
    '',
    'http://localhost:3001/?parentType=engine',
    '',
    'http://localhost:3002',
  ),
  'http://localhost:3002/runtime/edit/block',
);
assert.equal(
  resolveParentEditStorageURL(
    '?storageOrigin=https%3A%2F%2Fevil.example',
    '',
    'http://localhost:3001/',
  ),
  '',
);
assert.equal(
  resolveParentEditStorageURL(
    '',
    'http://localhost:3002/e/project',
    'http://localhost:3001/',
    'QmHash',
  ),
  'http://localhost:3002/runtime/edit/block/QmHash',
);

process.stdout.write('VOXA parent storage URL checks passed.\n');

import assert from 'node:assert/strict';

import {
  canAccessVoxaModels,
  canEditVoxaModels,
  canManageVoxaModels,
  requireVoxaEditorAccess,
  resolveVoxaEditorAccess,
} from '../server/model-management-access';

assert.equal(canEditVoxaModels({ creatorAccess: true, creatorPermissions: ['voxa.edit'] }), true);
assert.equal(canManageVoxaModels({ creatorAccess: true, creatorPermissions: ['voxa.edit'] }), false);
assert.equal(canEditVoxaModels({ creatorAccess: true, creatorPermissions: ['models.manage'] }), false);
assert.equal(canManageVoxaModels({ creatorAccess: true, creatorPermissions: ['models.manage'] }), true);
assert.equal(canEditVoxaModels({ creatorAccess: true, creatorPermissions: ['projects.edit'] }), false);
assert.equal(canEditVoxaModels({ creatorAccess: false, creatorPermissions: ['voxa.edit'] }), false);
assert.equal(canEditVoxaModels({ creatorAccess: true, creatorPermissions: ['voxa.edit', 'models.manage'] }), true);
assert.equal(canAccessVoxaModels({ creatorAccess: true, creatorPermissions: ['voxa.edit'] }, 'voxa.edit'), true);
assert.equal(canAccessVoxaModels({ creatorAccess: true, creatorPermissions: [] }, []), false);

process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://127.0.0.1:13124';
process.env.PERMISSION_TOKEN_SECRET = 'fixture-secret-for-voxa-editor-permission';

type Identity = { creatorAccess: boolean; creatorPermissions: string[] };
let identity: Identity = { creatorAccess: true, creatorPermissions: ['voxa.edit'] };
let status = 200;

globalThis.fetch = (async () => new Response(JSON.stringify({ identity }), {
  status,
  headers: { 'content-type': 'application/json' },
})) as typeof fetch;

const request = {
  headers: { cookie: 'box_session=fixture', 'user-agent': 'check' },
  socket: { remoteAddress: '127.0.0.1' },
} as never;
const response = { setHeader() {} } as never;

async function main() {
  assert.equal(await resolveVoxaEditorAccess(request, response), 'allowed');

  identity = { creatorAccess: true, creatorPermissions: ['models.manage'] };
  assert.equal(await resolveVoxaEditorAccess(request, response), 'denied');

  identity = { creatorAccess: false, creatorPermissions: ['voxa.edit'] };
  assert.equal(await resolveVoxaEditorAccess(request, response), 'denied');

  identity = { creatorAccess: true, creatorPermissions: ['voxa.edit'] };
  status = 401;
  assert.equal(await resolveVoxaEditorAccess(request, response), 'unauthenticated');

  status = 200;
  const deniedResponse = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  identity = { creatorAccess: true, creatorPermissions: [] };
  assert.equal(await requireVoxaEditorAccess(request, deniedResponse as never), false);
  assert.equal(deniedResponse.statusCode, 403);

  delete process.env.BOX_PLAYER_SERVICE_INTERNAL_URL;
  assert.equal(await resolveVoxaEditorAccess(request, response), 'unavailable');

  delete process.env.PERMISSION_TOKEN_SECRET;
  process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://127.0.0.1:13124';
  assert.equal(await resolveVoxaEditorAccess(request, response), 'unavailable');

  console.log('voxa editor permission checks passed');
}

void main();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  canAccessVoxaModels,
  canManageVoxaModels,
  requireVoxaModelAccess,
  resolveVoxaModelManagement,
} from '../server/model-management-access';

const routeRoot = path.resolve(__dirname, '../pages/api/local');
for (const [relativePath, guard] of [
  ['models/index.ts', 'requireVoxaModelAccess'],
  ['models/[id].ts', 'requireVoxaModelAccess'],
  ['blobs/[hash].ts', 'requireVoxaModelAccess'],
  ['default-skin.ts', 'requireVoxaModelAccess'],
  ['models/[id]/snapshots.ts', 'requireVoxaModelManagement'],
  ['models/[id]/export.ts', 'requireVoxaModelManagement'],
] as const) {
  assert.match(
    fs.readFileSync(path.join(routeRoot, relativePath), 'utf8'),
    new RegExp(`await ${guard}\\(`),
    `${relativePath} must authenticate direct VOXA reads`,
  );
}

assert.equal(
  canManageVoxaModels({ creatorAccess: true, creatorPermissions: ['models.manage'] }),
  true,
  'a creator with the model-management capability must be allowed into VOXA',
);
assert.equal(
  canManageVoxaModels({ creatorAccess: true, creatorPermissions: ['projects.edit'] }),
  false,
  'editing a map must not implicitly grant VOXA model-management access',
);
assert.equal(
  canManageVoxaModels({ creatorAccess: false, creatorPermissions: ['models.manage'] }),
  false,
  'the capability alone is invalid without creator access',
);
assert.equal(
  canAccessVoxaModels(
    { creatorAccess: true, creatorPermissions: ['projects.edit'] },
    ['projects.edit', 'models.manage'],
  ),
  true,
  'map editors may read model assets without receiving model-management rights',
);
assert.equal(
  canAccessVoxaModels(
    { creatorAccess: false, creatorPermissions: ['projects.edit', 'models.manage'] },
    ['projects.edit', 'models.manage'],
  ),
  false,
  'capability strings are invalid without current creator access',
);

async function main() {
  const previousURL = process.env.BOX_PLAYER_SERVICE_INTERNAL_URL;
  const previousSecret = process.env.PERMISSION_TOKEN_SECRET;
  const previousFetch = global.fetch;
  process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://player-service.test';
  process.env.PERMISSION_TOKEN_SECRET = 'permission-test-secret';

  const response = {
    statusCode: 200,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string | string[]) {
      this.headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    },
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
  const request = {
    headers: { cookie: 'box_player_session=valid', 'user-agent': 'regression' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  try {
    global.fetch = (async () => new Response(JSON.stringify({
      identity: { creatorAccess: true, creatorPermissions: ['projects.edit'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    assert.equal(
      await resolveVoxaModelManagement(request as any, response as any),
      'denied',
      'the live player-service assertion must deny a creator who lacks models.manage',
    );

    global.fetch = (async () => new Response(JSON.stringify({
      identity: { creatorAccess: true, creatorPermissions: ['models.manage'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    assert.equal(
      await resolveVoxaModelManagement(request as any, response as any),
      'allowed',
      'the live player-service assertion must allow the explicit capability',
    );

    global.fetch = (async () => new Response(JSON.stringify({
      message: 'AUTH_REQUIRED',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const deniedResponse = {
      ...response,
      statusCode: 200,
      headers: new Map<string, string>(),
    };
    assert.equal(
      await requireVoxaModelAccess(
        request as any,
        deniedResponse as any,
        ['projects.edit', 'models.manage'],
      ),
      false,
      'anonymous model reads must be rejected',
    );
    assert.equal(deniedResponse.statusCode, 401);
  } finally {
    global.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.BOX_PLAYER_SERVICE_INTERNAL_URL;
    else process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = previousURL;
    if (previousSecret === undefined) delete process.env.PERMISSION_TOKEN_SECRET;
    else process.env.PERMISSION_TOKEN_SECRET = previousSecret;
  }
}

main().then(() => {
  console.log('VOXA model-management permission regression passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

const repository = path.resolve(__dirname, '../../..');

function source(relativePath: string) {
  return fs.readFileSync(path.join(repository, relativePath), 'utf8');
}

describe('legacy Box ID compatibility contract', () => {
  test('migrates existing player databases with one optional unique binding', () => {
    const identitySource = source('apps/game/server/local-player-identity.ts');

    expect(identitySource).toContain("ADD COLUMN IF NOT EXISTS box_id TEXT");
    expect(identitySource).toContain("ON ${table('users')} (box_id) WHERE box_id IS NOT NULL");
    expect(identitySource).toContain("boxId: row.box_id || ''");
  });

  test('carries the binding through the signed runtime identity', () => {
    const identitySource = source('packages/utils/src/local-player-identity.ts');
    const gameServerSource = source('services/game-server/src/createServer.ts');

    expect(identitySource).toContain('boxId: string;');
    expect(gameServerSource).toContain('userData.username = runtimeIdentity.boxId;');
  });

  test('keeps the script API read-only default compatible with Boxes', () => {
    const apiSource = source('internals/schema/api/js/api.ts');

    expect(apiSource).toContain("public boxId = '';");
  });
});

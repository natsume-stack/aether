import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { getPlaySystemStatus } from './play-system-status';

const temporaryRoots: string[] = [];
const previousLibraryPath = process.env.BOX_PLAY_LIBRARY_PATH;
const previousRuntimePort = process.env.BOX_PLAY_RUNTIME_PORT;

afterEach(() => {
  if (previousLibraryPath === undefined) delete process.env.BOX_PLAY_LIBRARY_PATH;
  else process.env.BOX_PLAY_LIBRARY_PATH = previousLibraryPath;
  if (previousRuntimePort === undefined) delete process.env.BOX_PLAY_RUNTIME_PORT;
  else process.env.BOX_PLAY_RUNTIME_PORT = previousRuntimePort;
  while (temporaryRoots.length) fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('play system status', () => {
  test('reports installed worlds and an unavailable runtime without starting it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-play-status-test-'));
    temporaryRoots.push(root);
    const worldRoot = path.join(root, 'main-world');
    fs.mkdirSync(path.join(worldRoot, 'data', 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(worldRoot, 'manifest.json'), JSON.stringify({
      id: 'main-world',
      publicId: 'my-world',
      projectName: '测试地图',
      version: 'v1',
      permissionHash: 'permission-main',
      mapGroupId: 'main-world',
      mainProjectId: 'main-world',
      mapRole: 'main',
    }));
    fs.writeFileSync(path.join(worldRoot, 'data', 'project-state.json'), JSON.stringify({
      permissionHash: 'permission-main',
    }));
    process.env.BOX_PLAY_LIBRARY_PATH = root;
    process.env.BOX_PLAY_RUNTIME_PORT = '9';

    const status = await getPlaySystemStatus();

    expect(status.worlds.count).toBe(1);
    expect(status.worlds.groupCount).toBe(1);
    expect(status.worlds.runtimes[0]).toMatchObject({
      worldId: 'main-world',
      publicId: 'my-world',
      worldName: '测试地图',
    });
    expect(status.worlds.runtimes[0].status.phase).toBe('unavailable');
    expect(status.status).toBe('warning');
  });
});

import { describe, expect, jest, test } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  normalizeMapRuntimeProfile,
  normalizeRuntimeResourceGroup,
  listRuntimeResourceGroups,
  restartContainerRuntime,
  runtimeControlURL,
  saveRuntimeResourceGroup,
  savePlayMapGroupRuntimeProfile,
} from './map-container-admin';

describe('map container profile validation', () => {
  const valid = {
    permanentMapId: 'my-play-map',
    playerLimit: 30,
    roomLimit: 4,
    idleTimeoutMs: 900000,
    cpuMilli: 500,
    memoryMb: 768,
  };

  test('normalizes a standalone container profile', () => {
    expect(normalizeMapRuntimeProfile(valid)).toEqual({
      ...valid,
      cpuMilli: null,
      memoryMb: null,
      mode: 'play',
      configurationScope: 'map',
      configurationRootId: valid.permanentMapId,
    });
  });

  test('ignores historical per-map resource limits so only resource groups isolate a runtime', () => {
    expect(normalizeMapRuntimeProfile({ ...valid, cpuMilli: 1000, memoryMb: 1024 })).toMatchObject({
      cpuMilli: null,
      memoryMb: null,
    });
  });

  test('rejects invalid map IDs and unsafe limits', () => {
    expect(() => normalizeMapRuntimeProfile({ ...valid, permanentMapId: '../unsafe' })).toThrow('地图永久 ID 格式无效');
    expect(() => normalizeRuntimeResourceGroup({ id: 'resource-small', name: '资源组', cpuMilli: 1000, memoryMb: 32 })).toThrow('内存上限（MB）');
    expect(() => normalizeRuntimeResourceGroup({ id: 'resource-small', name: '资源组', cpuMilli: 1000, memoryMb: 512, networkPolicy: 'internet' })).toThrow('网络策略无效');
    expect(() => normalizeRuntimeResourceGroup({ id: 'resource-small', name: '资源组', cpuMilli: 1000, memoryMb: 512, processLimit: 1 })).toThrow('容器进程上限');
  });

  test('normalizes enforced network, process, bandwidth and description settings', () => {
    expect(normalizeRuntimeResourceGroup({
      id: 'resource-networked',
      name: '受限地图',
      cpuMilli: 1000,
      memoryMb: 1024,
      description: '只能访问内部服务',
      networkPolicy: 'private',
      processLimit: 128,
      bandwidthMbps: 20,
    })).toMatchObject({
      description: '只能访问内部服务',
      networkPolicy: 'private',
      processLimit: 128,
      bandwidthMbps: 20,
    });
  });

  test('uses the Play public runtime prefix but not the Creator one', () => {
    const originalPlay = process.env.BOX_PLAY_INTERNAL_URL;
    const originalCreator = process.env.BOX_CREATOR_RUNTIME_INTERNAL_URL;
    process.env.BOX_PLAY_INTERNAL_URL = 'http://play:3000';
    process.env.BOX_CREATOR_RUNTIME_INTERNAL_URL = 'http://creator:9967';
    expect(runtimeControlURL('play', 'project-map')).toBe('http://play:3000/p/project-map');
    expect(runtimeControlURL('creator', 'project-map')).toBe('http://creator:9967/project-map');
    if (originalPlay === undefined) delete process.env.BOX_PLAY_INTERNAL_URL;
    else process.env.BOX_PLAY_INTERNAL_URL = originalPlay;
    if (originalCreator === undefined) delete process.env.BOX_CREATOR_RUNTIME_INTERNAL_URL;
    else process.env.BOX_CREATOR_RUNTIME_INTERNAL_URL = originalCreator;
  });

  test('restarts a play runtime by destroying it before explicitly starting it', async () => {
    const originalPlay = process.env.BOX_PLAY_INTERNAL_URL;
    const originalFetch = global.fetch;
    process.env.BOX_PLAY_INTERNAL_URL = 'http://play:3000';
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await restartContainerRuntime('play', 'project-map');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requests = fetchMock.mock.calls.map(([input, init]) => new Request(input as RequestInfo, init as RequestInit));
      expect(requests.map((request) => ({ url: request.url, method: request.method }))).toEqual([
        { url: 'http://play:3000/p/project-map/__local_runtime/destroy', method: 'POST' },
        { url: 'http://play:3000/p/project-map/__local_runtime/start', method: 'POST' },
      ]);
      expect(requests[1].headers.get('x-box-runtime-restart')).toBe('1');
    } finally {
      global.fetch = originalFetch;
      if (originalPlay === undefined) delete process.env.BOX_PLAY_INTERNAL_URL;
      else process.env.BOX_PLAY_INTERNAL_URL = originalPlay;
    }
  });

  test('applies one map-group profile to its main map and every submap', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'box-container-profile-'));
    const profilePath = path.join(temporaryRoot, 'profiles.json');
    const originalPlay = process.env.BOX_PLAY_INTERNAL_URL;
    const originalToken = process.env.BOX_PLAY_ADMIN_TOKEN;
    const originalProfilePath = process.env.BOX_MAP_RUNTIME_PROFILES_PATH;
    const originalFetch = global.fetch;
    process.env.BOX_PLAY_INTERNAL_URL = 'http://play:3000';
    process.env.BOX_PLAY_ADMIN_TOKEN = 'test-token';
    process.env.BOX_MAP_RUNTIME_PROFILES_PATH = profilePath;
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ worlds: [
      { id: 'main-project', permanentMapId: 'main-map', name: '主地图', mapGroupId: 'group-1', mapRole: 'main', mainProjectId: 'main-project' },
      { id: 'sub-project', permanentMapId: 'sub-map', name: '副地图', mapGroupId: 'group-1', mapRole: 'submap', mainProjectId: 'main-project' },
    ] }), { status: 200 })) as unknown as typeof fetch;
    try {
      const profile = await savePlayMapGroupRuntimeProfile({ ...valid, permanentMapId: 'sub-map' });
      expect(profile.permanentMapId).toBe('main-map');
      const document = JSON.parse(await readFile(profilePath, 'utf8'));
      expect(document.profiles.map((item: { permanentMapId: string }) => item.permanentMapId).sort())
        .toEqual(['main-map', 'sub-map']);
      expect(document.profiles.every((item: { playerLimit: number }) => item.playerLimit === valid.playerLimit)).toBe(true);
    } finally {
      global.fetch = originalFetch;
      if (originalPlay === undefined) delete process.env.BOX_PLAY_INTERNAL_URL;
      else process.env.BOX_PLAY_INTERNAL_URL = originalPlay;
      if (originalToken === undefined) delete process.env.BOX_PLAY_ADMIN_TOKEN;
      else process.env.BOX_PLAY_ADMIN_TOKEN = originalToken;
      if (originalProfilePath === undefined) delete process.env.BOX_MAP_RUNTIME_PROFILES_PATH;
      else process.env.BOX_MAP_RUNTIME_PROFILES_PATH = originalProfilePath;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('persists reusable resource groups and keeps a profile reference to the group', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'box-container-resource-group-'));
    const profilePath = path.join(temporaryRoot, 'profiles.json');
    const originalPlay = process.env.BOX_PLAY_INTERNAL_URL;
    const originalToken = process.env.BOX_PLAY_ADMIN_TOKEN;
    const originalProfilePath = process.env.BOX_MAP_RUNTIME_PROFILES_PATH;
    const originalFetch = global.fetch;
    process.env.BOX_PLAY_INTERNAL_URL = 'http://play:3000';
    process.env.BOX_PLAY_ADMIN_TOKEN = 'test-token';
    process.env.BOX_MAP_RUNTIME_PROFILES_PATH = profilePath;
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ worlds: [
      { id: 'main-project', permanentMapId: 'main-map', name: '主地图', mapGroupId: 'group-1', mapRole: 'main', mainProjectId: 'main-project' },
    ] }), { status: 200 })) as unknown as typeof fetch;
    try {
      const group = await saveRuntimeResourceGroup({ name: '中型地图', cpuMilli: 1500, memoryMb: 1536 });
      expect(group.id).toMatch(/^resource-/);
      await savePlayMapGroupRuntimeProfile({ ...valid, permanentMapId: 'main-map', resourceGroupId: group.id, cpuMilli: null, memoryMb: null });
      expect(await listRuntimeResourceGroups()).toEqual([group]);
      const document = JSON.parse(await readFile(profilePath, 'utf8'));
      expect(document.profiles[0]).toMatchObject({ resourceGroupId: group.id, cpuMilli: null, memoryMb: null });
    } finally {
      global.fetch = originalFetch;
      if (originalPlay === undefined) delete process.env.BOX_PLAY_INTERNAL_URL;
      else process.env.BOX_PLAY_INTERNAL_URL = originalPlay;
      if (originalToken === undefined) delete process.env.BOX_PLAY_ADMIN_TOKEN;
      else process.env.BOX_PLAY_ADMIN_TOKEN = originalToken;
      if (originalProfilePath === undefined) delete process.env.BOX_MAP_RUNTIME_PROFILES_PATH;
      else process.env.BOX_MAP_RUNTIME_PROFILES_PATH = originalProfilePath;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

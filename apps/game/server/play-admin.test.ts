import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test } from '@jest/globals';

import {
  cancelPlayBundleReview,
  confirmPlayBundleReview,
  createPlayBundleReview,
  getPlayBundleReviewResource,
  importPlayBundle,
  updatePlayWorld,
} from './play-admin';

const { resolveWorld } = require('../../local-engine/src/play-library') as {
  resolveWorld: (root: string, reference: string) => { id: string } | null;
};

const temporaryRoots: string[] = [];
const reviewIds: string[] = [];

function createGroupBundle(version = 'v1', suffix = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-play-group-test-'));
  temporaryRoots.push(root);
  const input = path.join(root, 'input');
  const archivePath = path.join(root, 'group.boxplay');
  const members = [
    { id: `group-main${suffix}`, permanentMapId: '11111111111111111111', name: '主地图', mapRole: 'main' },
    { id: `group-dungeon${suffix}`, permanentMapId: '22222222222222222222', name: '副地图', mapRole: 'submap' },
  ] as const;

  for (const member of members) {
    const worldRoot = path.join(input, 'worlds', member.id);
    const permissionHash = `permission-${member.id}`;
    const versionControlHash = `version-control-${member.id}`;
    const projectHash = `project-${member.id}`;
    const scriptAssetsHash = `script-assets-${member.id}`;
    const pictureAssetsHash = `picture-assets-${member.id}`;
    const audioAssetsHash = `audio-assets-${member.id}`;
    const scriptHash = `script-${member.id}.js`;
    const clientScriptHash = `client-script-${member.id}.js`;
    const pictureHash = `picture-${member.id}.json`;
    const picturePayloadHash = `picture-payload-${member.id}`;
    const audioHash = `Qm${member.mapRole === 'main' ? 'A'.repeat(44) : 'B'.repeat(44)}`;
    fs.mkdirSync(path.join(worldRoot, 'data', 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(worldRoot, 'manifest.json'), JSON.stringify({
      formatVersion: 1,
      id: member.id,
      permanentMapId: member.permanentMapId,
      permanentMapGroupId: members[0].permanentMapId,
      projectName: member.name,
      version,
      permissionHash,
      mapGroupId: members[0].id,
      mainProjectId: members[0].id,
      mapRole: member.mapRole,
    }));
    fs.writeFileSync(
      path.join(worldRoot, 'data', 'project-state.json'),
      JSON.stringify({ permissionHash }),
    );
    const blobs = path.join(worldRoot, 'data', 'blobs');
    fs.writeFileSync(
      path.join(blobs, permissionHash),
      JSON.stringify({ versionControl: versionControlHash }),
    );
    fs.writeFileSync(
      path.join(blobs, versionControlHash),
      JSON.stringify({ branches: { master: { headHash: projectHash } } }),
    );
    fs.writeFileSync(
      path.join(blobs, projectHash),
      JSON.stringify({ scriptAssets: scriptAssetsHash, pictureAssets: pictureAssetsHash, audioAssets: audioAssetsHash }),
    );
    fs.writeFileSync(
      path.join(blobs, scriptAssetsHash),
      JSON.stringify({
        'index.js': { hash: scriptHash, type: 1 },
        'clientIndex.js': { hash: clientScriptHash, type: 7 },
      }),
    );
    fs.writeFileSync(
      path.join(blobs, pictureAssetsHash),
      JSON.stringify({ '地图封面.png': { hash: pictureHash, type: 2 } }),
    );
    fs.writeFileSync(
      path.join(blobs, audioAssetsHash),
      JSON.stringify({ '背景音乐.mp3': { hash: `${audioHash}.mp3`, type: 3 } }),
    );
    fs.writeFileSync(path.join(blobs, scriptHash), `globalThis.__reviewExecuted = '${member.id}'\n`);
    fs.writeFileSync(path.join(blobs, clientScriptHash), `globalThis.__clientReviewExecuted = '${member.id}'\n`);
    fs.writeFileSync(
      path.join(blobs, pictureHash),
      JSON.stringify({ hash: picturePayloadHash, width: 64, height: 64 }),
    );
    fs.writeFileSync(path.join(blobs, picturePayloadHash), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(blobs, audioHash), Buffer.from('ID3'));
  }
  fs.writeFileSync(path.join(input, 'bundle.json'), JSON.stringify({
    formatVersion: 1,
    type: 'map-group-play-bundle',
    mapGroupId: members[0].id,
    permanentMapGroupId: members[0].permanentMapId,
    mainProjectId: members[0].id,
    members: members.map((member) => ({
      id: member.id,
      permanentMapId: member.permanentMapId,
      mapRole: member.mapRole,
      mainProjectId: members[0].id,
    })),
  }));
  execFileSync('tar', ['-czf', archivePath, '-C', input, 'bundle.json', 'worlds']);
  return { root, archivePath };
}

afterEach(() => {
  delete process.env.BOX_PLAY_LIBRARY_PATH;
  while (reviewIds.length) cancelPlayBundleReview(reviewIds.pop()!);
  while (temporaryRoots.length) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('map group play bundle import', () => {
  test('reviews indexed code and media without installing the bundle', async () => {
    const { root, archivePath } = createGroupBundle();
    const library = path.join(root, 'library');
    process.env.BOX_PLAY_LIBRARY_PATH = library;

    const review = await createPlayBundleReview(archivePath);
    reviewIds.push(review.id);

    expect(review.mapCount).toBe(2);
    expect(review.worlds.map((world) => world.mapRole).sort()).toEqual(['main', 'submap']);
    expect(review.resources.filter((resource) => resource.kind === 'script')).toHaveLength(4);
    expect(review.resources.filter((resource) => resource.scriptTarget === 'server')).toHaveLength(2);
    expect(review.resources.filter((resource) => resource.scriptTarget === 'client')).toHaveLength(2);
    expect(review.resources.filter((resource) => resource.kind === 'image')).toHaveLength(2);
    expect(review.resources.filter((resource) => resource.kind === 'audio')).toHaveLength(2);
    expect(fs.existsSync(path.join(library, 'group-main'))).toBe(false);

    const script = review.resources.find((resource) => resource.kind === 'script')!;
    const entry = getPlayBundleReviewResource(review.id, script.id);
    expect(fs.readFileSync(entry.path, 'utf8')).toContain('globalThis.__reviewExecuted');
    expect((globalThis as typeof globalThis & { __reviewExecuted?: string }).__reviewExecuted).toBeUndefined();

    const image = review.resources.find((resource) => resource.kind === 'image')!;
    const imageEntry = getPlayBundleReviewResource(review.id, image.id);
    expect(image.mimeType).toBe('image/png');
    expect(image.bytes).toBe(4);
    expect(fs.readFileSync(imageEntry.path).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const audio = review.resources.find((resource) => resource.kind === 'audio')!;
    const audioEntry = getPlayBundleReviewResource(review.id, audio.id);
    expect(fs.readFileSync(audioEntry.path, 'utf8')).toBe('ID3');
    expect(review.warnings).toEqual([]);
  });

  test('installs a reviewed bundle only after confirmation', async () => {
    const { root, archivePath } = createGroupBundle();
    const library = path.join(root, 'library');
    process.env.BOX_PLAY_LIBRARY_PATH = library;
    const review = await createPlayBundleReview(archivePath);

    expect(fs.existsSync(path.join(library, 'group-main'))).toBe(false);
    const result = confirmPlayBundleReview(review.id);

    expect(result.mapCount).toBe(2);
    expect(fs.existsSync(path.join(library, 'group-main', 'manifest.json'))).toBe(true);
    expect(() => confirmPlayBundleReview(review.id)).toThrow('不存在或已过期');
  });

  test('discards review resources when the owner cancels', async () => {
    const { root, archivePath } = createGroupBundle();
    process.env.BOX_PLAY_LIBRARY_PATH = path.join(root, 'library');
    const review = await createPlayBundleReview(archivePath);
    const resource = review.resources[0];

    cancelPlayBundleReview(review.id);

    expect(() => getPlayBundleReviewResource(review.id, resource.id)).toThrow('不存在或已过期');
    expect(() => confirmPlayBundleReview(review.id)).toThrow('不存在或已过期');
  });

  test('installs the main map and all submaps in one operation', async () => {
    const { root, archivePath } = createGroupBundle();
    const library = path.join(root, 'library');
    process.env.BOX_PLAY_LIBRARY_PATH = library;

    const result = await importPlayBundle(archivePath);

    expect(result.mainProjectId).toBe('group-main');
    expect(result.mapCount).toBe(2);
    expect(result.world.id).toBe('group-main');
    expect(result.worlds.map((world) => world.id).sort()).toEqual([
      'group-dungeon',
      'group-main',
    ]);
    expect(fs.existsSync(path.join(library, 'group-main', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(library, 'group-dungeon', 'manifest.json'))).toBe(true);
  });

  test('upgrades matching projects and preserves local access settings', async () => {
    const old = createGroupBundle('1.9.0');
    process.env.BOX_PLAY_LIBRARY_PATH = path.join(old.root, 'library');
    await importPlayBundle(old.archivePath);
    updatePlayWorld('group-main', { publicId: 'my-town' });
    const incoming = createGroupBundle('1.10.0');
    const review = await createPlayBundleReview(incoming.archivePath);
    const result = confirmPlayBundleReview(review.id);
    expect(result.world.version).toBe('1.10.0');
    expect(result.world.publicId).toBe('my-town');
    expect(result.world.permanentMapId).toBe('11111111111111111111');
    await expect(importPlayBundle(incoming.archivePath)).rejects.toThrow('相同');
    await expect(importPlayBundle(old.archivePath)).rejects.toThrow('低于');
  });

  test('keeps installed identities, group links and runtime storage when archive directory IDs change', async () => {
    const old = createGroupBundle('1.0.0');
    const library = path.join(old.root, 'library');
    process.env.BOX_PLAY_LIBRARY_PATH = library;
    await importPlayBundle(old.archivePath);
    fs.writeFileSync(path.join(library, 'group-main', 'data', 'player-storage.json'), '{"score":42}');
    const incoming = createGroupBundle('2.0.0', '-exported');
    const result = await importPlayBundle(incoming.archivePath);
    expect(result.mainProjectId).toBe('group-main');
    expect(result.worlds.map((world) => world.id).sort()).toEqual(['group-dungeon', 'group-main']);
    expect(result.worlds.every((world) => world.mainProjectId === 'group-main' && world.mapGroupId === 'group-main')).toBe(true);
    expect(fs.readFileSync(path.join(library, 'group-main', 'data', 'player-storage.json'), 'utf8')).toBe('{"score":42}');
    expect(fs.existsSync(path.join(library, 'group-main-exported'))).toBe(false);
  });

  test('restores all old maps if an upgrade fails partway through installation', async () => {
    const old = createGroupBundle('1.0.0');
    const library = path.join(old.root, 'library');
    process.env.BOX_PLAY_LIBRARY_PATH = library;
    await importPlayBundle(old.archivePath);
    const before = ['group-main', 'group-dungeon'].map((id) => fs.readFileSync(path.join(library, id, 'manifest.json'), 'utf8'));
    const incoming = createGroupBundle('2.0.0');
    const review = await createPlayBundleReview(incoming.archivePath);
    const originalRename = fs.renameSync;
    let installedCount = 0;
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(source).includes('-importing-') && ++installedCount === 2) throw new Error('fixture upgrade failure');
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    try {
      expect(() => confirmPlayBundleReview(review.id)).toThrow('fixture upgrade failure');
    } finally {
      fs.renameSync = originalRename;
    }
    expect(['group-main', 'group-dungeon'].map((id) => fs.readFileSync(path.join(library, id, 'manifest.json'), 'utf8'))).toEqual(before);
    expect(fs.readdirSync(library).sort()).toEqual(['group-dungeon', 'group-main']);
  });

  test('rechecks versions at confirmation instead of overwriting a newer concurrent import', async () => {
    const old = createGroupBundle('1.0.0');
    process.env.BOX_PLAY_LIBRARY_PATH = path.join(old.root, 'library');
    await importPlayBundle(old.archivePath);
    const incoming = createGroupBundle('2.0.0');
    const review = await createPlayBundleReview(incoming.archivePath);
    expect(review.warnings.some((warning) => warning.includes('1.0.0 → 2.0.0'))).toBe(true);
    await importPlayBundle(createGroupBundle('3.0.0').archivePath);
    expect(() => confirmPlayBundleReview(review.id)).toThrow('低于');
  });

  test('compares short versions and prereleases numerically', async () => {
    const old = createGroupBundle('v1');
    process.env.BOX_PLAY_LIBRARY_PATH = path.join(old.root, 'library');
    await importPlayBundle(old.archivePath);
    await expect(importPlayBundle(createGroupBundle('1.0.0').archivePath)).rejects.toThrow('相同');
    await importPlayBundle(createGroupBundle('2.0.0-beta.2').archivePath);
    await importPlayBundle(createGroupBundle('2.0.0-beta.10').archivePath);
    await importPlayBundle(createGroupBundle('2.0.0').archivePath);
    await expect(importPlayBundle(createGroupBundle('2.0.0-beta.20').archivePath)).rejects.toThrow('低于');
  });

  test('rejects the whole bundle when any member ID already exists', async () => {
    const { root, archivePath } = createGroupBundle();
    const library = path.join(root, 'library');
    fs.mkdirSync(path.join(library, 'group-dungeon'), { recursive: true });
    process.env.BOX_PLAY_LIBRARY_PATH = library;

    await expect(importPlayBundle(archivePath)).rejects.toThrow('已经存在');
    expect(fs.existsSync(path.join(library, 'group-main'))).toBe(false);
    expect(
      fs.readdirSync(library).some((entry) => entry.includes('-importing-')),
    ).toBe(false);
  });

  test('retries transient staging cleanup failures without hiding the install error', async () => {
    const { root, archivePath } = createGroupBundle();
    const library = path.join(root, 'library');
    process.env.BOX_PLAY_LIBRARY_PATH = library;
    const originalRename = fs.renameSync;
    const originalRemove = fs.rmSync;
    let cleanupAttempts = 0;

    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (String(source).includes('.group-main-importing-')) {
        throw new Error('fixture installation failure');
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
      if (
        String(target).includes('.group-main-importing-') &&
        cleanupAttempts++ === 0
      ) {
        const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${target}/data'`) as NodeJS.ErrnoException;
        error.code = 'ENOTEMPTY';
        throw error;
      }
      return originalRemove(target, options);
    }) as typeof fs.rmSync;
    try {
      await expect(importPlayBundle(archivePath)).rejects.toThrow('fixture installation failure');
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRemove;
    }

    expect(cleanupAttempts).toBe(2);
    expect(fs.readdirSync(library).some((entry) => entry.includes('-importing-'))).toBe(false);
  });

  test('copies imported worlds with readable bind-mount-safe file modes', async () => {
    const { root, archivePath } = createGroupBundle();
    process.env.BOX_PLAY_LIBRARY_PATH = path.join(root, 'library');
    const originalCopy = fs.cpSync;

    fs.cpSync = ((source: Parameters<typeof fs.cpSync>[0], destination: Parameters<typeof fs.cpSync>[1], options?: fs.CopySyncOptions) => {
      if (String(destination).includes('-importing-')) {
        const error = new Error(`EACCES: permission denied, copy '${destination}'`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return originalCopy(source, destination, options);
    }) as typeof fs.cpSync;
    try {
      const result = await importPlayBundle(archivePath);
      expect(result.mapCount).toBe(2);
    } finally {
      fs.cpSync = originalCopy;
    }
  });

  test('stores a unique public map ID without changing the internal world ID', async () => {
    const { root, archivePath } = createGroupBundle();
    process.env.BOX_PLAY_LIBRARY_PATH = path.join(root, 'library');
    await importPlayBundle(archivePath);

    const updated = updatePlayWorld('group-main', { publicId: 'my-town' });

    expect(updated?.id).toBe('group-main');
    expect(updated?.permanentMapId).toBe('11111111111111111111');
    expect(updated?.publicId).toBe('my-town');
    expect(resolveWorld(process.env.BOX_PLAY_LIBRARY_PATH!, 'my-town')?.id).toBe('group-main');
    expect(() => updatePlayWorld('group-dungeon', { publicId: 'my-town' }))
      .toThrow('已经被其他地图使用');
    expect(() => updatePlayWorld('group-dungeon', { publicId: 'group-main' }))
      .toThrow('已经被其他地图使用');
    expect(() => updatePlayWorld('group-dungeon', { publicId: '非法 ID' }))
      .toThrow('只能包含小写字母');
  });
});

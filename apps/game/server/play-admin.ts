import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';

import { getPlayWorlds } from './play-worlds';
import { normalizeMapIdentity } from './map-identity';

const tarStream = require('tar-stream') as {
  extract(): NodeJS.WritableStream & {
    on(
      event: 'entry',
      listener: (
        header: { name: string; type: string; size: number },
        stream: NodeJS.ReadableStream,
        next: (error?: Error) => void,
      ) => void,
    ): void;
  };
};

const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 200000;
const DIRECTORY_RETRY_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
const REVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_REVIEW_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_CODE_BYTES = 1024 * 1024;
const MAX_ACTIVE_REVIEWS = 4;

type ValidatedPlayWorld = ReturnType<typeof validateWorld> & { root: string };

export type PlayBundleReviewResource = {
  id: string;
  worldId: string;
  name: string;
  kind: 'script' | 'image' | 'audio' | 'model' | 'other';
  scriptTarget?: 'server' | 'client';
  mimeType: string;
  bytes: number;
  previewable: boolean;
};

export type PlayBundleReview = {
  id: string;
  expiresAt: string;
  mapCount: number;
  totalBytes: number;
  blobCount: number;
  unindexedBlobCount: number;
  worlds: Array<{
    id: string;
    name: string;
    author: string;
    description: string;
    version: string;
    mapRole: 'main' | 'submap';
    mainProjectId: string;
  }>;
  resources: PlayBundleReviewResource[];
  warnings: string[];
};

type ReviewSession = {
  review: PlayBundleReview;
  temporaryRoot: string;
  worlds: ValidatedPlayWorld[];
  resources: Map<string, { path: string; resource: PlayBundleReviewResource }>;
  expiresAt: number;
};

const reviewSessions = new Map<string, ReviewSession>();

function removeDirectoryWithRetry(target: string, retries = 5, retryDelay = 120) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!DIRECTORY_RETRY_ERRORS.has(code || '') || attempt === retries) throw error;
      // Docker Desktop can briefly report a bind-mounted directory as busy
      // while its file synchronization catches up. Keep the retry synchronous
      // so callers never observe a half-cleaned staging directory.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay);
    }
  }
  throw lastError;
}

function cleanupDirectoryQuietly(target: string) {
  try {
    removeDirectoryWithRetry(target);
  } catch (error) {
    // Preserve the installation/validation error; the orphaned path is left
    // for diagnostics if Docker keeps reporting it as busy.
    console.warn(`无法清理游玩包临时目录 ${target}: ${(error as Error).message}`);
  }
}

// fs.cpSync preserves archive file modes. Docker Desktop can represent a
// host-side 0600 file as 0200 in a Linux bind mount, which makes a staged
// world unreadable and later impossible to clean up. Create every destination
// path with the explicit modes used by the Play runtime instead.
function copyReadableFile(source: string, destination: string) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  const input = fs.openSync(source, 'r');
  const output = fs.openSync(destination, 'w', 0o644);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(input, buffer, 0, buffer.length, null);
      if (bytesRead) fs.writeSync(output, buffer, 0, bytesRead);
    } while (bytesRead);
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

function copyReadableDirectory(source: string, destination: string) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyReadableDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyReadableFile(sourcePath, destinationPath);
    else throw new Error(`游玩包包含不支持的文件类型：${sourcePath}`);
  }
}

function libraryRoot() {
  const root = process.env.BOX_PLAY_LIBRARY_PATH;
  if (!root) throw new Error('游玩地图库未配置');
  return path.resolve(root);
}

function assertWorldId(id: string) {
  if (!idPattern.test(id)) throw new Error('地图 ID 不合法');
  return id;
}

function assertPermanentMapId(value: unknown, label = '永久地图 ID') {
  const permanentMapId = normalizeMapIdentity(value);
  if (!permanentMapId) throw new Error(`${label}无效`);
  return permanentMapId;
}

function assertPublicId(value: unknown) {
  const publicId = String(value || '').trim().toLowerCase();
  if (!idPattern.test(publicId)) {
    throw new Error('地图 ID 只能包含小写字母、数字和连字符，长度为 1–63 个字符');
  }
  return publicId;
}

function safeArchivePath(value: string) {
  const normalized = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('\\') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('游玩包包含不安全的文件路径');
  }
  return normalized;
}

async function extractArchive(archivePath: string, destination: string) {
  const extract = tarStream.extract();
  let expandedBytes = 0;
  let fileCount = 0;
  let extractionError: Error | undefined;

  extract.on('entry', (header, entry, next) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (error && !extractionError) extractionError = error;
      next(error);
    };
    try {
      const relative = safeArchivePath(header.name);
      if (relative.split('/').some((segment) => segment === '.DS_Store' || segment.startsWith('._'))) {
        entry.resume();
        entry.on('end', () => finish());
        return;
      }
      if (header.type !== 'file' && header.type !== 'directory') {
        entry.resume();
        finish(new Error('游玩包不能包含链接或特殊文件'));
        return;
      }
      fileCount += 1;
      expandedBytes += Number(header.size) || 0;
      if (fileCount > MAX_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
        entry.resume();
        finish(new Error('游玩包解压后的内容过大'));
        return;
      }

      const target = path.join(destination, ...relative.split('/'));
      if (!target.startsWith(`${destination}${path.sep}`)) {
        entry.resume();
        finish(new Error('游玩包包含不安全的文件路径'));
        return;
      }
      if (header.type === 'directory') {
        fs.mkdirSync(target, { recursive: true });
        entry.resume();
        entry.on('end', () => finish());
        return;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Docker Desktop maps host mode 0600 files to mode 0200 inside Linux
      // bind mounts, making imported worlds unreadable by the Play runtime.
      // Published assets are not secrets; use 0644 so host and container agree.
      const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o644 });
      output.on('error', finish);
      entry.on('error', finish);
      output.on('finish', () => finish());
      entry.pipe(output);
    } catch (error) {
      entry.resume();
      finish(error as Error);
    }
  });

  await pipeline(fs.createReadStream(archivePath), createGunzip(), extract);
  if (extractionError) throw extractionError;
}

function findWorldRoots(root: string) {
  const matches: string[] = [];
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (
      fs.existsSync(path.join(current.directory, 'manifest.json')) &&
      fs.existsSync(path.join(current.directory, 'data', 'project-state.json')) &&
      fs.existsSync(path.join(current.directory, 'data', 'blobs'))
    ) {
      matches.push(current.directory);
      continue;
    }
    if (current.depth >= 3) continue;
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return matches;
}

function validateWorld(root: string) {
  const rootEntries = fs.readdirSync(root);
  if (rootEntries.some((entry) => entry !== 'manifest.json' && entry !== 'data')) {
    throw new Error('游玩包的地图目录包含未发布的工程文件');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'project-state.json'), 'utf8'));
  const id = assertWorldId(String(manifest.id || ''));
  const publicId = assertPublicId(manifest.publicId || id);
  manifest.permanentMapId = assertPermanentMapId(manifest.permanentMapId);
  manifest.permanentMapGroupId = assertPermanentMapId(manifest.permanentMapGroupId, '永久地图组 ID');
  validateAssetDistribution(manifest.assetDistribution);
  if (!manifest.permissionHash || state.permissionHash !== manifest.permissionHash) {
    throw new Error('地图权限数据不完整或不一致');
  }
  if (!fs.statSync(path.join(root, 'data', 'blobs')).isDirectory()) {
    throw new Error('地图资源目录不存在');
  }
  return { id, publicId, manifest };
}

function validateAssetDistribution(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object') throw new Error('游玩包资源分发配置无效');
  const distribution = value as { formatVersion?: unknown; mode?: unknown; cdnBaseUrl?: unknown; pathTemplate?: unknown; hashes?: unknown };
  if (
    distribution.formatVersion !== 1 ||
    distribution.mode !== 'external-cdn' ||
    distribution.pathTemplate !== 'engine/m/{hash}' ||
    !Array.isArray(distribution.hashes) ||
    distribution.hashes.some((hash) => !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|[A-Za-z0-9_-]{43})$/.test(String(hash)))
  ) {
    throw new Error('游玩包资源分发配置无效');
  }
  try {
    const url = new URL(String(distribution.cdnBaseUrl || ''));
    if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:') {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('游玩包的外部资源地址不安全，只允许 HTTPS 地址');
  }
}

function validateMapGroupBundle(
  temporaryRoot: string,
  worlds: Array<{ id: string; manifest: Record<string, unknown>; root: string }>,
) {
  if (new Set(worlds.map((world) => world.id)).size !== worlds.length) {
    throw new Error('游玩包包含重复地图');
  }
  if (new Set(worlds.map((world) => world.manifest.permanentMapId)).size !== worlds.length) {
    throw new Error('游玩包包含重复的永久地图 ID');
  }
  const referenceOwners = new Map<string, string>();
  for (const world of worlds) {
    for (const reference of [world.id, assertPublicId(world.manifest.publicId || world.id)]) {
      const owner = referenceOwners.get(reference);
      if (owner && owner !== world.id) throw new Error('游玩包包含重复的地图 ID');
      referenceOwners.set(reference, world.id);
    }
  }
  if (worlds.length === 1) return;

  const descriptorPath = path.join(temporaryRoot, 'bundle.json');
  if (!fs.existsSync(descriptorPath)) throw new Error('多地图游玩包缺少地图组关系');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  if (
    descriptor?.formatVersion !== 1 ||
    descriptor?.type !== 'map-group-play-bundle' ||
    !Array.isArray(descriptor.members)
  ) {
    throw new Error('地图组游玩包描述无效');
  }
  const ids = worlds.map((world) => world.id).sort();
  const describedIds = descriptor.members.map((member: { id?: unknown }) => String(member?.id || '')).sort();
  if (JSON.stringify(ids) !== JSON.stringify(describedIds)) {
    throw new Error('地图组游玩包成员与关系描述不一致');
  }
  const mainMaps = worlds.filter((world) => world.manifest.mapRole === 'main');
  if (
    mainMaps.length !== 1 ||
    mainMaps[0].id !== descriptor.mainProjectId ||
    descriptor.permanentMapGroupId !== mainMaps[0].manifest.permanentMapId ||
    worlds.some((world) =>
      world.manifest.mapGroupId !== descriptor.mapGroupId ||
      world.manifest.permanentMapGroupId !== descriptor.permanentMapGroupId ||
      world.manifest.mainProjectId !== descriptor.mainProjectId ||
      (world.id === descriptor.mainProjectId
        ? world.manifest.mapRole !== 'main'
        : world.manifest.mapRole !== 'submap'),
    )
  ) {
    throw new Error('地图组游玩包主副地图关系无效');
  }
}

function safeBlobFile(root: string, hash: unknown) {
  const name = String(hash || '').trim();
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new Error('资源索引包含不安全的内容标识');
  }
  const canonicalName = (() => {
    const match = name.match(
      /^((?:Qm[1-9A-HJ-NP-Za-km-z]{44})|(?:[A-Za-z0-9_-]{43}))\.(?:png|jpe?g|webp|gif|bmp|avif|mp3|wav|ogg|m4a|aac|flac|lut)$/i,
    );
    return match?.[1];
  })();
  for (const candidate of canonicalName ? [name, canonicalName] : [name]) {
    const target = path.join(root, 'data', 'blobs', candidate);
    if (fs.statSync(target, { throwIfNoEntry: false })?.isFile()) return target;
  }
  throw new Error(`资源文件不存在：${name.slice(0, 80)}`);
}

function resolveReviewResourceFile(
  root: string,
  hash: unknown,
  kind: PlayBundleReviewResource['kind'],
) {
  const indexedFiles = new Set<string>();
  let file = safeBlobFile(root, hash);
  indexedFiles.add(path.basename(file));

  // Boxes picture assets point at a small JSON descriptor containing the
  // dimensions and the actual image blob hash. Cloud-migrated projects retain
  // this layout, so the review endpoint must unwrap it instead of serving the
  // descriptor itself with an image Content-Type.
  if (kind === 'image') {
    const stat = fs.statSync(file);
    if (stat.size <= 64 * 1024) {
      try {
        const descriptor = JSON.parse(fs.readFileSync(file, 'utf8')) as { hash?: unknown };
        if (typeof descriptor?.hash === 'string' && descriptor.hash) {
          file = safeBlobFile(root, descriptor.hash);
          indexedFiles.add(path.basename(file));
        }
      } catch {
        // Direct image blobs are binary and intentionally fail JSON parsing.
      }
    }
  }

  return { file, indexedFiles };
}

function readReviewJsonBlob(root: string, hash: unknown, label: string) {
  const target = safeBlobFile(root, hash);
  const size = fs.statSync(target).size;
  if (size > 8 * 1024 * 1024) throw new Error(`${label}过大`);
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`${label}无法读取`);
  }
}

function resourceKind(name: string, fallback: PlayBundleReviewResource['kind']) {
  const extension = path.extname(name).toLowerCase();
  if (['.js', '.jsx', '.ts', '.tsx', '.json', '.mjs', '.cjs'].includes(extension)) return 'script';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'].includes(extension)) return 'image';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(extension)) return 'audio';
  if (['.vb', '.vox', '.glb', '.gltf', '.obj'].includes(extension)) return 'model';
  return fallback;
}

function resourceMimeType(name: string, kind: PlayBundleReviewResource['kind']) {
  const extension = path.extname(name).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
  };
  return types[extension] || (kind === 'script' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

function collectReviewResources(world: ValidatedPlayWorld, prefix: string) {
  const resources = new Map<string, { path: string; resource: PlayBundleReviewResource }>();
  const warnings: string[] = [];
  const indexedHashes = new Set<string>();
  let sequence = 0;
  const addIndex = (
    index: unknown,
    fallback: PlayBundleReviewResource['kind'],
  ) => {
    if (!index || typeof index !== 'object' || Array.isArray(index)) return;
    for (const [name, candidate] of Object.entries(index)) {
      const asset = candidate as { hash?: unknown; type?: unknown; isClient?: unknown };
      const hash = String(asset?.hash || '').trim();
      if (!hash) continue;
      try {
        const kind = resourceKind(name, fallback);
        const resolved = resolveReviewResourceFile(world.root, hash, kind);
        const file = resolved.file;
        const bytes = fs.statSync(file).size;
        const id = `${prefix}-${sequence++}`;
        const resource: PlayBundleReviewResource = {
          id,
          worldId: world.id,
          name: String(name).slice(0, 300),
          kind,
          scriptTarget:
            kind === 'script'
              ? Number(asset.type) === 7 || asset.isClient === true
                ? 'client'
                : 'server'
              : undefined,
          mimeType: resourceMimeType(name, kind),
          bytes,
          previewable:
            (kind === 'script' && bytes <= MAX_REVIEW_CODE_BYTES) ||
            ((kind === 'image' || kind === 'audio') && bytes <= MAX_REVIEW_RESOURCE_BYTES),
        };
        indexedHashes.add(hash);
        for (const indexedHash of resolved.indexedFiles) indexedHashes.add(indexedHash);
        resources.set(id, { path: file, resource });
      } catch (error) {
        warnings.push(`${name}：${(error as Error).message}`);
      }
    }
  };

  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(world.root, 'data', 'project-state.json'), 'utf8'),
    );
    const permission = readReviewJsonBlob(world.root, state.permissionHash, '权限索引');
    const versionControl = readReviewJsonBlob(
      world.root,
      permission.versionControl,
      '版本索引',
    );
    const branches = versionControl.branches as { master?: { headHash?: unknown } } | undefined;
    const project = readReviewJsonBlob(
      world.root,
      branches?.master?.headHash,
      '地图资源索引',
    );
    for (const [key, fallback] of [
      ['scriptAssets', 'script'],
      ['pictureAssets', 'image'],
      ['audioAssets', 'audio'],
      ['assets', 'other'],
    ] as const) {
      if (!project[key]) continue;
      addIndex(readReviewJsonBlob(world.root, project[key], `${key} 索引`), fallback);
    }
  } catch (error) {
    warnings.push(`地图“${world.manifest.projectName || world.id}”的资源索引不完整：${(error as Error).message}`);
  }

  const blobRoot = path.join(world.root, 'data', 'blobs');
  const blobFiles = fs.readdirSync(blobRoot, { withFileTypes: true }).filter((entry) => entry.isFile());
  return {
    resources,
    warnings,
    blobCount: blobFiles.length,
    unindexedBlobCount: Math.max(0, blobFiles.length - indexedHashes.size),
  };
}

// Numeric version segments avoid lexical ordering (1.10 must be newer than 1.9).
// Short versions such as v1 are treated as 1.0.0; prereleases precede releases.
function comparePlayVersions(incoming: string, installed: string) {
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+(?:\.\d+)*)(?:-([a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*))?$/i);
    if (!match) throw new Error(`版本号“${value}”无法比较，请使用数字版本号，如 1.0.0`);
    return { core: match[1].split('.'), pre: match[2]?.split('.') };
  };
  const numeric = (left: string, right: string) => {
    const a = left.replace(/^0+(?=\d)/, '');
    const b = right.replace(/^0+(?=\d)/, '');
    return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length < b.length ? -1 : 1;
  };
  const a = parse(incoming);
  const b = parse(installed);
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const order = numeric(a.core[i] || '0', b.core[i] || '0');
    if (order) return order;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const left = a.pre[i];
    const right = b.pre[i];
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    const order = leftNumeric && rightNumeric ? numeric(left, right)
      : leftNumeric !== rightNumeric ? (leftNumeric ? -1 : 1)
      : left < right ? -1 : left > right ? 1 : 0;
    if (order) return order;
  }
  return 0;
}

function validateInstallConflicts(validated: ValidatedPlayWorld[]) {
  const root = libraryRoot();
  fs.mkdirSync(root, { recursive: true });
  const installedWorlds = getPlayWorlds();
  const replacements = new Map<string, (typeof installedWorlds)[number]>();
  for (const world of validated) {
    const existing = installedWorlds.find((item) => item.permanentMapId === world.manifest.permanentMapId);
    if (!existing) continue;
    const order = comparePlayVersions(String(world.manifest.version || ''), existing.version);
    if (order <= 0) {
      throw new Error(`地图“${existing.name}”导入版本 ${world.manifest.version} ${order === 0 ? '与当前版本相同' : '低于当前版本'}（${existing.version}），未覆盖`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, existing.id, 'manifest.json'), 'utf8'));
    if (manifest.permanentMapGroupId !== world.manifest.permanentMapGroupId || existing.mapRole !== world.manifest.mapRole) {
      throw new Error(`地图“${existing.name}”的地图组关系与已安装版本不一致`);
    }
    replacements.set(world.id, existing);
  }
  const ids = new Set<string>();
  const references = new Map<string, string>();
  for (const world of validated) {
    const existing = replacements.get(world.id);
    const id = existing?.id || world.id;
    const publicId = existing?.publicId || world.publicId;
    if (ids.has(id)) throw new Error('游玩包包含重复地图');
    ids.add(id);
    if (!existing && fs.existsSync(path.join(root, id))) {
      throw new Error(`同 ID 地图“${world.manifest.projectName || id}”已经存在，地图 ID 不一致，无法覆盖`);
    }
    for (const reference of [id, publicId]) {
      if (installedWorlds.some((item) => item.id !== existing?.id && (item.id === reference || item.publicId === reference)) ||
          (references.has(reference) && references.get(reference) !== id)) {
        throw new Error(`地图 ID“${reference}”已经被其他地图使用`);
      }
      references.set(reference, id);
    }
  }
  return { root, replacements };
}

async function preparePlayBundle(archivePath: string) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-play-review-'));
  try {
    await extractArchive(archivePath, temporaryRoot);
    const candidates = findWorldRoots(temporaryRoot);
    if (!candidates.length) throw new Error('游玩包中未找到有效地图');
    const worlds = candidates.map((candidate) => ({
      ...validateWorld(candidate),
      root: candidate,
    }));
    validateMapGroupBundle(temporaryRoot, worlds);
    const { replacements } = validateInstallConflicts(worlds);
    return { temporaryRoot, worlds, replacements };
  } catch (error) {
    cleanupDirectoryQuietly(temporaryRoot);
    throw error;
  }
}

function installPreparedPlayBundle(validated: ValidatedPlayWorld[]) {
  // Recheck at confirmation: another import may have upgraded a reviewed map.
  const { root, replacements } = validateInstallConflicts(validated);
  const nonce = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const remapId = (id: string) => replacements.get(id)?.id || id;
  const staging = new Map(
    validated.map((world) => [remapId(world.id), path.join(root, `.${remapId(world.id)}-importing-${nonce}`)]),
  );
  const backups = new Map<string, string>();
  const installed: string[] = [];
  try {
    for (const world of validated) {
      const existing = replacements.get(world.id);
      const id = remapId(world.id);
      const stage = staging.get(id)!;
      if (existing) {
        // Retain runtime storage and content-addressed blobs used by player data.
        copyReadableDirectory(path.join(root, id, 'data'), path.join(stage, 'data'));
      }
      copyReadableDirectory(world.root, stage);
      const manifest = { ...world.manifest, id };
      manifest.mainProjectId = remapId(String(manifest.mainProjectId || world.id));
      manifest.mapGroupId = remapId(String(manifest.mapGroupId || world.id));
      if (existing) {
        const previous = JSON.parse(fs.readFileSync(path.join(root, id, 'manifest.json'), 'utf8'));
        manifest.publicId = existing.publicId;
        manifest.playEnabled = existing.playEnabled;
        manifest.mapGroupId = previous.mapGroupId;
        if (previous.installedAt) manifest.installedAt = previous.installedAt;
      }
      fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
    }
    for (const world of validated) {
      const id = remapId(world.id);
      if (replacements.has(world.id)) {
        const backup = path.join(root, `.${id}-backup-${nonce}`);
        fs.renameSync(path.join(root, id), backup);
        backups.set(id, backup);
      }
      fs.renameSync(staging.get(id)!, path.join(root, id));
      installed.push(id);
    }
  } catch (error) {
    for (const target of staging.values()) cleanupDirectoryQuietly(target);
    for (const id of installed) removeDirectoryWithRetry(path.join(root, id));
    for (const [id, backup] of backups) fs.renameSync(backup, path.join(root, id));
    if ((error as NodeJS.ErrnoException).code === 'EROFS' || (error as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('地图目录不可写，请检查 Play 地图库挂载权限');
    }
    throw error;
  }
  for (const backup of backups.values()) cleanupDirectoryQuietly(backup);
  const installedWorlds = getPlayWorlds().filter((world) => installed.includes(world.id));
  const mainProjectId = remapId(String(validated[0].manifest.mainProjectId || validated[0].id));
  return {
    world: installedWorlds.find((world) => world.id === mainProjectId) || installedWorlds[0],
    worlds: installedWorlds,
    mapCount: installedWorlds.length,
    mainProjectId,
  };
}

function purgeExpiredReviews() {
  const now = Date.now();
  for (const [id, session] of reviewSessions) {
    if (session.expiresAt > now) continue;
    reviewSessions.delete(id);
    cleanupDirectoryQuietly(session.temporaryRoot);
  }
}

function makeReviewRoom() {
  purgeExpiredReviews();
  while (reviewSessions.size >= MAX_ACTIVE_REVIEWS) {
    const oldest = [...reviewSessions.entries()].sort(
      ([, left], [, right]) => left.expiresAt - right.expiresAt,
    )[0];
    if (!oldest) return;
    reviewSessions.delete(oldest[0]);
    cleanupDirectoryQuietly(oldest[1].temporaryRoot);
  }
}

function reviewSession(id: string) {
  purgeExpiredReviews();
  const session = reviewSessions.get(id);
  if (!session) throw new Error('游玩包审查会话不存在或已过期，请重新选择文件');
  return session;
}

export async function createPlayBundleReview(archivePath: string): Promise<PlayBundleReview> {
  makeReviewRoom();
  const prepared = await preparePlayBundle(archivePath);
  const id = randomBytes(32).toString('base64url');
  const resources = new Map<string, { path: string; resource: PlayBundleReviewResource }>();
  const warnings: string[] = [];
  const { replacements } = prepared;
  for (const world of prepared.worlds) {
    const previous = replacements.get(world.id);
    if (previous) warnings.push(`“${previous.name}”将更新：${previous.version} → ${world.manifest.version}`);
  }
  let blobCount = 0;
  let unindexedBlobCount = 0;
  for (const [index, world] of prepared.worlds.entries()) {
    const collected = collectReviewResources(world, `r${index}`);
    for (const [resourceId, value] of collected.resources) resources.set(resourceId, value);
    warnings.push(...collected.warnings);
    blobCount += collected.blobCount;
    unindexedBlobCount += collected.unindexedBlobCount;
  }
  const expiresAt = Date.now() + REVIEW_TTL_MS;
  const review: PlayBundleReview = {
    id,
    expiresAt: new Date(expiresAt).toISOString(),
    mapCount: prepared.worlds.length,
    totalBytes: prepared.worlds.reduce((total, world) => total + directoryBytes(world.root), 0),
    blobCount,
    unindexedBlobCount,
    worlds: prepared.worlds.map((world) => ({
      id: world.id,
      name: String(world.manifest.projectName || world.id),
      author: String(world.manifest.author || ''),
      description: String(world.manifest.description || ''),
      version: String(world.manifest.version || ''),
      mapRole: world.manifest.mapRole === 'submap' ? 'submap' : 'main',
      mainProjectId: String(world.manifest.mainProjectId || world.id),
    })),
    resources: [...resources.values()].map(({ resource }) => resource),
    warnings: warnings.slice(0, 100),
  };
  reviewSessions.set(id, { review, temporaryRoot: prepared.temporaryRoot, worlds: prepared.worlds, resources, expiresAt });
  return review;
}

export function getPlayBundleReviewResource(reviewId: string, resourceId: string) {
  const session = reviewSession(reviewId);
  const entry = session.resources.get(resourceId);
  if (!entry) throw new Error('审查资源不存在');
  if (!entry.resource.previewable) throw new Error('该资源过大或不支持在线预览');
  return entry;
}

export function cancelPlayBundleReview(reviewId: string) {
  const session = reviewSessions.get(reviewId);
  if (!session) return;
  reviewSessions.delete(reviewId);
  cleanupDirectoryQuietly(session.temporaryRoot);
}

export function confirmPlayBundleReview(reviewId: string) {
  const session = reviewSession(reviewId);
  reviewSessions.delete(reviewId);
  try {
    return installPreparedPlayBundle(session.worlds);
  } finally {
    cleanupDirectoryQuietly(session.temporaryRoot);
  }
}

export async function importPlayBundle(archivePath: string) {
  const prepared = await preparePlayBundle(archivePath);
  try {
    return installPreparedPlayBundle(prepared.worlds);
  } finally {
    cleanupDirectoryQuietly(prepared.temporaryRoot);
  }
}

export function deletePlayWorld(id: string) {
  const safeId = assertWorldId(id);
  const installed = getPlayWorlds();
  const target = installed.find((world) => world.id === safeId);
  if (!target) throw new Error('地图不存在');
  // 主地图是地图组的入口。删除它时必须一并删除所有副地图，避免留下
  // 无法正常管理、也无法还原关系的孤立地图。
  const targets = target.mapRole === 'main'
    ? installed.filter((world) => (world.mapGroupId || world.mainProjectId || world.id) === (target.mapGroupId || target.id))
    : [target];
  try {
    for (const world of targets) {
      fs.rmSync(path.join(libraryRoot(), world.id), { recursive: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EROFS' || (error as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('地图目录不可写，请检查 Play 地图库挂载权限');
    }
    throw error;
  }
  return targets.map((world) => world.id);
}

export type PlayWorldResourceStatus = {
  id: string;
  bytes: number;
  importedAt: string;
};

function directoryBytes(root: string) {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

/**
 * 资源统计只供已通过服主验证的管理界面按需读取，不加入 getPlayWorlds，
 * 避免普通玩家打开首页时遍历大型资源目录。
 */
export function getPlayWorldResourceStatuses(): PlayWorldResourceStatus[] {
  const root = libraryRoot();
  return getPlayWorlds().map((world) => {
    const directory = path.join(root, world.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const directoryStat = fs.statSync(directory);
    return {
      id: world.id,
      bytes: directoryBytes(directory),
      importedAt: String(manifest.installedAt || directoryStat.birthtime.toISOString()),
    };
  });
}

export function updatePlayWorld(id: string, patch: Record<string, unknown>) {
  const protectedFields = ['name', 'author', 'description', 'cover', 'loadingCover'];
  if (protectedFields.some((field) => Object.prototype.hasOwnProperty.call(patch, field))) {
    throw new Error('游玩端不允许修改地图封面、标题、作者或简介');
  }
  const safeId = assertWorldId(id);
  const manifestPath = path.join(libraryRoot(), safeId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('地图不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const publicId = typeof patch.publicId === 'string'
    ? assertPublicId(patch.publicId)
    : assertPublicId(manifest.publicId || safeId);
  if (getPlayWorlds().some(
    (world) => world.id !== safeId && (world.id === publicId || world.publicId === publicId),
  )) {
    throw new Error(`地图 ID“${publicId}”已经被其他地图使用`);
  }
  manifest.publicId = publicId;
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EROFS' || (error as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error('地图目录不可写，请检查 Play 地图库挂载权限');
    }
    throw error;
  }
  return getPlayWorlds().find((world) => world.id === safeId);
}

export function setPlayWorldGroupAvailability(id: string, playEnabled: boolean) {
  const safeId = assertWorldId(id);
  const installed = getPlayWorlds();
  const target = installed.find((world) => world.id === safeId);
  if (!target) throw new Error('地图不存在');
  const groupId = target.mapGroupId || target.mainProjectId || target.id;
  const members = installed.filter((world) => (world.mapGroupId || world.mainProjectId || world.id) === groupId);
  for (const world of members) {
    const manifestPath = path.join(libraryRoot(), world.id, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.playEnabled = playEnabled;
    const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryPath, manifestPath);
  }
  return getPlayWorlds().filter((world) => (world.mapGroupId || world.mainProjectId || world.id) === groupId);
}

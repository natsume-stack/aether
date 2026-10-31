import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

type StoredModel = {
  animated: boolean;
  createdAt: string;
  creativeMode: number;
  fileHash: string;
  modelDescription: string;
  modelFileHash: string;
  modelFileUUID: string;
  modelFileUrl: string;
  modelId: number;
  modelName: string;
  modelPreviewHash: string;
  modelPreviewUUID: string;
  modelPreviewUrl: string;
  modelType: number;
  projectFileHash: string;
  projectFileUUID: string;
  projectFileUrl: string;
  updatedAt: string;
  /** Monotonic per-model write counter used by the editor live-reload channel. */
  revision: number;
  /** Actor of the most recent revision bump (`cli:...` or `web-...`). */
  lastEditActor: string;
  mapId?: number;
  snapshots: Array<Record<string, unknown>>;
};

type StoreIndex = {
  formatVersion: 1;
  nextModelId: number;
  nextSnapshotId: number;
  models: StoredModel[];
  blobTypes: Record<string, string>;
  defaultSkinByMap?: Record<string, number>;
};

const dataRoot = path.resolve(
  process.env.VOXA_DATA_PATH || (process.env.NODE_ENV === 'production'
    ? path.join(process.cwd(), 'data')
    : path.resolve(process.cwd(), '../..', process.env.BOX_DEV_DATA_DIRECTORY || '.local-data', 'apps/voxa/data')),
);
const blobsRoot = path.join(dataRoot, 'blobs');
const indexPath = path.join(dataRoot, 'models.json');

let writeQueue = Promise.resolve();

function emptyIndex(): StoreIndex {
  return {
    formatVersion: 1,
    nextModelId: 1,
    nextSnapshotId: 1,
    models: [],
    blobTypes: {},
    defaultSkinByMap: {},
  };
}

function ensureStore() {
  fs.mkdirSync(blobsRoot, { recursive: true });
  if (!fs.existsSync(indexPath)) {
    writeIndex(emptyIndex());
  }
}

function readIndex(): StoreIndex {
  ensureStore();
  try {
    const value = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (value?.formatVersion !== 1 || !Array.isArray(value.models)) {
      throw new Error('unsupported VOXA local store format');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyIndex();
    throw error;
  }
}

function writeIndex(index: StoreIndex) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const temporary = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(temporary, indexPath);
}

function mutate<T>(operation: (index: StoreIndex) => T | Promise<T>) {
  const result = writeQueue.then(async () => {
    const index = readIndex();
    const value = await operation(index);
    writeIndex(index);
    return value;
  });
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

const alphabet =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += alphabet[0];
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += alphabet[digits[index]];
  }
  return output;
}

function contentHash(data: Buffer) {
  const digest = crypto.createHash('sha256').update(data).digest();
  return base58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}

function blobURL(hash: string) {
  return hash ? `/api/local/blobs/${encodeURIComponent(hash)}` : '';
}

function publicModel(model: StoredModel) {
  const { snapshots: _snapshots, ...value } = model;
  // Records written before revisions existed still need to look like revision
  // 0 to clients and the SSE channel.
  return {
    ...value,
    revision: model.revision || 0,
    lastEditActor: model.lastEditActor || '',
  };
}

export function matchesMapFilter(
  model: Pick<StoredModel, 'mapId' | 'modelType'>,
  mapId?: number,
) {
  // An unscoped query is the server-wide local work center. Map-scoped VOXA
  // records are editor adapters for project models/skins and must only be
  // visible when that exact map asks for them.
  if (mapId === undefined) return model.mapId === undefined;
  return model.mapId === mapId;
}

export async function storeBlob(data: Buffer, contentType = '') {
  const hash = contentHash(data);
  const target = path.join(blobsRoot, hash);
  if (!fs.existsSync(target)) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(blobsRoot, { recursive: true });
    fs.writeFileSync(temporary, data);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (!fs.existsSync(target)) throw error;
    }
  }
  await mutate((index) => {
    if (contentType) index.blobTypes[hash] = contentType;
  });
  return hash;
}

export function getBlob(hash: string) {
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(hash)) return null;
  const target = path.join(blobsRoot, hash);
  if (!fs.existsSync(target)) return null;
  const index = readIndex();
  return {
    data: fs.readFileSync(target),
    contentType: index.blobTypes[hash] || 'application/octet-stream',
  };
}

export async function saveModel(input: Record<string, any>) {
  return mutate((index) => {
    const now = new Date().toISOString();
    const requestedId = Number(input.modelId || 0);
    let model = requestedId
      ? index.models.find((item) => item.modelId === requestedId)
      : undefined;
    if (!model) {
      model = {
        animated: false,
        createdAt: now,
        creativeMode: Number(input.creativeMode || 1),
        fileHash: '',
        modelDescription: '',
        modelFileHash: '',
        modelFileUUID: '',
        modelFileUrl: '',
        modelId: index.nextModelId++,
        modelName: '',
        modelPreviewHash: '',
        modelPreviewUUID: '',
        modelPreviewUrl: '',
        modelType: Number(input.modelType || 0),
        projectFileHash: '',
        projectFileUUID: '',
        projectFileUrl: '',
        updatedAt: now,
        revision: 0,
        lastEditActor: '',
        snapshots: [],
      };
      index.models.push(model);
    }

    model.animated = Boolean(input.animated);
    model.creativeMode = Number(input.creativeMode || model.creativeMode || 1);
    model.modelName = String(input.modelName || model.modelName || `模型 ${model.modelId}`)
      .trim()
      .slice(0, 100);
    model.modelDescription = String(
      input.modelDescription ?? model.modelDescription ?? '',
    ).trim().slice(0, 500);
    model.modelType = Number(input.modelType ?? model.modelType ?? 0);
    model.modelFileHash = String(input.modelFileHash || model.modelFileHash);
    model.modelFileUUID = model.modelFileHash;
    model.modelFileUrl = blobURL(model.modelFileHash);
    model.fileHash = model.modelFileHash;
    model.projectFileHash = String(
      input.modelProjectFileHash || input.projectFileHash || model.projectFileHash,
    );
    model.projectFileUUID = model.projectFileHash;
    model.projectFileUrl = blobURL(model.projectFileHash);
    model.modelPreviewHash = String(
      input.modelPreviewFileHash || input.modelPreviewHash || model.modelPreviewHash,
    );
    model.modelPreviewUUID = model.modelPreviewHash;
    model.modelPreviewUrl = blobURL(model.modelPreviewHash);
    model.updatedAt = now;
    // Every committed payload is a new revision so other editor tabs can
    // detect the write through the SSE feed, not only CLI `replaceModelPayload`.
    model.revision = (model.revision || 0) + 1;
    model.lastEditActor = String(input.actor ?? '').trim().slice(0, 120);
    if (input.mapId !== undefined) model.mapId = Number(input.mapId);

    model.snapshots.unshift({
      snapshotId: index.nextSnapshotId++,
      createdAt: now,
      autoSave: Boolean(input.autoSave),
      modelFileHash: model.modelFileHash,
      modelFileUUID: model.modelFileHash,
      modelPreviewHash: model.modelPreviewHash,
      modelPreviewUUID: model.modelPreviewHash,
      projectFileHash: model.projectFileHash,
      projectFileUUID: model.projectFileHash,
    });
    model.snapshots = model.snapshots.slice(0, 100);
    return publicModel(model);
  });
}

/**
 * Atomically replaces the blob graph of an existing model and bumps its
 * revision. Blobs are content addressed and must already be stored by the
 * caller; this function only flips the index in one queued write.
 */
export async function replaceModelPayload(input: {
  id: number;
  actor: string;
  projectFileHash: string;
  modelFileHash: string;
  modelPreviewHash?: string;
}) {
  return mutate((index) => {
    const model = index.models.find((item) => item.modelId === input.id);
    if (!model) return null;

    const now = new Date().toISOString();
    model.projectFileHash = input.projectFileHash;
    model.projectFileUUID = input.projectFileHash;
    model.projectFileUrl = blobURL(input.projectFileHash);
    model.modelFileHash = input.modelFileHash;
    model.modelFileUUID = input.modelFileHash;
    model.modelFileUrl = blobURL(input.modelFileHash);
    model.fileHash = input.modelFileHash;
    if (input.modelPreviewHash !== undefined) {
      model.modelPreviewHash = input.modelPreviewHash;
      model.modelPreviewUUID = input.modelPreviewHash;
      model.modelPreviewUrl = blobURL(input.modelPreviewHash);
    }
    model.updatedAt = now;
    model.revision = (model.revision || 0) + 1;
    model.lastEditActor = input.actor;

    model.snapshots.unshift({
      snapshotId: index.nextSnapshotId++,
      createdAt: now,
      autoSave: false,
      modelFileHash: model.modelFileHash,
      modelFileUUID: model.modelFileHash,
      modelPreviewHash: model.modelPreviewHash,
      modelPreviewUUID: model.modelPreviewHash,
      projectFileHash: model.projectFileHash,
      projectFileUUID: model.projectFileHash,
    });
    model.snapshots = model.snapshots.slice(0, 100);
    return publicModel(model);
  });
}

export function getModel(id: number) {
  const model = readIndex().models.find((item) => item.modelId === id);
  return model ? publicModel(model) : null;
}

export function listModels(filters: {
  modelType?: number;
  mapId?: number;
  creativeMode?: number;
  modelName?: string;
} = {}) {
  const searchName = String(filters.modelName || '').trim().toLocaleLowerCase();
  return readIndex()
    .models.filter(
      (model) =>
        (filters.modelType === undefined || model.modelType === filters.modelType) &&
        (filters.creativeMode === undefined ||
          model.creativeMode === filters.creativeMode) &&
        (!searchName || model.modelName.toLocaleLowerCase().includes(searchName)) &&
        matchesMapFilter(model, filters.mapId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(publicModel);
}

export function getSnapshots(id: number, autoSave = false) {
  const model = readIndex().models.find((item) => item.modelId === id);
  if (!model) return null;
  return model.snapshots.filter(
    (snapshot) => Boolean(snapshot.autoSave) === autoSave,
  );
}

export async function deleteModel(id: number) {
  return mutate((index) => {
    const before = index.models.length;
    index.models = index.models.filter((item) => item.modelId !== id);
    for (const [mapId, skinId] of Object.entries(index.defaultSkinByMap || {})) {
      if (skinId === id) delete index.defaultSkinByMap?.[mapId];
    }
    return index.models.length !== before;
  });
}

export type DefaultSkinScope = string | number;

export function getDefaultSkin(scope: DefaultSkinScope) {
  const index = readIndex();
  const id = index.defaultSkinByMap?.[String(scope)] || 0;
  const model = index.models.find(
    (item) => item.modelId === id && item.creativeMode === 2,
  );
  return model ? publicModel(model) : null;
}

export async function setDefaultSkin(scope: DefaultSkinScope, skinId?: number) {
  return mutate((index) => {
    index.defaultSkinByMap ||= {};
    if (!skinId) {
      delete index.defaultSkinByMap[String(scope)];
      return true;
    }
    const skin = index.models.find(
      (item) => item.modelId === skinId && item.creativeMode === 2,
    );
    if (!skin) return false;
    index.defaultSkinByMap[String(scope)] = skinId;
    return true;
  });
}

export async function updateModelInfo(
  id: number,
  input: { modelName?: string; modelDescription?: string },
) {
  return mutate((index) => {
    const model = index.models.find((item) => item.modelId === id);
    if (!model) return null;
    const name = String(input.modelName ?? '').trim().slice(0, 100);
    if (name) model.modelName = name;
    model.modelDescription = String(
      input.modelDescription ?? model.modelDescription ?? '',
    ).trim().slice(0, 500);
    model.updatedAt = new Date().toISOString();
    return publicModel(model);
  });
}

export function getVoxaDataRoot() {
  ensureStore();
  return dataRoot;
}

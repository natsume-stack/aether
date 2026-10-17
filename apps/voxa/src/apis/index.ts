import { ApiClient, Permissions } from '@box/apis';

import { getToken } from '../utils/token';

const unauthorizedHandlers = new Set<() => void>();

function notifyUnauthorized() {
  for (const handler of unauthorizedHandlers) handler();
}

function apiClient(baseUrl = '') {
  const token = getToken();
  return new ApiClient({
    baseUrl,
    ...(token ? { headers: { Authorization: token } } : {}),
    fetch: async (request) => {
      const response = await globalThis.fetch(request);
      if (response.status === 401) notifyUnauthorized();
      return response;
    },
    defaultErrorMessage: '本地 VOXA 请求失败',
  });
}

export function onApiUnauthorized(handler: () => void) {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}

function isEmbeddedInEngine() {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('parentType') === 'engine';
}

export function resolveParentEditStorageURL(
  search: string,
  referrer: string,
  currentHref: string,
  hash = '',
  ancestorOrigin = '',
) {
  try {
    const currentURL = new URL(currentHref);
    const explicitOrigin = new URLSearchParams(search).get('storageOrigin');
    const candidate =
      explicitOrigin ||
      (referrer ? new URL(referrer).origin : '') ||
      ancestorOrigin;
    if (!candidate) return '';
    const storageOrigin = new URL(candidate);
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    const sameLocalHost =
      loopbackHosts.has(storageOrigin.hostname.toLowerCase()) &&
      loopbackHosts.has(currentURL.hostname.toLowerCase());
    if (
      !['http:', 'https:'].includes(storageOrigin.protocol) ||
      (storageOrigin.hostname !== currentURL.hostname && !sameLocalHost)
    ) {
      return '';
    }
    const basePath = storageOrigin.pathname.replace(/\/$/, '') || '/runtime/edit';
    const encodedHash = hash ? `/${encodeURIComponent(hash)}` : '';
    return `${storageOrigin.origin}${basePath}/block${encodedHash}`;
  } catch {
    return '';
  }
}

function parentEditStorageURL(hash = '') {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  return resolveParentEditStorageURL(
    window.location.search,
    document.referrer,
    window.location.href,
    hash,
    window.location.ancestorOrigins?.[0] || '',
  );
}

async function storeLocalBlob(file: Blob) {
  const result = await apiClient().postApiLocalBlobRaw({
    body: file as never,
    bodySerializer: (body) => body as unknown as BodyInit,
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
  const data = (result.data || result.error || {}) as { hash?: string; message?: string };
  if (!result.response.ok) throw new Error(data.message || '本地文件保存失败');
  return String(data.hash || '');
}

function parentStorageApi() {
  const storageURL = parentEditStorageURL();
  if (!storageURL) throw new Error('无法识别创作端本地存储地址');
  return apiClient(storageURL.replace(/\/block$/, ''));
}

async function storeBlob(file?: Blob) {
  if (!file) throw new Error('请选择要保存的文件');
  const localHash = await storeLocalBlob(file);
  if (!isEmbeddedInEngine()) return localHash;

  const result = await parentStorageApi().postBlockRaw({
    body: file as never,
    bodySerializer: (body) => body as unknown as BodyInit,
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
  if (!result.response.ok) throw new Error('保存到当前地图失败');
  const projectHash = String(result.data || '').trim();
  if (projectHash !== localHash) {
    throw new Error('VOXA 与地图存储生成了不同的文件哈希');
  }
  return projectHash;
}

async function retrieveBlob(hash: string, config: Record<string, unknown> = {}) {
  const parseAs = config.responseType === 'arraybuffer' ? 'arrayBuffer' : undefined;
  const local = await apiClient().getApiLocalBlobsHashRaw({
    params: { path: { hash } },
    ...(parseAs ? { parseAs } : {}),
  });
  if (local.response.ok) return { data: local.data };
  if (!isEmbeddedInEngine() || local.response.status !== 404) {
    const details = local.error as { message?: string } | undefined;
    throw new Error(details?.message || `读取本地文件失败（HTTP ${local.response.status}）`);
  }
  const parent = await parentStorageApi().getBlockHashRaw({
    params: { path: { hash } },
    ...(parseAs ? { parseAs } : {}),
  });
  if (!parent.response.ok) throw new Error(`读取地图文件失败（HTTP ${parent.response.status}）`);
  return { data: parent.data };
}

async function saveModel(input: Record<string, unknown>) {
  return apiClient().postApiLocalModels({ body: input });
}

export const apis = {
  createra: {
    async getUserByTokenUsingGet() {
      return { avatar: '', userId: 1, permission: 0, language: 'zh-CN' };
    },
    async setUserLanguage() {
      return true;
    },
  },
  model: {
    async getModelDetailUsingGet(modelId: number, params: Record<string, unknown> = {}) {
      return apiClient().getApiLocalModelsId({
        ...params,
        params: { path: { id: String(modelId) } },
      });
    },
    async getSnapshotsUsingGet(
      modelId: number,
      query: { autoSave: boolean },
      params: Record<string, unknown> = {},
    ) {
      return apiClient().getApiLocalModelsIdSnapshots({
        ...params,
        params: {
          path: { id: String(modelId) },
          query: { autoSave: String(query.autoSave) },
        },
      });
    },
    async saveModelUsingPostV1(input: Record<string, unknown>) {
      return saveModel(input);
    },
    async saveProjectSharedModelUsingPost(input: Record<string, unknown>) {
      return saveModel(input);
    },
    async saveSharedSkinUsingPost(input: Record<string, unknown>) {
      return saveModel(input);
    },
  },
  models: {
    async getModelsUsingGetV2(query: Record<string, unknown>) {
      const parameters = Object.fromEntries(
        Object.entries(query)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)]),
      );
      return apiClient().getApiLocalModels({ params: { query: parameters } });
    },
  },
  upload: {
    async fileUploadPost({ file }: { file?: Blob }) {
      return storeBlob(file);
    },
  },
  content: {
    request<T>({ url, ...config }: { url: string } & Record<string, unknown>) {
      return retrieveBlob(url, config) as Promise<{ data: T }>;
    },
  },
  openApisAuth: {
    async checkPermission() {
      return [
        Permissions.UserVoxelEditor,
        Permissions.UserVoxelEditorMultiObj,
        Permissions.UserVoxelEditorMultiObjAnimation,
      ];
    },
  },
  openApisContent: {
    async getContentInfoByToken(value: string) {
      const modelId = Number(value);
      const model = await apiClient().getApiLocalModelsId({
        params: { path: { id: String(modelId) } },
      });
      return {
        contentType: 1,
        modelInfo: model,
      };
    },
  },
  openApisUser: {
    async authToCookie(_input?: unknown) {
      return true;
    },
  },
  vobi: {
    async chatCompletions() {
      throw new Error('本地 VOXA 未启用云端 AI 服务');
    },
  },
};

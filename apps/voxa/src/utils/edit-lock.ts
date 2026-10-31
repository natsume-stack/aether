export type EditLockInfo = {
  locked: boolean;
  actor: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
};

const ACTOR_STORAGE_KEY = 'voxa.editActor';

let cachedActor = '';

function storedToken() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem('Authorization') || '';
  } catch {
    return '';
  }
}

/**
 * A stable per-tab identity. It is only used to decide whether a lock shown
 * in the editor belongs to this tab; CLI actors use their own labels.
 */
export function getEditActor() {
  if (cachedActor) return cachedActor;
  if (typeof window === 'undefined') return '';
  try {
    const saved = window.sessionStorage.getItem(ACTOR_STORAGE_KEY);
    if (saved) {
      cachedActor = saved;
      return saved;
    }
    const random = typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    cachedActor = `web-${random}`;
    window.sessionStorage.setItem(ACTOR_STORAGE_KEY, cachedActor);
  } catch {
    cachedActor = `web-${Date.now().toString(36)}`;
  }
  return cachedActor;
}

export function isEditLockedByOther(
  lock: EditLockInfo | null | undefined,
  actor = getEditActor(),
) {
  return Boolean(lock?.locked && lock.actor && lock.actor !== actor);
}

export function isEditLockedByActor(
  lock: EditLockInfo | null | undefined,
  actor = getEditActor(),
) {
  return Boolean(lock?.locked && lock.actor && lock.actor === actor);
}

function authorizedHeaders() {
  const token = storedToken();
  return token ? { Authorization: token } : undefined;
}

function writeHeaders(extra?: Record<string, string>) {
  return {
    'content-type': 'application/json',
    ...authorizedHeaders(),
    ...extra,
  };
}

export async function fetchEditLock(
  modelId: number,
  signal?: AbortSignal,
  baseUrl = '',
  headers?: Record<string, string>,
) {
  const response = await fetch(`${baseUrl}/api/local/models/${modelId}/edit-lock`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { ...authorizedHeaders(), ...headers },
    signal,
  });
  if (!response.ok) {
    throw new Error(`读取编辑锁失败（HTTP ${response.status}）`);
  }
  return await response.json() as EditLockInfo;
}

export type EditLockAcquireResult =
  | { acquired: true; lock: EditLockInfo }
  | { acquired: false; lock: EditLockInfo };

async function readLockConflict(response: Response, fallback: EditLockInfo) {
  const body = await response.json().catch(() => ({})) as { editLock?: EditLockInfo };
  return body.editLock || fallback;
}

export async function acquireEditLock(
  modelId: number,
  actor: string,
  options: { ttlMs?: number; signal?: AbortSignal; baseUrl?: string; headers?: Record<string, string> } = {},
): Promise<EditLockAcquireResult> {
  const { ttlMs, signal, baseUrl = '', headers } = options;
  const response = await fetch(`${baseUrl}/api/local/models/${modelId}/edit-lock`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: writeHeaders(headers),
    body: JSON.stringify({ actor, ttlMs }),
    signal,
  });
  if (response.status === 409) {
    return {
      acquired: false,
      lock: await readLockConflict(response, {
        locked: true,
        actor: null,
        acquiredAt: null,
        expiresAt: null,
      }),
    };
  }
  if (!response.ok) {
    throw new Error(`获取编辑锁失败（HTTP ${response.status}）`);
  }
  return { acquired: true, lock: await response.json() as EditLockInfo };
}

export async function releaseEditLock(
  modelId: number,
  actor: string,
  options: { signal?: AbortSignal; baseUrl?: string; headers?: Record<string, string>; keepalive?: boolean } = {},
): Promise<EditLockAcquireResult> {
  const { signal, baseUrl = '', headers, keepalive } = options;
  const response = await fetch(`${baseUrl}/api/local/models/${modelId}/edit-lock`, {
    method: 'DELETE',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: writeHeaders(headers),
    body: JSON.stringify({ actor }),
    signal,
    keepalive,
  });
  if (response.status === 409) {
    return {
      acquired: false,
      lock: await readLockConflict(response, {
        locked: true,
        actor: null,
        acquiredAt: null,
        expiresAt: null,
      }),
    };
  }
  if (!response.ok) {
    throw new Error(`释放编辑锁失败（HTTP ${response.status}）`);
  }
  return { acquired: true, lock: await response.json() as EditLockInfo };
}

export async function fetchModelRevision(
  modelId: number,
  signal?: AbortSignal,
  baseUrl = '',
  headers?: Record<string, string>,
) {
  const response = await fetch(`${baseUrl}/api/local/models/${modelId}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { ...authorizedHeaders(), ...headers },
    signal,
  });
  if (!response.ok) {
    throw new Error(`读取模型版本失败（HTTP ${response.status}）`);
  }
  const model = await response.json() as {
    revision?: number;
    lastEditActor?: string;
  };
  return {
    revision: Number(model.revision) || 0,
    actor: String(model.lastEditActor || ''),
  };
}

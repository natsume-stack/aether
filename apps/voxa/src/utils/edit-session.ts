import {
  acquireEditLock,
  fetchModelRevision,
  releaseEditLock,
  type EditLockInfo,
} from './edit-lock';

export type ModelRevisionEvent = {
  revision: number;
  actor: string;
  at: string;
};

export type EditSessionOptions = {
  modelId: number;
  actor: string;
  /** Lock lifetime; renewal happens at half of it. */
  ttlMs?: number;
  /** Only used by host-side checks; the browser uses same-origin URLs. */
  baseUrl?: string;
  headers?: Record<string, string>;
  reload: () => Promise<unknown> | unknown;
  onLock?: (lock: EditLockInfo) => void;
  onConflict?: (lock: EditLockInfo) => void;
  onReloaded?: (event: ModelRevisionEvent) => void;
  onError?: (error: unknown) => void;
};

export type EditSession = {
  actor: string;
  /** Releases the lock (if owned) and stops all timers/streams. */
  close: () => Promise<void>;
};

const DEFAULT_TTL_MS = 120_000;
const MIN_TTL_MS = 4_000;
const RECONNECT_MS = 1_500;
const RETRY_LOCK_MS = 5_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps one VOXA model in sync with the server while it is open:
 *
 * - acquires/renews a short edit lock so CLI writers get 409 while a human tab
 *   is open (and the tab cannot silently overwrite a CLI write);
 * - follows the revision SSE feed and reloads the project when another actor
 *   commits, which is how `model.ts` edits show up in the browser;
 * - retries the lock while another actor owns it, so the tab becomes writable
 *   again after a CLI session releases.
 */
export function startEditSession(options: EditSessionOptions): EditSession {
  const {
    modelId,
    actor,
    baseUrl = '',
    headers,
    reload,
    onLock,
    onConflict,
    onReloaded,
    onError,
  } = options;
  const ttlMs = Math.max(MIN_TTL_MS, options.ttlMs ?? DEFAULT_TTL_MS);

  const abort = new AbortController();
  let owned = false;
  let closed = false;
  let lastRevision = -1;
  let baselineSeen = false;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setInterval> | undefined;

  const reportError = (error: unknown) => {
    if (!closed) onError?.(error);
  };

  const stopRenewal = () => {
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = undefined;
  };

  const stopRetry = () => {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = undefined;
  };

  const acquire = async () => {
    const result = await acquireEditLock(modelId, actor, {
      ttlMs,
      signal: abort.signal,
      baseUrl,
      headers,
    });
    onLock?.(result.lock);
    if (!result.acquired) {
      owned = false;
      if (!retryTimer && !closed) {
        retryTimer = setInterval(() => {
          if (closed) return;
          acquire().catch(reportError);
        }, RETRY_LOCK_MS);
      }
      onConflict?.(result.lock);
      return false;
    }

    owned = true;
    stopRetry();
    if (!renewalTimer && !closed) {
      renewalTimer = setInterval(() => {
        if (closed) return;
        acquire().catch(reportError);
      }, Math.max(MIN_TTL_MS / 2, Math.floor(ttlMs / 2)));
    }
    return true;
  };

  const handleRevision = async (event: ModelRevisionEvent) => {
    if (closed) return;
    if (!baselineSeen) {
      baselineSeen = true;
      lastRevision = event.revision;
      return;
    }
    if (event.revision <= lastRevision) return;
    lastRevision = event.revision;
    if (!event.actor || event.actor === actor) return;
    try {
      await reload();
      onReloaded?.(event);
    } catch (error) {
      reportError(error);
    }
  };

  const watch = async () => {
    const revisionURL = `${baseUrl}/api/local/models/${modelId}/events`;
    while (!closed) {
      try {
        const response = await fetch(revisionURL, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { ...headers },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`订阅模型版本失败（HTTP ${response.status}）`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                await handleRevision(JSON.parse(line.slice(5).trim()) as ModelRevisionEvent);
              } catch {
                // A malformed frame must not kill the stream.
              }
            }
          }
        }
      } catch (error) {
        if (closed || abort.signal.aborted) return;
        reportError(error);
      }
      if (!closed) await delay(RECONNECT_MS);
    }
  };

  const start = async () => {
    try {
      const baseline = await fetchModelRevision(modelId, abort.signal, baseUrl, headers);
      lastRevision = baseline.revision;
      baselineSeen = true;
    } catch (error) {
      // Without a baseline the first SSE frame still works; a later external
      // write then reloads, which is the safe direction.
      reportError(error);
    }
    try {
      await acquire();
    } catch (error) {
      reportError(error);
    }
    void watch();
  };

  void start();

  return {
    actor,
    close: async () => {
      if (closed) return;
      closed = true;
      stopRenewal();
      stopRetry();
      abort.abort();
      if (owned) {
        try {
          await releaseEditLock(modelId, actor, {
            baseUrl,
            headers,
            keepalive: true,
          });
        } catch (error) {
          console.error(`释放编辑锁失败：${errorMessage(error)}`);
        }
      }
      owned = false;
    },
  };
}

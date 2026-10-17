import axios from 'axios';

export type LocalRuntimeStatus = {
  phase: 'idle' | 'starting' | 'loading' | 'ready' | 'error';
  percent?: number;
  message?: string;
};

type RuntimeHttpClient = {
  post: (
    url: string,
    data?: unknown,
    config?: { timeout?: number; headers?: Record<string, string> },
  ) => Promise<{ status: number; data: unknown }>;
  get: (
    url: string,
    config?: { timeout?: number },
  ) => Promise<{ status: number; data: unknown }>;
};

const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

function runtimeStatus(value: unknown): LocalRuntimeStatus {
  const status = (value || {}) as Partial<LocalRuntimeStatus>;
  const phases: LocalRuntimeStatus['phase'][] = [
    'idle',
    'starting',
    'loading',
    'ready',
    'error',
  ];
  return {
    phase: phases.includes(status.phase as LocalRuntimeStatus['phase'])
      ? (status.phase as LocalRuntimeStatus['phase'])
      : 'starting',
    ...(typeof status.percent === 'number' ? { percent: status.percent } : {}),
    ...(typeof status.message === 'string' ? { message: status.message } : {}),
  };
}

/**
 * Start a managed local map runtime without holding the createSession request
 * for the complete migration/prebake. This mirrors Boxes' asynchronous
 * container allocation: callers receive a pending response and poll again;
 * the successful retry therefore reaches the ready runtime with a fresh
 * player identity instead of one that aged during the complete cold start.
 */
export async function prepareLocalRuntimeSession(
  runtimeURL: string,
  client: RuntimeHttpClient = axios,
  allowRuntimeRestart = false,
): Promise<{ ready: boolean; status: LocalRuntimeStatus }> {
  const baseURL = runtimeURL.replace(/\/$/, '');
  await client.post(`${baseURL}/__local_runtime/start`, undefined, {
    timeout: CONTROL_REQUEST_TIMEOUT_MS,
    ...(allowRuntimeRestart ? { headers: { 'x-box-runtime-restart': '1' } } : {}),
  });
  const response = await client.get(`${baseURL}/__local_runtime/status`, {
    timeout: CONTROL_REQUEST_TIMEOUT_MS,
  });
  const status = runtimeStatus(response.data);

  if (status.phase === 'error') {
    throw Object.assign(new Error(status.message || '地图运行时启动失败'), {
      code: 'LOCAL_RUNTIME_START_FAILED',
    });
  }

  return { ready: status.phase === 'ready', status };
}

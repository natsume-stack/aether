import http from 'node:http';
import type { NextApiResponse } from 'next';

function runtimePort() {
  return Number(process.env.BOX_EDIT_RUNTIME_PORT || process.env.BOX_EDIT_SERVER_PORT || 9967);
}

export function creatorPreviewRuntimeUrl(projectId: string, suffix = '') {
  return `http://127.0.0.1:${runtimePort()}/${encodeURIComponent(projectId)}/internal/creator-preview-runtime${suffix}`;
}

export async function requestCreatorPreviewRuntime(
  projectId: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
) {
  const response = await fetch(creatorPreviewRuntimeUrl(projectId), {
    method: init?.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.body && typeof init.body === 'object' && init.body !== null && 'action' in init.body
        ? { 'X-Box-Creator-Preview-Action': String(init.body.action) }
        : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `预览运行请求失败（HTTP ${response.status}）`), { statusCode: response.status });
  return data;
}

/** Pipe an already-authorized internal SSE stream without exposing the edit runtime. */
export function pipeCreatorPreviewRuntimeEvents(projectId: string, res: NextApiResponse) {
  const upstream = http.request(creatorPreviewRuntimeUrl(projectId, '/events'), {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
  }, (source) => {
    res.writeHead(source.statusCode || 502, {
      'Content-Type': source.headers['content-type'] || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    source.pipe(res);
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) res.status(502).json({ code: 'RUNTIME_UNAVAILABLE', message: error.message });
    else res.end();
  });
  res.once('close', () => upstream.destroy());
  upstream.end();
}

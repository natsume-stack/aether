import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

/** Acceptance harness, not an Agent execution path. Only named reads retry. */
export function authoringSmokeClient(project, readonlyTools) {
  assert.match(project || '', /^[a-z0-9-]+$/);
  const base = `http://127.0.0.1:9967/${project}/`;
  const readers = new Set(readonlyTools);
  async function request(route, body, headers = {}) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const data = response.status === 204 ? {} : await response.json();
    assert.ok(response.ok, `HTTP ${response.status}: ${data.code || data.message || 'request failed'}`);
    return data;
  }
  async function tool(name, args = {}, operationId) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { result } = await request('internal/ai-tool', { tool: name, args, operationId });
        assert.notEqual(result.success, false, `${result.code}: ${result.error}`);
        return result;
      } catch (error) {
        if (!readers.has(name) || !(error instanceof TypeError) || attempt >= 4) throw error;
        await pause(2000);
      }
    }
  }
  async function save() { assert.ok((await request('internal/save-local-project', {})).permissionHash); }
  async function stopped() {
    const preview = await request('internal/creator-preview-runtime');
    assert.notEqual(preview.running, true);
    assert.notEqual(preview.phase, 'running');
  }
  async function restart(readyTool = 'terrainInfo') {
    await request('__local_runtime/destroy', {});
    try { await request('__local_runtime/start', {}, { 'x-box-runtime-restart': '1' }); }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
    for (let attempt = 0; attempt < 45; attempt++) {
      let status;
      try { status = await request('__local_runtime/status'); }
      catch (error) { if (!(error instanceof TypeError)) throw error; await pause(2000); continue; }
      assert.notEqual(status.phase, 'error');
      if (status.phase === 'ready') { await tool(readyTool); return; }
      await pause(2000);
    }
    throw new Error('Runtime did not become ready; inspect evidence, never replay ambiguous writes');
  }
  return { request, tool, save, stopped, restart };
}

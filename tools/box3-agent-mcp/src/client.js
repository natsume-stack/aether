/**
 * HTTP client for the live agent surface. Node standard library only.
 *
 * Two credentials modes:
 *   1. join code (preferred): redeem once, keep the `agx_` token in memory.
 *   2. explicit token env, for hosts that already joined.
 *
 * There is no loopback requirement: the editor may be deployed at
 * https://box3.cdk.lat/edit while the agent runs on another machine.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const RETRYABLE_CODES = new Set([
  'EDITOR_TIMEOUT',
  'EDITOR_NOT_ATTACHED',
  'EDITOR_STALE',
  'EDITOR_REATTACHED',
  'EDITOR_DETACHED',
  'ENGINE_UNREACHABLE',
  'NETWORK_ERROR',
]);

export class AgentError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = extra.status;
    this.hint = extra.hint;
    this.detail = extra.detail;
    this.retryable = extra.retryable ?? RETRYABLE_CODES.has(code);
  }
}

function transportFor(url) {
  return url.protocol === 'https:' ? https : http;
}

function requestOnce(url, options) {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'box3-agent-mcp/0.1.0',
    ...(options.headers || {}),
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(body.length);
  }
  const timeoutMs = options.timeoutMs || 180_000;

  return new Promise((resolve, reject) => {
    const request = transportFor(url).request(
      url,
      { method: options.method || 'GET', headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { raw: text.slice(0, 2_000) };
            }
          }
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: parsed,
            location: response.headers.location,
            text,
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new AgentError('NETWORK_ERROR', `请求超时（${timeoutMs} ms）：${url.pathname}`, {
          retryable: true,
        }),
      );
    });
    request.on('error', (error) => {
      if (error instanceof AgentError) {
        reject(error);
        return;
      }
      reject(
        new AgentError('ENGINE_UNREACHABLE', `无法连接 ${url.origin}：${error.message}`, {
          retryable: true,
          hint: '确认引擎在线、公开地址可达；本地开发默认 http://127.0.0.1:3127 / :3123',
        }),
      );
    });
    if (body) request.end(body);
    else request.end();
  });
}

async function requestFollow(url, options, redirects = 0) {
  const response = await requestOnce(url, options);
  if (
    redirects < 3 &&
    [301, 302, 307, 308].includes(response.status) &&
    response.location
  ) {
    return requestFollow(new URL(response.location, url), options, redirects + 1);
  }
  return response;
}

function authHint(status, body) {
  if (body?.code === 'CROSS_MAP_TOKEN') {
    return '这个令牌属于另一张地图：用当前地图的 MAP- 识别码重新 join（BOX_MAP_AGENT_CODE），或去掉 BOX_MAP_PROJECT 让客户端自动发现 project id';
  }
  if (body?.code === 'INVALID_CODE') {
    return '识别码无效或已轮换：在编辑器 Agent Active → 识别码 重新复制完整的一串（MAP-XXXX-XXXX-XXXX）后重启客户端';
  }
  if (body?.code === 'AGENT_LIMIT') {
    return '该地图 agent 数量已满：在 Agent Active → Agent 页签吊销不用的 agent 后重试';
  }
  if (status === 401) {
    return '需要有效令牌：用识别码 POST /api/agent/v1/join 换取；轮换识别码后需要重新 join，已加入的 agent 不受影响';
  }
  if (status === 403) {
    return '部署拒绝了该 Host：确认公开地址与 BOX_CREATOR_ALLOWED_HOSTS / BOX_VOXA_ALLOWED_ORIGINS 一致';
  }
  if (status === 409 && body?.code === 'EDITOR_NOT_ATTACHED') {
    return '先在这个地址打开地图编辑器（或 VOXA 模型）并保持标签页可见，再重试';
  }
  if (status === 504) {
    return '编辑器没有及时回执：先 observe 确认这一步是否已经生效，不要盲目重放写操作';
  }
  return body?.hint;
}

function withOperationId(response, snapshot) {
  const operationId = response?.operationId || response?.commandId;
  if (!operationId) return response;
  for (const target of [snapshot, response?.snapshot, response?.result]) {
    if (target && typeof target === 'object' && !Array.isArray(target) && !target.operationId) {
      target.operationId = operationId;
    }
  }
  return { ...response, operationId };
}

export class AgentClient {
  constructor(config, { fetchImpl } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.tokens = { map: config.mapToken || '', voxa: config.voxaToken || '' };
    this.joins = { map: null, voxa: null };
    this.lastActionAt = 0;
  }

  baseUrl(kind) {
    return kind === 'map' ? this.config.mapBaseUrl : this.config.voxaBaseUrl;
  }

  /**
   * Resolve an API path against the configured base URL *keeping its path
   * prefix*.
   *
   * This matters in production: the deployment serves the creator editor at
   * `https://box3.cdk.lat/edit`, and the path gateway strips `/edit` before
   * forwarding. `new URL('/api/...', base)` would discard that prefix and hit
   * the play upstream instead — every live call would 404 with no useful error.
   */
  resolve(kind, path) {
    const base = this.baseUrl(kind);
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const relative = path.startsWith('/') ? path.slice(1) : path;
    return new URL(relative, normalizedBase);
  }

  joinCode(kind) {
    return kind === 'map' ? this.config.mapCode : this.config.voxaCode;
  }

  async join(kind) {
    const base = this.baseUrl(kind);
    const code = this.joinCode(kind);
    if (!code) {
      throw new AgentError(
        'JOIN_CODE_REQUIRED',
        `未配置 ${kind === 'map' ? 'BOX_MAP_AGENT_CODE' : 'BOX_VOXA_AGENT_CODE'}`,
        {
          hint: '打开编辑器 Agent 面板，点“复制 MCP 配置”，整段环境变量粘进客户端',
        },
      );
    }
    const response = await requestFollow(this.resolve(kind, '/api/agent/v1/join'), {
      method: 'POST',
      body: { code, name: this.config.agentName },
      timeoutMs: 20_000,
    });
    if (response.status !== 201 || !response.body?.token) {
      throw new AgentError(
        response.body?.code || `HTTP_${response.status}`,
        response.body?.message || '识别码换取令牌失败',
        {
          status: response.status,
          hint: authHint(response.status, response.body),
          detail: response.body,
        },
      );
    }
    this.tokens[kind] = response.body.token;
    this.joins[kind] = {
      agentId: response.body.agentId,
      fingerprint: response.body.tokenFingerprint,
      projectId: response.body.project?.id || response.body.map?.projectId,
      editorUrl: response.body.map?.editorUrl || response.body.editorUrl,
      attached: response.body.map?.attached,
      joinedAt: new Date().toISOString(),
    };
    return response.body;
  }

  async ensureToken(kind) {
    if (this.tokens[kind]) return this.tokens[kind];
    await this.join(kind);
    return this.tokens[kind];
  }

  async request(kind, path, options = {}) {
    const url = this.resolve(kind, path);
    let token = await this.ensureToken(kind);
    let response = await requestFollow(url, {
      method: options.method || 'GET',
      body: options.body,
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
    });

    if (response.status === 401 && this.joinCode(kind) && !options._retried) {
      this.tokens[kind] = '';
      token = await this.ensureToken(kind);
      response = await requestFollow(url, {
        method: options.method || 'GET',
        body: options.body,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: options.timeoutMs || this.config.requestTimeoutMs,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      const body = response.body || {};
      const outcome = body;
      const error = outcome.result?.success === false ? outcome.result : (typeof outcome.error === 'object' ? outcome.error : body);
      throw new AgentError(
        error.code || `HTTP_${response.status}`,
        error.message || error.error || `引擎返回 HTTP ${response.status}`,
        {
          status: response.status,
          hint: error.hint || authHint(response.status, body),
          detail: body,
          retryable: error.retryable,
        },
      );
    }
    return response.body;
  }

  /**
   * The map id comes from, in order: the caller's override, an explicit env
   * override, or the project the join handshake just bound this credential to.
   * That last source is why a human only has to hand over "editor address +
   * map code" — the id is never something they need to copy by hand.
   */
  projectId(explicit) {
    const project = String(explicit || this.config.mapProject || this.joins.map?.projectId || '').trim();
    if (!project) {
      throw new AgentError('PROJECT_REQUIRED', '未指定地图', {
        hint: '识别码 join 会返回 project id；若仍缺失，确认服务端 join 响应包含 project.id，或显式设置 BOX_MAP_PROJECT',
      });
    }
    return project;
  }

  mapPath(projectId, action) {
    return `/api/agent/v1/live/map/${encodeURIComponent(projectId)}/${action}`;
  }

  async mapStatus(projectId) {
    // Redeem the code first: the map id may only exist in the join response.
    await this.ensureToken('map');
    return this.request('map', this.mapPath(this.projectId(projectId), 'status'));
  }

  /** Authoritative content tools execute in the runtime, without a visible tab. */
  async mapAuthoring(tool, args = {}, options = {}) {
    await this.ensureToken('map');
    const project = this.projectId(options.projectId);
    const response = await this.request('map', `/api/agent/v1/map/${encodeURIComponent(project)}/tool`, {
      method: 'POST', body: { tool, args, ...(options.operationId ? { operationId: options.operationId } : {}) },
    });
    const result = response?.result || response;
    if (result?.success === false) throw new AgentError(result.code || 'AUTHORING_FAILED', result.error || result.message || 'Authoring failed', { detail: result, retryable: false });
    return result;
  }

  async mapAuthoringOperation(operationId, projectId) {
    await this.ensureToken('map');
    const project = this.projectId(projectId);
    const response = await this.request('map', `/api/agent/v1/map/${encodeURIComponent(project)}/operation?operationId=${encodeURIComponent(operationId)}`);
    return response?.result || response;
  }

  async mapRuntimeAction(action, body, projectId) {
    if (!['status', 'save', 'preview'].includes(action)) throw new AgentError('INVALID_ACTION', 'Invalid runtime action');
    await this.ensureToken('map');
    return this.request('map', `/api/agent/v1/map/${encodeURIComponent(this.projectId(projectId))}/${action}`, {
      method: action === 'status' ? 'GET' : 'POST', ...(body ? { body } : {}),
    });
  }

  async mapObserve(options = {}) {
    await this.ensureToken('map');
    const project = this.projectId(options.projectId);
    return this.request('map', this.mapPath(project, 'observe'), {
      method: 'POST',
      body: { includeTerrain: Boolean(options.includeTerrain), waitMs: options.waitMs },
      timeoutMs: (options.waitMs || this.config.waitMs) + 30_000,
    });
  }

  async mapCommand(kind, args = {}, options = {}) {
    await this.ensureToken('map');
    const project = this.projectId(options.projectId);
    const waitMs = Math.min(120_000, Math.max(5_000, options.waitMs || this.config.waitMs));
    const response = await this.request('map', this.mapPath(project, 'cmd'), {
      method: 'POST',
      body: { kind, args, waitMs },
      timeoutMs: waitMs + 45_000,
    });
    if (response && response.ok === false) {
      const error = response.error || {};
      throw new AgentError(error.code || 'EDITOR_REFUSED', error.message || '编辑器拒绝执行', {
        hint: error.hint,
        retryable: error.retryable,
        detail: response,
      });
    }
    return withOperationId(response);
  }

  async voxaStatus() {
    return this.request('voxa', '/api/agent/v1/live/voxa/status');
  }

  async voxaObserve(options = {}) {
    const response = await this.request('voxa', '/api/agent/v1/live/voxa/observe', {
      method: 'POST',
      body: { screenshot: Boolean(options.screenshot), waitMs: options.waitMs },
      timeoutMs: (options.waitMs || this.config.waitMs) + 30_000,
    });
    // The VOXA observe route returns the raw outcome; keep the same shape the
    // map route uses so callers can read operationId from either channel.
    return withOperationId(
      response?.snapshot ? response : { ...response, snapshot: response?.result?.snapshot },
      response?.snapshot || response?.result?.snapshot,
    );
  }

  async voxaCommand(kind, args = {}, options = {}) {
    const waitMs = Math.min(120_000, Math.max(5_000, options.waitMs || this.config.waitMs));
    const response = await this.request('voxa', '/api/agent/v1/live/voxa/cmd', {
      method: 'POST',
      body: { kind, args, waitMs },
      timeoutMs: waitMs + 45_000,
    });
    if (response && response.ok === false) {
      const error = response.error || {};
      throw new AgentError(error.code || 'EDITOR_REFUSED', error.message || '编辑器拒绝执行', {
        hint: error.hint,
        retryable: error.retryable,
        detail: response,
      });
    }
    return withOperationId(response);
  }

  /** Keep a minimum gap between edit commands so the human can follow. */
  async pace() {
    const elapsed = Date.now() - this.lastActionAt;
    const wait = Math.max(0, this.config.minActionMs - elapsed);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastActionAt = Date.now();
  }

  diagnostics() {
    return {
      mapBaseUrl: this.config.mapBaseUrl,
      voxaBaseUrl: this.config.voxaBaseUrl,
      mapProject: this.config.mapProject || this.joins.map?.projectId || null,
      mapEditorUrl: this.joins.map?.editorUrl || null,
      voxaModelId: this.config.voxaModelId || null,
      agentName: this.config.agentName,
      mapJoined: Boolean(this.tokens.map),
      voxaJoined: Boolean(this.tokens.voxa),
      joinFingerprint: this.joins,
      allowWrite: this.config.allowWrite,
    };
  }
}

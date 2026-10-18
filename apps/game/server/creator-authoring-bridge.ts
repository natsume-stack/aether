import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextApiRequest } from 'next';
import type { CreatorCliCapability } from '../shared/creator-cli-policy';

/**
 * Creator/v1 AI authoring bridge (lane B/D, plan/N7 decision 1).
 *
 * WHAT THIS IS
 * The identity-bearing front door for headless AI map authoring. The engine
 * already exposes its AI authoring tools over a loopback-only runtime route
 * (`services/game-server/src/edit/ai/ai-tool-route.ts`, registered in
 * `createServer.ts`); that route is a *same-host orchestration surface* and
 * deliberately stays byte-identical. This module does not authenticate
 * anything: a request reaches it only through
 * `authorizeCreatorCliApi(req, res, 'authoring.apply')`, i.e. a `bxc_*` CLI
 * Token resolved by the player-service, with per-scope authorization, per-token
 * revocation (`revokeCreatorCliToken`) and an identity (`subjectId`) that can
 * be attributed and audited.
 *
 * WHY THE GATE HAS TO BE HERE AND NOT ON `/api/internal/*`
 * `apps/game/pages/api/internal/map-authoring/_guard.ts` answers 403 for any
 * non-loopback socket peer and carries no credential concept. Adding a shared
 * secret there would turn "zero auth + loopback only" into "zero identity +
 * one key for every map": nobody could tell which agent wrote, audit by actor
 * would be impossible, and one leaked secret would grant write access to every
 * project. The CLI Token already provides all four properties that a shared
 * secret cannot: identity, per-scope authorization, per-token revocation and
 * rate limiting per token.
 *
 * SECURITY INVARIANTS
 *   1. Never logs or returns a credential. The actor column stores a
 *      non-reversible 12-hex SHA-256 fingerprint of the bearer value
 *      (`tokenFingerprint`); the raw `bxc_…` value has no way back out of it.
 *   2. Every write emits exactly one audit line on the response boundary,
 *      including refusals (409/429/502), so a refused write is still
 *      attributable.
 *   3. Audit reads are scoped to the caller's own subject AND own token
 *      fingerprint: `authoring.apply` never becomes a way to read another
 *      tenant's trail.
 *   4. The hard ordering rule is enforced here, in the identity-bearing layer,
 *      not only inside the tools: saving while a live preview runs refuses with
 *      409 `PREVIEW_RUNNING` unless the caller passes `force`, because
 *      `services/game-server/src/edit/replica/replica-server.ts:1600-1602`
 *      (`// update voxel hashes only if game isn't running` /
 *      `if (!gameState.replica.running) {`) skips `recordVoxelInfo` while the
 *      preview is running, so the saved project would silently keep stale
 *      terrain.
 */

/** The single CLI scope that unlocks the AI authoring surface. */
export const CREATOR_AUTHORING_SCOPE: CreatorCliCapability = 'authoring.apply';

/** Route family this module serves; used for audit paths and docs. */
export const CREATOR_AUTHORING_PATH_PREFIX = '/api/creator/v1/authoring';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AUDIT_FIELDS = [
  'at',
  'tokenSubject',
  'tokenFingerprint',
  'projectId',
  'tool',
  'revisionBefore',
  'revisionAfter',
  'result',
] as const;
/** Bounded response inspection: a `terrainRevert` undoToken can be many MB. */
const AUDIT_DETAIL_BYTES = 8 * 1024;
const DEFAULT_WRITE_QUOTA_MAX = 60;
const DEFAULT_WRITE_QUOTA_WINDOW_MS = 5 * 60_000;
const RUNTIME_TIMEOUT_MS = 120_000;

export type AuthoringAuditResult =
  | 'applied'
  | 'refused'
  | 'failed'
  | 'saved'
  | 'preview-started'
  | 'preview-stopped'
  | 'denied-rate-limit';

export type AuthoringAuditRow = {
  at: string;
  tokenSubject: string;
  tokenFingerprint: string;
  projectId: string;
  tool: string;
  revisionBefore: string;
  revisionAfter: string;
  result: AuthoringAuditResult;
  statusCode: number;
  code: string;
  action: string;
  detail: string;
};

export type AuthoringRuntimeResponse = { status: number; data: unknown };

/**
 * The runtime-facing half of the bridge. `fetchJson` is injectable so the
 * ordering/quota/audit logic is testable without an edit runtime process; the
 * production caller uses `createLoopbackRuntimeCaller()`.
 */
export type AuthoringRuntimeCaller = {
  projectId: string;
  probeRuntime(): Promise<AuthoringRuntimeResponse | null>;
  listTools(): Promise<AuthoringRuntimeResponse>;
  invokeTool(tool: string, args: unknown): Promise<AuthoringRuntimeResponse>;
  previewStatus(): Promise<AuthoringRuntimeResponse>;
  previewControl(action: 'start' | 'stop'): Promise<AuthoringRuntimeResponse>;
  saveProject(): Promise<AuthoringRuntimeResponse>;
};

function env(name: string): string {
  return String(process.env[name] || '').trim();
}

function positiveInteger(value: string, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function isAuthoringProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

/** Same resolution order as `_guard.ts:39-45`, so both layers dial one port. */
function runtimePort(): number {
  return Number(
    process.env.BOX_EDIT_RUNTIME_PORT ||
      process.env.BOX_EDIT_SERVER_PORT ||
      '9967',
  );
}

/**
 * Loopback peer address of the edit runtime. This request path is *inside* the
 * creator process: the CLI Token was already verified by the route, so unlike
 * `_guard.ts` the peer here is a trusted internal hop, never a client socket.
 */
function runtimeHost(): string {
  const configured = env('BOX_EDIT_RUNTIME_HOST');
  // The runtime binds 0.0.0.0 in containers but is only ever *called* over
  // loopback by this process; 0.0.0.0 is not a valid dial target.
  return !configured || configured === '0.0.0.0' || configured === '::' ? '127.0.0.1' : configured;
}

function runtimeUrl(projectId: string, suffix: string): string {
  return `http://${runtimeHost()}:${runtimePort()}/${encodeURIComponent(projectId)}/${suffix}`;
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
    ?.cause?.code || (error as NodeJS.ErrnoException)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EADDRNOTAVAIL';
}

export function createLoopbackRuntimeCaller(
  projectId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): AuthoringRuntimeCaller {
  const call = async (
    suffix: string,
    init?: { method?: 'GET' | 'POST'; body?: unknown },
  ): Promise<AuthoringRuntimeResponse> => {
    const response = await fetchImpl(runtimeUrl(projectId, suffix), {
      method: init?.method || 'GET',
      headers: init?.body
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(RUNTIME_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  };

  return {
    projectId,
    // `/__local_runtime/status` is answered by the edit library itself and only
    // reports `pid` when a runtime process is alive; unlike an unknown forwarded
    // path it never allocates a runtime. Headless writes must not silently boot
    // an editor process.
    async probeRuntime() {
      try {
        const probed = await call('__local_runtime/status');
        const info = probed.data as Record<string, unknown>;
        return probed.status === 200 && info && info.pid !== undefined ? probed : null;
      } catch (error) {
        if (isConnectionRefused(error)) return null;
        throw error;
      }
    },
    listTools() {
      return call('internal/ai-tool');
    },
    invokeTool(tool, args) {
      return call('internal/ai-tool', { method: 'POST', body: { tool, args: args ?? {} } });
    },
    previewStatus() {
      return call('internal/creator-preview-runtime');
    },
    previewControl(action) {
      return call('internal/creator-preview-runtime', { method: 'POST', body: { action } });
    },
    saveProject() {
      return call('internal/save-local-project', { method: 'POST' });
    },
  };
}

/**
 * Preview-running classification shared by the ordering rules. The runtime
 * reports either `{running:true}` or `phase:"running"`; both are accepted, and
 * a probe failure is treated as "not running" only because the tool layer
 * refuses independently (`PREVIEW_RUNNING` inside `map-authoring-tools.ts`).
 */
export function isPreviewRunning(payload: unknown): boolean {
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {};
  return record.running === true || record.phase === 'running';
}

const REVISION_KEYS = [
  'expectedRevision',
  'beforeRevision',
  'revisionBefore',
  'afterRevision',
  'revisionAfter',
  'toRevision',
  'headHash',
  'permissionHash',
  'revision',
];

/**
 * First revision-looking scalar found in a payload, breadth-first over object
 * keys in `REVISION_KEYS` order, then nested containers. Bounded so a multi-MB
 * undoToken cannot be walked.
 */
export function extractRevision(value: unknown, maxNodes = 256): string {
  if (!value || typeof value !== 'object') return '';
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  let visited = 0;
  while (queue.length > 0 && visited < maxNodes) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    const record = node as Record<string, unknown>;
    for (const key of REVISION_KEYS) {
      const item = record[key];
      if (typeof item === 'string' || typeof item === 'number') return String(item);
    }
    for (const item of Object.values(record)) {
      if (item && typeof item === 'object') queue.push(item);
    }
  }
  return '';
}

export function authoringBearer(req: Pick<NextApiRequest, 'headers'>): string {
  const authorization = String(req.headers?.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : '';
}

/**
 * Non-reversible actor label. `bxc_` tokens are high-entropy secrets, so a
 * truncated SHA-256 is the cheapest way to get "which token" without ever
 * storing the credential.
 */
export function tokenFingerprint(token: string): string {
  if (!token) return 'none';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function authoringAuditFilePath(): string {
  return env('BOX_CREATOR_AUTHORING_AUDIT_PATH');
}

function emitAuditLine(line: string): void {
  // stdout is the durable sink in every shipped deployment (docker logs);
  // the file is an opt-in for operators that need a queryable trail.
  process.stdout.write(`[box3.creator-authoring] ${line}\n`);
  const target = authoringAuditFilePath();
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`, 'utf8');
  } catch {
    // An unwritable audit target must never convert an authorised map write
    // into a 500: the write already happened. The stdout line above is still
    // the record of truth.
  }
}

/**
 * One line per authoring write, always carrying the six contracted fields
 * (`tokenSubject`, `projectId`, `tool`, `revisionBefore`, `revisionAfter`,
 * `result`). `detail` is a bounded, credential-free echo of the outcome code.
 */
export function writeAuthoringAudit(input: {
  tokenSubject: string;
  tokenFingerprint: string;
  projectId: string;
  tool?: string;
  action?: string;
  revisionBefore?: string;
  revisionAfter?: string;
  result: AuthoringAuditResult;
  statusCode?: number;
  code?: string;
  detail?: string;
}): AuthoringAuditRow {
  const row: AuthoringAuditRow = {
    at: new Date().toISOString(),
    tokenSubject: input.tokenSubject,
    tokenFingerprint: input.tokenFingerprint,
    projectId: input.projectId,
    tool: input.tool || '',
    revisionBefore: input.revisionBefore || '',
    revisionAfter: input.revisionAfter || '',
    result: input.result,
    statusCode: input.statusCode ?? 0,
    code: input.code || '',
    action: input.action || '',
    detail: String(input.detail || '').slice(0, AUDIT_DETAIL_BYTES),
  };
  emitAuditLine(JSON.stringify(row));
  return row;
}

/** Newest first; missing file yields an empty list rather than an error. */
export function readAuthoringAudit(input: {
  tokenSubject: string;
  tokenFingerprint: string;
  projectId?: string;
  limit?: number;
}): { rows: AuthoringAuditRow[]; sink: string; total: number } {
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 500);
  const target = authoringAuditFilePath();
  if (!target || !fs.existsSync(target)) {
    return { rows: [], sink: target ? 'file-unwritten' : 'stdout-only', total: 0 };
  }
  let text = '';
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return { rows: [], sink: 'file-unreadable', total: 0 };
  }
  const all: AuthoringAuditRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuthoringAuditRow;
      if (parsed && AUDIT_FIELDS.every((key) => typeof (parsed as Record<string, unknown>)[key] === 'string')) {
        all.push(parsed);
      }
    } catch {
      // A torn final line (concurrent append) is skipped, never fatal.
    }
  }
  // A token may read only its own trail: subject AND fingerprint must match, so
  // `authoring.apply` cannot be used to enumerate another tenant's activity.
  const mine = all.filter((row) =>
    row.tokenSubject === input.tokenSubject &&
    row.tokenFingerprint === input.tokenFingerprint &&
    (!input.projectId || row.projectId === input.projectId));
  return {
    rows: [...mine].reverse().slice(0, limit),
    sink: 'file',
    total: mine.length,
  };
}

type QuotaBucket = { count: number; resetAt: number };
const writeQuota = new Map<string, QuotaBucket>();

function quotaPolicy() {
  return {
    maximum: positiveInteger(env('BOX_CREATOR_AUTHORING_RATE_LIMIT_MAX'), DEFAULT_WRITE_QUOTA_MAX, 100_000),
    windowMs: positiveInteger(
      env('BOX_CREATOR_AUTHORING_RATE_LIMIT_WINDOW_MS'),
      DEFAULT_WRITE_QUOTA_WINDOW_MS,
      24 * 60 * 60_000,
    ),
  };
}

/**
 * Per-token, per-project write budget. Keyed by the fingerprint (never the
 * credential) so one noisy agent cannot consume another token's quota, and a
 * revoked token stops counting immediately because it can no longer reach here.
 */
export function consumeAuthoringWriteQuota(
  tokenFingerprintValue: string,
  projectId: string,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number; remaining: number } {
  const { maximum, windowMs } = quotaPolicy();
  const key = `${tokenFingerprintValue}|${projectId}`;
  const current = writeQuota.get(key);
  const active = current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + windowMs };
  active.count += 1;
  writeQuota.set(key, active);
  if (active.count <= maximum) {
    return { allowed: true, retryAfterSeconds: 0, remaining: maximum - active.count };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((active.resetAt - now) / 1000)),
    remaining: 0,
  };
}

export function resetAuthoringWriteQuota(): void {
  writeQuota.clear();
}

export function authoringQuotaEntriesForTests(): Array<{ key: string; count: number }> {
  return [...writeQuota.entries()].map(([key, value]) => ({ key, count: value.count }));
}

/** Stable refusal envelope so every layer answers with `{code, message}`. */
export function authoringError(
  status: number,
  code: string,
  message: string,
): { status: number; body: { code: string; message: string } } {
  return { status, body: { code, message } };
}

/**
 * `POST tools` orchestration: runtime must already be open, then one tool call
 * is forwarded verbatim. No second write implementation, no auto-stopping of
 * the preview, no persistence here — exactly the C4 semantics, now with a
 * token identity and an audit row.
 */
export async function invokeAuthoringTool(input: {
  caller: AuthoringRuntimeCaller;
  tokenSubject: string;
  tokenFingerprint: string;
  tool: string;
  args: unknown;
}): Promise<{ status: number; body: unknown }> {
  const { caller, tokenSubject, tool } = input;
  if (!tool) {
    return authoringError(400, 'INVALID_BODY', 'body 必须为 { tool|name, args? }；GET .../tools 可列出可用工具');
  }
  const probe = await caller.probeRuntime().catch(() => null);
  if (!probe) {
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool,
      action: 'tool',
      result: 'refused',
      statusCode: 409,
      code: 'RUNTIME_NOT_ACTIVE',
      detail: '该工程当前没有打开的编辑运行时',
    });
    return authoringError(409, 'RUNTIME_NOT_ACTIVE',
      '该工程当前没有打开的编辑运行时；请先在 Creator 中打开地图编辑器，再调用 AI 地图工具');
  }
  try {
    const { status, data } = await caller.invokeTool(tool, input.args);
    const outcome = (data ?? {}) as Record<string, unknown>;
    const inner = (outcome.result ?? {}) as Record<string, unknown>;
    const refused = status !== 200 || inner.success === false;
    const code = refused
      ? String(outcome.code || inner.code || 'TOOL_REQUEST_FAILED')
      : '';
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool,
      action: 'tool',
      revisionBefore: extractRevision(input.args),
      revisionAfter: extractRevision(data),
      result: refused ? 'refused' : 'applied',
      statusCode: status,
      code,
      detail: refused
        ? (typeof outcome.message === 'string' ? outcome.message : typeof inner.message === 'string' ? inner.message : '')
        : '',
    });
    return { status, body: data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool,
      action: 'tool',
      result: 'failed',
      statusCode: 502,
      code: isConnectionRefused(error) ? 'RUNTIME_NOT_ACTIVE' : 'RUNTIME_REQUEST_FAILED',
      detail,
    });
    if (isConnectionRefused(error)) {
      return authoringError(409, 'RUNTIME_NOT_ACTIVE', '该工程当前没有打开的编辑运行时，无法调用 AI 地图工具');
    }
    return authoringError(502, 'RUNTIME_REQUEST_FAILED', detail);
  }
}

/**
 * `POST save` with the preview-ordering gate enforced here. `replica-server.ts:1600-1602` skips
 * voxel hash recording while the preview runs, so an un-flagged save during a
 * live preview would persist a project whose terrain hashes are stale.
 */
export async function saveAuthoringProject(input: {
  caller: AuthoringRuntimeCaller;
  tokenSubject: string;
  tokenFingerprint: string;
  force: boolean;
}): Promise<{ status: number; body: unknown }> {
  const { caller, tokenSubject, force } = input;
  if (!force) {
    let running = false;
    try {
      const status = await caller.previewStatus();
      running = status.status === 200 && isPreviewRunning(status.data);
    } catch {
      // Probe failed: fall through to the save, whose own error handling is
      // authoritative. Refusing a legal save on a flaky probe would be worse.
      running = false;
    }
    if (running) {
      writeAuthoringAudit({
        tokenSubject,
        tokenFingerprint: input.tokenFingerprint,
        projectId: caller.projectId,
        tool: 'save',
        action: 'save',
        result: 'refused',
        statusCode: 409,
        code: 'PREVIEW_RUNNING',
        detail: 'replica-server.ts:1600-1602 预览运行中不记录体素 chunk hash',
      });
      return authoringError(409, 'PREVIEW_RUNNING',
        '预览仍在运行：保存不会记录体素 chunk（replica-server.ts:1600-1602）。'
        + '请先 POST .../preview {action:"stop"} 再保存，或传 force:true 强制保存。');
    }
  }
  try {
    const { status, data } = await caller.saveProject();
    const record = (data ?? {}) as Record<string, unknown>;
    const ok = status >= 200 && status < 300;
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool: 'save',
      action: 'save',
      revisionBefore: '',
      revisionAfter: ok ? extractRevision(data) : '',
      result: ok ? 'saved' : 'failed',
      statusCode: status,
      code: ok ? '' : String(record.code || 'SAVE_FAILED'),
      detail: ok ? '' : String(record.message || ''),
    });
    return { status, body: data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool: 'save',
      action: 'save',
      result: 'failed',
      statusCode: isConnectionRefused(error) ? 409 : 502,
      code: isConnectionRefused(error) ? 'RUNTIME_NOT_ACTIVE' : 'RUNTIME_REQUEST_FAILED',
      detail,
    });
    if (isConnectionRefused(error)) {
      return authoringError(409, 'RUNTIME_NOT_ACTIVE', '该工程当前没有打开的编辑运行时，无法保存');
    }
    return authoringError(502, 'RUNTIME_REQUEST_FAILED', detail);
  }
}

export async function controlAuthoringPreview(input: {
  caller: AuthoringRuntimeCaller;
  tokenSubject: string;
  tokenFingerprint: string;
  action: 'start' | 'stop';
}): Promise<{ status: number; body: unknown }> {
  const { caller, tokenSubject, action } = input;
  try {
    const { status, data } = await caller.previewControl(action);
    const ok = status >= 200 && status < 300;
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool: `preview.${action}`,
      action: 'preview',
      result: ok ? (action === 'start' ? 'preview-started' : 'preview-stopped') : 'refused',
      statusCode: status,
      code: ok ? '' : String((data as Record<string, unknown>)?.code || 'PREVIEW_REQUEST_FAILED'),
      detail: ok ? '' : String((data as Record<string, unknown>)?.message || ''),
    });
    return { status, body: data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeAuthoringAudit({
      tokenSubject,
      tokenFingerprint: input.tokenFingerprint,
      projectId: caller.projectId,
      tool: `preview.${action}`,
      action: 'preview',
      result: 'failed',
      statusCode: isConnectionRefused(error) ? 409 : 502,
      code: isConnectionRefused(error) ? 'RUNTIME_NOT_ACTIVE' : 'RUNTIME_REQUEST_FAILED',
      detail,
    });
    if (isConnectionRefused(error)) {
      return authoringError(409, 'RUNTIME_NOT_ACTIVE', '该工程当前没有打开的编辑运行时，无法控制预览');
    }
    return authoringError(502, 'RUNTIME_REQUEST_FAILED', detail);
  }
}

/** Audit-visible summary of the surface for `GET .../authoring/<id>/status`. */
export function authoringSurface(projectId: string) {
  return {
    projectId,
    identity: 'creator-cli-token',
    scope: CREATOR_AUTHORING_SCOPE,
    endpoints: [
      `GET  ${CREATOR_AUTHORING_PATH_PREFIX}/${projectId}/tools`,
      `POST ${CREATOR_AUTHORING_PATH_PREFIX}/${projectId}/tools`,
      `POST ${CREATOR_AUTHORING_PATH_PREFIX}/${projectId}/save`,
      `GET  ${CREATOR_AUTHORING_PATH_PREFIX}/${projectId}/preview`,
      `POST ${CREATOR_AUTHORING_PATH_PREFIX}/${projectId}/preview`,
      `GET  ${CREATOR_AUTHORING_PATH_PREFIX}/${projectId}/status`,
      `GET  ${CREATOR_AUTHORING_PATH_PREFIX}/audit`,
    ],
    orderingRule:
      'save refuses with 409 PREVIEW_RUNNING unless force:true, because voxel chunk hashes are recorded on save only when the preview is stopped (replica-server.ts:1600-1602)',
  };
}

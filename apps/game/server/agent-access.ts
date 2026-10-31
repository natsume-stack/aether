import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Agent Access — 识别码即开发账号（地图侧）。
 *
 * 每张本地地图有一个可轮换的开发识别码（如 MAP-7Q2K-M4XW-9RJT）。把识别码发给
 * 一个 AI（agent），它就能通过 `POST /api/agent/v1/join` 换取一枚 `agx_` 随行
 * 令牌，之后以该身份调用地图 AI 创作工具（terrain/entities/ui/script）、保存
 * 工程、登记产物。识别码是唯一的凭据：不需要玩家会话，也没有任何游客接口。
 *
 * 安全模型与 `/api/creator/v1/authoring`（creator-authoring-bridge.ts）一致：
 *   1. 令牌只存 HMAC-SHA256 摘要（盐持久化在本文件里），原文不可回溯。
 *   2. join 与所有 agent 调用都走 allowCreatorApi 的部署/Host 门（路由侧），
 *      部署形态仍是本地/可信局域网自建引擎。
 *   3. 每次动作写一条审计日志（含拒绝），面板按 agent 展示。
 *   4. 识别码可轮换（旧码立即失效，已加入的 agent 不受影响，可单独吊销）。
 *
 * 纯 Node 模块：不 import next，文件存储、进程内写队列，重启后仍在。
 */

export const AGENT_ACCESS_FORMAT_VERSION = 1;

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_GROUP = 4;
const CODE_GROUPS = 3;
const MAX_AGENTS_PER_MAP = 20;
const MAX_LOG_ROWS = 300;
const MAX_ARTIFACT_ROWS = 60;
const LOG_DETAIL_BYTES = 2 * 1024;

export type AgentAccessScope = 'map';

export type AgentAccessAgent = {
  id: string;
  name: string;
  scope: AgentAccessScope;
  joinedAt: string;
  lastSeenAt: string;
  tokenHash: string;
  fingerprint: string;
};

export type AgentAccessLogRow = {
  at: string;
  agent: string;
  action: string;
  result: string;
  detail: string;
};

export type AgentAccessArtifactRow = {
  at: string;
  agent: string;
  kind: string;
  name: string;
  detail: string;
};

export type AgentAccessEntry = {
  projectId: string;
  code: string;
  codeUpdatedAt: string;
  salt: string;
  nextAgentSeq: number;
  agents: AgentAccessAgent[];
  logs: AgentAccessLogRow[];
  artifacts: AgentAccessArtifactRow[];
};

type AgentAccessStore = {
  formatVersion: number;
  maps: Record<string, AgentAccessEntry>;
};

function dataFilePath(): string {
  const override = String(process.env.BOX_AGENT_ACCESS_PATH || '').trim();
  if (override) return path.resolve(override);
  if (process.env.NODE_ENV === 'production') {
    return path.join(process.cwd(), 'data', 'agent-access.json');
  }
  return path.resolve(
    process.cwd(),
    '../..',
    process.env.BOX_DEV_DATA_DIRECTORY || '.local-data',
    'apps/game/data/agent-access.json',
  );
}

let writeQueue: Promise<unknown> = Promise.resolve();

function readStore(): AgentAccessStore {
  const file = dataFilePath();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.formatVersion === AGENT_ACCESS_FORMAT_VERSION && value.maps) {
      return value as AgentAccessStore;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error(`agent-access 存储损坏: ${(error as Error).message}`);
    }
  }
  return { formatVersion: AGENT_ACCESS_FORMAT_VERSION, maps: {} };
}

function writeStore(store: AgentAccessStore) {
  const file = dataFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.staged-${process.pid}`;
  fs.writeFileSync(staged, JSON.stringify(store, null, 2));
  fs.renameSync(staged, file);
}

/** Serialize read-modify-write cycles within this process, mirroring local-voxa-store. */
function mutate<T>(task: () => T): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

function generateCode(prefix: string): string {
  const bytes = crypto.randomBytes(CODE_GROUP * CODE_GROUPS);
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let text = '';
    for (let index = 0; index < CODE_GROUP; index += 1) {
      text += CODE_ALPHABET[bytes[group * CODE_GROUP + index] % CODE_ALPHABET.length];
    }
    groups.push(text);
  }
  return `${prefix}-${groups.join('-')}`;
}

/** One code must select exactly one map: a collision would make join ambiguous. */
function uniqueCode(store: AgentAccessStore, prefix: string): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = generateCode(prefix);
    if (!Object.values(store.maps).some((candidate) => candidate.code === code)) return code;
  }
  throw new Error('无法生成唯一的识别码；检查 agent-access 存储是否被并发篡改');
}

function hmac(salt: string, value: string): string {
  return crypto.createHmac('sha256', salt).update(value).digest('hex');
}

/** Non-reversible 12-hex display fingerprint for logs/panel (token or code). */
function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizeCode(value: unknown): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9A-Z-]/g, '')
    .trim();
}

/**
 * Audit rows and artifact details are readable from the editor panel and from
 * any log scraped off the filesystem. Codes and bearer tokens must never end up
 * there, even when an agent pastes one into a tool argument.
 */
const SECRET_PATTERN = /\b(?:MAP|VOX)-[0-9A-Z]{4}(?:-[0-9A-Z]{4}){2}\b|\bagx_[A-Za-z0-9_-]{8,}/g;

export function redactAgentSecrets(value: unknown): string {
  return String(value || '').replace(SECRET_PATTERN, (match) => `[redacted:${match.slice(0, 3)}]`);
}

function entryFor(store: AgentAccessStore, projectId: string): { entry: AgentAccessEntry; created: boolean } {
  const existing = store.maps[projectId];
  if (existing) return { entry: existing, created: false };
  const now = new Date().toISOString();
  const entry: AgentAccessEntry = {
    projectId,
    code: uniqueCode(store, 'MAP'),
    codeUpdatedAt: now,
    salt: crypto.randomBytes(16).toString('hex'),
    nextAgentSeq: 1,
    agents: [],
    logs: [],
    artifacts: [],
  };
  store.maps[projectId] = entry;
  return { entry, created: true };
}

function appendLog(entry: AgentAccessEntry, row: Omit<AgentAccessLogRow, 'at'>) {
  entry.logs.unshift({
    at: new Date().toISOString(),
    ...row,
    detail: redactAgentSecrets(row.detail).slice(0, LOG_DETAIL_BYTES),
  });
  if (entry.logs.length > MAX_LOG_ROWS) entry.logs.length = MAX_LOG_ROWS;
}

export type AgentJoinResult =
  | { ok: true; token: string; agent: AgentAccessAgent; projectId: string; codeFingerprint: string }
  | { ok: false; code: 'INVALID_CODE' | 'AGENT_LIMIT' | 'INVALID_NAME' };

/**
 * Redeem a map identification code for an agent credential. The code itself
 * selects the map — the caller never needs a project ID. The raw token is
 * returned exactly once; only its HMAC digest and fingerprint are persisted.
 */
export function joinMapByCode(
  values: { code: unknown; name: unknown },
): Promise<AgentJoinResult> {
  return mutate(() => {
    const store = readStore();
    const supplied = normalizeCode(values.code);
    const entry = Object.values(store.maps).find(
      (candidate) => normalizeCode(candidate.code) === supplied,
    );
    if (!entry) {
      return { ok: false as const, code: 'INVALID_CODE' as const };
    }
    const name = String(values.name || '').trim().slice(0, 60) || 'unnamed-agent';
    if (entry.agents.length >= MAX_AGENTS_PER_MAP) {
      appendLog(entry, { agent: name, action: 'join', result: 'refused', detail: 'agent 数量已达上限' });
      writeStore(store);
      return { ok: false as const, code: 'AGENT_LIMIT' as const };
    }
    const token = `agx_${crypto.randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const agent: AgentAccessAgent = {
      id: `agent-${entry.nextAgentSeq}`,
      name,
      scope: 'map',
      joinedAt: now,
      lastSeenAt: now,
      tokenHash: hmac(entry.salt, token),
      fingerprint: fingerprint(token),
    };
    entry.nextAgentSeq += 1;
    entry.agents.push(agent);
    appendLog(entry, {
      agent: name,
      action: 'join',
      result: 'joined',
      detail: `识别码验证通过，令牌指纹 ${agent.fingerprint}`,
    });
    writeStore(store);
    return { ok: true as const, token, agent, projectId: entry.projectId, codeFingerprint: fingerprint(entry.code) };
  });
}

export type AgentAuthResult =
  | { ok: true; projectId: string; agent: AgentAccessAgent; entry: AgentAccessEntry }
  | { ok: false; code: 'INVALID_TOKEN' | 'NO_ENTRY' | 'CROSS_MAP_TOKEN' };

/**
 * Bearer `agx_…` → (projectId, agent). Does NOT touch lastSeenAt; callers log actions.
 *
 * A token is bound to the map whose salt hashed it. Presenting it against a
 * different project id therefore fails by construction; the extra scan only
 * distinguishes "token belongs to another map" from "token is garbage" so the
 * caller can return an actionable error instead of a generic 401.
 */
export function authenticateMapAgent(projectId: string, bearer: unknown): AgentAuthResult {
  const token = /^Bearer\s+(agx_\S+)$/i.exec(String(bearer || ''))?.[1] || '';
  if (!token) return { ok: false, code: 'INVALID_TOKEN' };
  const store = readStore();
  const entry = store.maps[projectId];
  if (!entry) return { ok: false, code: 'NO_ENTRY' };
  const digest = hmac(entry.salt, token);
  const agent = entry.agents.find((candidate) => candidate.tokenHash === digest);
  if (agent) return { ok: true, projectId, agent, entry };
  const crossMap = Object.values(store.maps).some(
    (candidate) =>
      candidate.projectId !== entry.projectId &&
      candidate.agents.some((candidateAgent) => candidateAgent.tokenHash === hmac(candidate.salt, token)),
  );
  return { ok: false, code: crossMap ? 'CROSS_MAP_TOKEN' : 'INVALID_TOKEN' };
}

function touch(agent: AgentAccessAgent) {
  agent.lastSeenAt = new Date().toISOString();
}

export type AgentAction = {
  action: string;
  result: string;
  detail?: string;
  artifact?: { kind: string; name: string; detail?: string };
};

/** Record one agent action (and optionally an artifact) in the audit trail. */
export async function recordMapAgentAction(
  projectId: string,
  agentId: string,
  action: AgentAction,
): Promise<void> {
  await mutate(() => {
    const store = readStore();
    const entry = store.maps[projectId];
    if (!entry) return;
    const agent = entry.agents.find((candidate) => candidate.id === agentId);
    if (agent) touch(agent);
    appendLog(entry, {
      agent: agent?.name || agentId,
      action: action.action,
      result: action.result,
      detail: action.detail || '',
    });
    if (action.artifact) {
      entry.artifacts.unshift({
        at: new Date().toISOString(),
        agent: agent?.name || agentId,
        kind: String(action.artifact.kind || 'other').slice(0, 40),
        name: redactAgentSecrets(action.artifact.name).slice(0, 160),
        detail: redactAgentSecrets(action.artifact.detail).slice(0, LOG_DETAIL_BYTES),
      });
      if (entry.artifacts.length > MAX_ARTIFACT_ROWS) entry.artifacts.length = MAX_ARTIFACT_ROWS;
    }
    writeStore(store);
  });
}

export type AgentPanelState = {
  projectId: string;
  code: string;
  codeUpdatedAt: string;
  agents: Array<Omit<AgentAccessAgent, 'tokenHash'>>;
  logs: AgentAccessLogRow[];
  artifacts: AgentAccessArtifactRow[];
};

/** Panel view: full code (the owner is allowed to see it), agents without secrets. */
export function mapAgentPanelState(projectId: string): AgentPanelState | null {
  const store = readStore();
  const entry = store.maps[projectId];
  if (!entry) return null;
  return {
    projectId: entry.projectId,
    code: entry.code,
    codeUpdatedAt: entry.codeUpdatedAt,
    agents: entry.agents.map(({ tokenHash: _tokenHash, ...rest }) => rest),
    logs: entry.logs,
    artifacts: entry.artifacts,
  };
}

export async function rotateMapCode(projectId: string): Promise<string> {
  return mutate(() => {
    const store = readStore();
    const { entry } = entryFor(store, projectId);
    const previous = fingerprint(entry.code);
    entry.code = uniqueCode(store, 'MAP');
    entry.codeUpdatedAt = new Date().toISOString();
    appendLog(entry, {
      agent: 'owner',
      action: 'rotate-code',
      result: 'rotated',
      detail: `旧码指纹 ${previous} → 新码指纹 ${fingerprint(entry.code)}`,
    });
    writeStore(store);
    return entry.code;
  });
}

export async function revokeMapAgent(projectId: string, agentId: string): Promise<boolean> {
  return mutate(() => {
    const store = readStore();
    const entry = store.maps[projectId];
    if (!entry) return false;
    const index = entry.agents.findIndex((candidate) => candidate.id === agentId);
    if (index < 0) return false;
    const [removed] = entry.agents.splice(index, 1);
    appendLog(entry, {
      agent: removed.name,
      action: 'revoke-agent',
      result: 'revoked',
      detail: `令牌指纹 ${removed.fingerprint} 已吊销`,
    });
    writeStore(store);
    return true;
  });
}

/** Lazy accessor: every panel/route call ensures the entry (and code) exists — and stays on disk. */
export async function ensureMapAgentAccess(projectId: string): Promise<AgentAccessEntry> {
  return mutate(() => {
    const store = readStore();
    const { entry, created } = entryFor(store, projectId);
    if (created) {
      // 必须落盘：否则文件里没有这条 entry，下一次轮询 readStore 又会现生成
      // 一个新识别码（面板“动态刷新”），join 永远 INVALID_CODE。
      writeStore(store);
    }
    return entry;
  });
}

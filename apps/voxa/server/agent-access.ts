import crypto from 'node:crypto';
import fs from 'node:fs';

import { getVoxaDataRoot } from './local-voxa-store';

/**
 * Agent Access — 识别码即开发账号（VOXA / 模型侧）。
 *
 * VOXA 工作区有一个可轮换的模型开发识别码（VOX-xxxx-xxxx-xxxx）。发给 AI 后，
 * 它通过 `POST /api/agent/v1/join` 换取 `agx_` 令牌，作用域仅限模型构建：
 * 列出模型、导入 .voxaproject bundle、登记产物 —— 不能触碰地图。
 * 地图全量开发走 Creator 侧的 MAP- 识别码（apps/game/server/agent-access.ts）。
 *
 * 安全模型与地图侧一致：令牌只存 HMAC 摘要、识别码可轮换、每个动作写审计。
 */
export const AGENT_ACCESS_FORMAT_VERSION = 1;

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_GROUP = 4;
const CODE_GROUPS = 3;
const MAX_AGENTS = 20;
const MAX_LOG_ROWS = 300;
const MAX_ARTIFACT_ROWS = 60;
const LOG_DETAIL_BYTES = 2 * 1024;
const WORKSPACE_KEY = 'workspace';

export type VoxaAgentAccessAgent = {
  id: string;
  name: string;
  scope: 'voxa';
  joinedAt: string;
  lastSeenAt: string;
  tokenHash: string;
  fingerprint: string;
};

export type VoxaAgentAccessLogRow = {
  at: string;
  agent: string;
  action: string;
  result: string;
  detail: string;
};

export type VoxaAgentAccessArtifactRow = {
  at: string;
  agent: string;
  kind: string;
  name: string;
  detail: string;
};

type WorkspaceEntry = {
  key: typeof WORKSPACE_KEY;
  code: string;
  codeUpdatedAt: string;
  salt: string;
  nextAgentSeq: number;
  agents: VoxaAgentAccessAgent[];
  logs: VoxaAgentAccessLogRow[];
  artifacts: VoxaAgentAccessArtifactRow[];
};

type VoxaAgentAccessStore = {
  formatVersion: number;
  workspace: WorkspaceEntry;
};

function filePath() {
  return `${getVoxaDataRoot()}/agent-access.json`;
}

let writeQueue: Promise<unknown> = Promise.resolve();

function readStore(): VoxaAgentAccessStore {
  const file = filePath();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.formatVersion === AGENT_ACCESS_FORMAT_VERSION && value.workspace) {
      return value as VoxaAgentAccessStore;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error(`VOXA agent-access 存储损坏: ${(error as Error).message}`);
    }
  }
  // 首次读取（文件缺失或格式不符）：生成工作区条目并立即落盘。
  // 这里只读不写的话，readStore 每次都会“现生成”一个新随机识别码——面板每 3s
  // 轮询刷新一次，join 永远 INVALID_CODE（历史 BUG，修复于 2026-10-25）。
  const store: VoxaAgentAccessStore = {
    formatVersion: AGENT_ACCESS_FORMAT_VERSION,
    workspace: emptyEntry(),
  };
  writeStore(store);
  return store;
}

function emptyEntry(): WorkspaceEntry {
  return {
    key: WORKSPACE_KEY,
    code: generateCode('VOX'),
    codeUpdatedAt: new Date().toISOString(),
    salt: crypto.randomBytes(16).toString('hex'),
    nextAgentSeq: 1,
    agents: [],
    logs: [],
    artifacts: [],
  };
}

function writeStore(store: VoxaAgentAccessStore) {
  const file = filePath();
  fs.mkdirSync(getVoxaDataRoot(), { recursive: true });
  const staged = `${file}.staged-${process.pid}`;
  fs.writeFileSync(staged, JSON.stringify(store, null, 2));
  fs.renameSync(staged, file);
}

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

function hmac(salt: string, value: string): string {
  return crypto.createHmac('sha256', salt).update(value).digest('hex');
}

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizeCode(value: unknown): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9A-Z-]/g, '')
    .trim();
}

function appendLog(entry: WorkspaceEntry, row: Omit<VoxaAgentAccessLogRow, 'at'>) {
  entry.logs.unshift({
    at: new Date().toISOString(),
    ...row,
    detail: String(row.detail || '').slice(0, LOG_DETAIL_BYTES),
  });
  if (entry.logs.length > MAX_LOG_ROWS) entry.logs.length = MAX_LOG_ROWS;
}

export type VoxaAgentJoinResult =
  | { ok: true; token: string; agent: VoxaAgentAccessAgent }
  | { ok: false; code: 'INVALID_CODE' | 'AGENT_LIMIT' };

export function joinVoxaByCode(values: { code: unknown; name: unknown }): Promise<VoxaAgentJoinResult> {
  return mutate(() => {
    const store = readStore();
    const entry = store.workspace;
    const supplied = normalizeCode(values.code);
    if (!supplied || supplied !== normalizeCode(entry.code)) {
      return { ok: false as const, code: 'INVALID_CODE' as const };
    }
    const name = String(values.name || '').trim().slice(0, 60) || 'unnamed-agent';
    if (entry.agents.length >= MAX_AGENTS) {
      appendLog(entry, { agent: name, action: 'join', result: 'refused', detail: 'agent 数量已达上限' });
      writeStore(store);
      return { ok: false as const, code: 'AGENT_LIMIT' as const };
    }
    const token = `agx_${crypto.randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const agent: VoxaAgentAccessAgent = {
      id: `agent-${entry.nextAgentSeq}`,
      name,
      scope: 'voxa',
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
      detail: `VOXA 识别码验证通过（仅模型构建），令牌指纹 ${agent.fingerprint}`,
    });
    writeStore(store);
    return { ok: true as const, token, agent };
  });
}

export type VoxaAgentAuthResult =
  | { ok: true; agent: VoxaAgentAccessAgent }
  | { ok: false };

export function authenticateVoxaAgent(bearer: unknown): VoxaAgentAuthResult {
  const token = /^Bearer\s+(agx_\S+)$/i.exec(String(bearer || ''))?.[1] || '';
  if (!token) return { ok: false };
  const entry = readStore().workspace;
  const digest = hmac(entry.salt, token);
  const agent = entry.agents.find((candidate) => candidate.tokenHash === digest);
  return agent ? { ok: true, agent } : { ok: false };
}

export type VoxaAgentAction = {
  action: string;
  result: string;
  detail?: string;
  artifact?: { kind: string; name: string; detail?: string };
};

export async function recordVoxaAgentAction(
  agentId: string,
  action: VoxaAgentAction,
): Promise<void> {
  await mutate(() => {
    const store = readStore();
    const entry = store.workspace;
    const agent = entry.agents.find((candidate) => candidate.id === agentId);
    if (agent) agent.lastSeenAt = new Date().toISOString();
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
        kind: String(action.artifact.kind || 'model').slice(0, 40),
        name: String(action.artifact.name || '').slice(0, 160),
        detail: String(action.artifact.detail || '').slice(0, LOG_DETAIL_BYTES),
      });
      if (entry.artifacts.length > MAX_ARTIFACT_ROWS) entry.artifacts.length = MAX_ARTIFACT_ROWS;
    }
    writeStore(store);
  });
}

export type VoxaAgentPanelState = {
  code: string;
  codeUpdatedAt: string;
  agents: Array<Omit<VoxaAgentAccessAgent, 'tokenHash'>>;
  logs: VoxaAgentAccessLogRow[];
  artifacts: VoxaAgentAccessArtifactRow[];
};

export function voxaAgentPanelState(): VoxaAgentPanelState {
  const entry = readStore().workspace;
  return {
    code: entry.code,
    codeUpdatedAt: entry.codeUpdatedAt,
    agents: entry.agents.map(({ tokenHash: _tokenHash, ...rest }) => rest),
    logs: entry.logs,
    artifacts: entry.artifacts,
  };
}

export function rotateVoxaCode(): Promise<string> {
  return mutate(() => {
    const store = readStore();
    const entry = store.workspace;
    const previous = fingerprint(entry.code);
    entry.code = generateCode('VOX');
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

export function revokeVoxaAgent(agentId: string): Promise<boolean> {
  return mutate(() => {
    const store = readStore();
    const entry = store.workspace;
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

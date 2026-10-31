import { randomUUID } from 'node:crypto';

/**
 * Agent Live — the embodiment channel between a running editor tab and an AI.
 *
 * The browser editor keeps a long-poll open (`/api/agent/v1/live/next`); an
 * agent posts one command at a time (`.../map/<project>/cmd`) and waits for the
 * tab's acknowledgement. Every command is executed by the editor through the
 * same client-side APIs a human click uses (voxel transaction, camera config,
 * entity tree), so the human sees the work happen instead of finding a map that
 * changed behind their back.
 *
 * This hub is intentionally in-memory and single-editor-per-project: it lives
 * next to the Next.js process that serves the editor tab. A command that is
 * accepted but never acknowledged is reported as EDITOR_TIMEOUT, and the agent
 * must re-observe before retrying because the tab may still have applied it.
 */

export type LiveActor = { id: string; name: string };

export type LiveCommand = {
  id: string;
  seq: number;
  kind: string;
  args: Record<string, unknown>;
  actor: LiveActor;
  createdAt: string;
};

export type LiveCommandError = {
  code: string;
  message: string;
  hint?: string;
  retryable?: boolean;
};

export type LiveAck = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: LiveCommandError;
  snapshot?: Record<string, unknown>;
  at: string;
};

export type LiveSnapshot = Record<string, unknown>;

export type LiveActionState = {
  id: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'timeout';
  actor: LiveActor;
  at: string;
  summary?: string;
  result?: unknown;
};

/**
 * One dispatched command, from acceptance to receipt. The `id` is the
 * operation id the agent and the human panel both use to refer to it.
 */
export type LiveOperation = {
  operationId: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'timeout';
  actor: LiveActor;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
};

export type LiveProgressReceipt = {
  at: string;
  operationId?: string;
  note: string;
};

export type LiveStatus = {
  projectId: string;
  attached: boolean;
  stale: boolean;
  sessionId?: string;
  attachedAt?: string;
  lastSeenAt?: string;
  lastSeq: number;
  lastAction?: LiveActionState;
  snapshot?: LiveSnapshot;
  queued: number;
  /** A write is refused until the agent has observed the current world. */
  requiresObserve: boolean;
  operations: LiveOperation[];
  progress: LiveProgressReceipt[];
};

type Pending = {
  command: LiveCommand;
  startedAt: number;
  resolve: (ack: LiveAck) => void;
  timer: NodeJS.Timeout;
};

type Waiter = {
  after: number;
  resolve: (value: LivePollResult) => void;
  timer: NodeJS.Timeout;
};

type Session = {
  id: string;
  projectId: string;
  attachedAt: string;
  lastSeenAt: string;
  firstSeq: number;
  lastSeq: number;
  commands: Map<number, LiveCommand>;
  acked: Set<number>;
  waiters: Set<Waiter>;
  pending: Map<string, Pending>;
  lastSnapshot?: LiveSnapshot;
  lastAction?: LiveActionState;
  requiresObserve: boolean;
  operations: LiveOperation[];
  progress: LiveProgressReceipt[];
};

export type LivePollResult = {
  sessionInvalid?: boolean;
  reset?: boolean;
  lastSeq: number;
  command?: LiveCommand;
};

export type LiveCommandOutcome =
  | {
      ok: true;
      commandId: string;
      operationId: string;
      result?: unknown;
      snapshot?: LiveSnapshot;
      elapsedMs: number;
    }
  | {
      ok: false;
      commandId?: string;
      operationId?: string;
      error: LiveCommandError;
      elapsedMs: number;
    };

const STALE_MS = 120_000;
const POLL_WAIT_MS = 20_000;
const DEFAULT_COMMAND_WAIT_MS = 30_000;
const MAX_COMMAND_WAIT_MS = 120_000;
const MAX_BUFFERED_COMMANDS = 40;
const MAX_OPERATIONS = 40;
const MAX_PROGRESS = 40;

/**
 * Commands that never change authored content. They stay available while the
 * editor awaits an observe; every other command is refused with
 * OBSERVE_REQUIRED so a timed-out write cannot be blindly replayed.
 */
const OBSERVE_FREE_KINDS = new Set([
  'observe',
  'inspect',
  'look',
  'cursor',
  'entities',
  'script_files',
  'script_read',
  'screenshot',
  'say',
  'wait',
  'release_camera',
]);

/**
 * Process-wide singleton, not a module binding.
 *
 * Next.js compiles every API route into its own module graph, so `attach`,
 * `next`, `ack` and `status` each evaluate this file separately (dev and the
 * standalone server alike). A plain `const sessions = new Map()` therefore
 * gives each route its own empty hub: attach succeeds in one route while
 * status/next report "no editor" from another. `globalThis` is what makes the
 * four routes talk about the same editor tab.
 */
type LiveHub = { sessions: Map<string, Session> };
const LIVE_HUB_KEY = '__box3_agent_live_hub__';
const liveGlobal = globalThis as typeof globalThis & { [LIVE_HUB_KEY]?: LiveHub };
const liveHub: LiveHub =
  liveGlobal[LIVE_HUB_KEY] || (liveGlobal[LIVE_HUB_KEY] = { sessions: new Map<string, Session>() });
const sessions = liveHub.sessions;

function now() {
  return new Date().toISOString();
}

function isStale(session: Session) {
  return Date.now() - Date.parse(session.lastSeenAt) > STALE_MS;
}

function prune(session: Session) {
  while (session.commands.size > MAX_BUFFERED_COMMANDS) {
    const oldest = session.commands.keys().next();
    if (oldest.done) break;
    const seq = oldest.value;
    if (seq > session.lastSeq - MAX_BUFFERED_COMMANDS && !session.acked.has(seq)) break;
    session.commands.delete(seq);
    session.acked.delete(seq);
  }
  session.firstSeq = session.commands.size
    ? Math.min(...session.commands.keys())
    : session.lastSeq + 1;
}

function wake(session: Session) {
  for (const waiter of Array.from(session.waiters)) {
    const command = Array.from(session.commands.values())
      .sort((a, b) => a.seq - b.seq)
      .find((candidate) => candidate.seq > waiter.after && !session.acked.has(candidate.seq));
    if (!command) continue;
    session.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve({ lastSeq: session.lastSeq, command });
  }
}

export function attachEditor(
  projectId: string,
  options: { snapshot?: LiveSnapshot } = {},
): { sessionId: string; lastSeq: number; attachedAt: string; replacedSessionId?: string } {
  const previous = sessions.get(projectId);
  if (previous) {
    for (const waiter of previous.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ sessionInvalid: true, lastSeq: previous.lastSeq });
    }
    previous.waiters.clear();
    for (const pending of previous.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        id: pending.command.id,
        ok: false,
        error: {
          code: 'EDITOR_REATTACHED',
          message: '编辑器重新接入，旧会话的命令未执行',
          retryable: true,
          hint: '重新 observe 后再下发命令',
        },
        at: now(),
      });
    }
    previous.pending.clear();
  }

  const session: Session = {
    id: `live_${randomUUID()}`,
    projectId,
    attachedAt: now(),
    lastSeenAt: now(),
    firstSeq: 1,
    lastSeq: 0,
    commands: new Map(),
    acked: new Set(),
    waiters: new Set(),
    pending: new Map(),
    lastSnapshot: options.snapshot,
    lastAction: previous?.lastAction,
    // A fresh tab has not shown the agent anything yet. Whatever it knew from
    // the previous page load may be stale, so the first write must come after
    // an observe from this session.
    requiresObserve: true,
    operations: previous?.operations.slice(-MAX_OPERATIONS) ?? [],
    progress: [],
  };
  sessions.set(projectId, session);
  return {
    sessionId: session.id,
    lastSeq: session.lastSeq,
    attachedAt: session.attachedAt,
    replacedSessionId: previous?.id,
  };
}

export function detachEditor(projectId: string, sessionId: string): boolean {
  const session = sessions.get(projectId);
  if (!session || session.id !== sessionId) return false;
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve({ sessionInvalid: true, lastSeq: session.lastSeq });
  }
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({
      id: pending.command.id,
      ok: false,
      error: {
        code: 'EDITOR_DETACHED',
        message: '编辑器已关闭或离开该地图',
        retryable: true,
        hint: '重新打开编辑器后再 observe',
      },
      at: now(),
    });
  }
  sessions.delete(projectId);
  return true;
}

export function pollEditor(
  projectId: string,
  sessionId: string,
  after: number,
  waitMs = POLL_WAIT_MS,
): Promise<LivePollResult> {
  const session = sessions.get(projectId);
  if (!session || session.id !== sessionId) {
    return Promise.resolve({ sessionInvalid: true, lastSeq: session?.lastSeq ?? 0 });
  }
  session.lastSeenAt = now();

  if (after < session.firstSeq - 1) {
    return Promise.resolve({ reset: true, lastSeq: session.lastSeq });
  }

  const next = Array.from(session.commands.values())
    .sort((a, b) => a.seq - b.seq)
    .find((candidate) => candidate.seq > after && !session.acked.has(candidate.seq));
  if (next) {
    return Promise.resolve({ lastSeq: session.lastSeq, command: next });
  }

  return new Promise((resolve) => {
    const waiter: Waiter = {
      after,
      resolve,
      timer: setTimeout(() => {
        session.waiters.delete(waiter);
        resolve({ lastSeq: session.lastSeq });
      }, Math.max(1_000, Math.min(waitMs, 25_000))),
    };
    waiter.timer.unref?.();
    session.waiters.add(waiter);
  });
}

export function acknowledgeCommand(
  projectId: string,
  sessionId: string,
  ack: LiveAck,
): boolean {
  const session = sessions.get(projectId);
  if (!session || session.id !== sessionId) return false;
  session.lastSeenAt = now();
  if (ack.snapshot) session.lastSnapshot = ack.snapshot;

  const pending = session.pending.get(ack.id);
  if (!pending) {
    // A late ack after the agent timed out still belongs in the audit trail.
    const command = Array.from(session.commands.values()).find((candidate) => candidate.id === ack.id);
    if (command) {
      session.lastAction = {
        id: command.id,
        kind: command.kind,
        status: ack.ok ? 'ok' : 'error',
        actor: command.actor,
        at: ack.at || now(),
        summary: summarize(ack),
        result: ack.result,
      };
      completeOperation(session, command.id, ack.ok ? 'ok' : 'error', summarize(ack));
      if (ack.ok && command.kind === 'observe') session.requiresObserve = false;
    }
    return true;
  }

  session.pending.delete(ack.id);
  clearTimeout(pending.timer);
  session.acked.add(pending.command.seq);
  session.lastAction = {
    id: pending.command.id,
    kind: pending.command.kind,
    status: ack.ok ? 'ok' : 'error',
    actor: pending.command.actor,
    at: ack.at || now(),
    summary: summarize(ack),
    result: ack.result,
  };
  completeOperation(
    session,
    pending.command.id,
    ack.ok ? 'ok' : 'error',
    summarize(ack),
  );
  if (ack.ok && pending.command.kind === 'observe') session.requiresObserve = false;
  pending.resolve(ack);
  return true;
}

function completeOperation(
  session: Session,
  operationId: string,
  status: LiveOperation['status'],
  summary?: string,
) {
  const operation = session.operations.find((item) => item.operationId === operationId);
  if (!operation) return;
  operation.status = status;
  operation.finishedAt = now();
  operation.summary = summary;
}

export function progressEditor(
  projectId: string,
  sessionId: string,
  snapshot: LiveSnapshot,
  note?: string,
): boolean {
  const session = sessions.get(projectId);
  if (!session || session.id !== sessionId) return false;
  session.lastSeenAt = now();
  session.lastSnapshot = snapshot;
  if (note) {
    if (session.lastAction) session.lastAction.summary = note;
    session.progress.push({
      at: now(),
      operationId: session.lastAction?.id,
      note: note.slice(0, 200),
    });
    if (session.progress.length > MAX_PROGRESS) {
      session.progress.splice(0, session.progress.length - MAX_PROGRESS);
    }
  }
  return true;
}

export function dispatchCommand(
  projectId: string,
  kind: string,
  args: Record<string, unknown>,
  actor: LiveActor,
  waitMs = DEFAULT_COMMAND_WAIT_MS,
): Promise<LiveCommandOutcome> {
  const startedAt = Date.now();
  const session = sessions.get(projectId);
  if (!session) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'EDITOR_NOT_ATTACHED',
        message: '该地图当前没有打开的编辑器',
        retryable: true,
        hint: '在 Creator 编辑器里打开这张地图并保持标签页可见，然后重试',
      },
      elapsedMs: 0,
    });
  }
  if (isStale(session)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'EDITOR_STALE',
        message: '编辑器已超过 2 分钟没有心跳',
        retryable: true,
        hint: '确认编辑器标签页仍在运行；重新打开地图即可恢复',
      },
      elapsedMs: 0,
    });
  }
  if (session.requiresObserve && !OBSERVE_FREE_KINDS.has(kind)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'OBSERVE_REQUIRED',
        message: `在上一次超时/重连后还没有重新 observe，拒绝执行 ${kind}`,
        retryable: true,
        hint: '先调用 observe 读取当前地图；如果那一步其实已经生效，避免重复写入',
      },
      elapsedMs: 0,
    });
  }

  const seq = session.lastSeq + 1;
  const command: LiveCommand = {
    id: `cmd_${seq}_${randomUUID().slice(0, 8)}`,
    seq,
    kind,
    args: args || {},
    actor,
    createdAt: now(),
  };
  session.lastSeq = seq;
  session.commands.set(seq, command);
  session.lastAction = {
    id: command.id,
    kind,
    status: 'running',
    actor,
    at: command.createdAt,
    summary: `等待编辑器执行 ${kind}`,
  };
  session.operations.push({
    operationId: command.id,
    kind,
    status: 'running',
    actor,
    startedAt: command.createdAt,
  });
  if (session.operations.length > MAX_OPERATIONS) {
    session.operations.splice(0, session.operations.length - MAX_OPERATIONS);
  }
  prune(session);
  wake(session);

  return new Promise((resolve) => {
    const timeoutMs = Math.max(5_000, Math.min(waitMs, MAX_COMMAND_WAIT_MS));
    const timer = setTimeout(() => {
      session.pending.delete(command.id);
      session.requiresObserve = true;
      session.lastAction = {
        id: command.id,
        kind,
        status: 'timeout',
        actor,
        at: now(),
        summary: `命令 ${kind} 超过 ${timeoutMs} ms 未回执`,
      };
      completeOperation(session, command.id, 'timeout', '回执超时，必须先 observe');
      resolve({
        ok: false,
        commandId: command.id,
        operationId: command.id,
        error: {
          code: 'EDITOR_TIMEOUT',
          message: `编辑器在 ${timeoutMs} ms 内没有回执`,
          retryable: true,
          hint: '先 observe 确认这一步是否已经生效，再决定是否重试；不要盲目重放写操作',
        },
        elapsedMs: Date.now() - startedAt,
      });
    }, timeoutMs);
    timer.unref?.();
    session.pending.set(command.id, {
      command,
      startedAt,
      timer,
      resolve: (ack) => {
        resolve(
          ack.ok
            ? {
                ok: true,
                commandId: command.id,
                operationId: command.id,
                result: ack.result,
                snapshot: ack.snapshot,
                elapsedMs: Date.now() - startedAt,
              }
            : {
                ok: false,
                commandId: command.id,
                operationId: command.id,
                error: ack.error || {
                  code: 'EDITOR_REFUSED',
                  message: '编辑器拒绝执行该命令',
                  retryable: false,
                },
                elapsedMs: Date.now() - startedAt,
              },
        );
      },
    });
  });
}

export function liveStatus(projectId: string): LiveStatus {
  const session = sessions.get(projectId);
  if (!session) {
    return {
      projectId,
      attached: false,
      stale: false,
      lastSeq: 0,
      queued: 0,
      requiresObserve: true,
      operations: [],
      progress: [],
    };
  }
  const stale = isStale(session);
  return {
    projectId,
    attached: !stale,
    stale,
    sessionId: session.id,
    attachedAt: session.attachedAt,
    lastSeenAt: session.lastSeenAt,
    lastSeq: session.lastSeq,
    lastAction: session.lastAction,
    snapshot: session.lastSnapshot,
    queued: Array.from(session.commands.values()).filter((command) => !session.acked.has(command.seq)).length,
    requiresObserve: session.requiresObserve,
    operations: session.operations.slice(-20),
    progress: session.progress.slice(-20),
  };
}

/** Drop a project session entirely. Used by tests and explicit editor reset. */
export function resetLiveSession(projectId: string): void {
  sessions.delete(projectId);
}

function summarize(ack: LiveAck) {
  if (!ack.ok) return ack.error?.message || '执行失败';
  if (typeof ack.result === 'string') return ack.result.slice(0, 160);
  if (ack.result && typeof ack.result === 'object') {
    const record = ack.result as Record<string, unknown>;
    const summary = record.summary || record.message;
    if (typeof summary === 'string') return summary.slice(0, 160);
  }
  return '执行完成';
}

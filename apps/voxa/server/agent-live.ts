import { randomUUID } from 'node:crypto';

/**
 * VOXA Agent Live — the embodiment channel between an open VOXA editor tab and
 * an AI.
 *
 * Same contract as the map side (`apps/game/server/agent-live.ts`): the tab
 * holds a long poll, the agent posts one command at a time and waits for the
 * tab's acknowledgement, and every command runs through the same camera,
 * pointer and voxel APIs a human uses. The difference is scope: a VOXA
 * workspace has one editor, so the session key is a fixed workspace key and a
 * new attach replaces the previous tab.
 *
 * Kept as an independent module (not shared) because the two applications are
 * separate Rush projects with separate deploy images; a cross-app import would
 * couple their build graphs.
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
  attached: boolean;
  stale: boolean;
  sessionId?: string;
  attachedAt?: string;
  lastSeenAt?: string;
  lastSeq: number;
  lastAction?: LiveActionState;
  snapshot?: LiveSnapshot;
  queued: number;
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

const OBSERVE_FREE_KINDS = new Set([
  'observe',
  'inspect',
  'look',
  'cursor',
  'palette',
  'screenshot',
  'say',
  'wait',
]);

/** One editor per deployment process, so one slot. */
let session: Session | undefined;

function now() {
  return new Date().toISOString();
}

function isStale(value: Session) {
  return Date.now() - Date.parse(value.lastSeenAt) > STALE_MS;
}

function prune(value: Session) {
  while (value.commands.size > MAX_BUFFERED_COMMANDS) {
    const oldest = value.commands.keys().next();
    if (oldest.done) break;
    const seq = oldest.value;
    if (seq > value.lastSeq - MAX_BUFFERED_COMMANDS && !value.acked.has(seq)) break;
    value.commands.delete(seq);
    value.acked.delete(seq);
  }
  value.firstSeq = value.commands.size ? Math.min(...value.commands.keys()) : value.lastSeq + 1;
}

function wake(value: Session) {
  for (const waiter of Array.from(value.waiters)) {
    const command = Array.from(value.commands.values())
      .sort((left, right) => left.seq - right.seq)
      .find((candidate) => candidate.seq > waiter.after && !value.acked.has(candidate.seq));
    if (!command) continue;
    value.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve({ lastSeq: value.lastSeq, command });
  }
}

export function attachVoxaEditor(
  options: { snapshot?: LiveSnapshot } = {},
): { sessionId: string; lastSeq: number; attachedAt: string; replacedSessionId?: string } {
  const previous = session;
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
          message: 'VOXA 编辑器重新接入，旧会话的命令未执行',
          retryable: true,
          hint: '重新 observe 后再下发命令',
        },
        at: now(),
      });
    }
    previous.pending.clear();
  }

  session = {
    id: `vxlive_${randomUUID()}`,
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
    requiresObserve: true,
    operations: previous?.operations.slice(-MAX_OPERATIONS) ?? [],
    progress: [],
  };
  return {
    sessionId: session.id,
    lastSeq: session.lastSeq,
    attachedAt: session.attachedAt,
    replacedSessionId: previous?.id,
  };
}

export function detachVoxaEditor(sessionId: string): boolean {
  const current = session;
  if (!current || current.id !== sessionId) return false;
  for (const waiter of current.waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve({ sessionInvalid: true, lastSeq: current.lastSeq });
  }
  for (const pending of current.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({
      id: pending.command.id,
      ok: false,
      error: {
        code: 'EDITOR_DETACHED',
        message: 'VOXA 编辑器已关闭',
        retryable: true,
        hint: '重新打开 VOXA 后再 observe',
      },
      at: now(),
    });
  }
  session = undefined;
  return true;
}

export function pollVoxaEditor(
  sessionId: string,
  after: number,
  waitMs = POLL_WAIT_MS,
): Promise<LivePollResult> {
  const current = session;
  if (!current || current.id !== sessionId) {
    return Promise.resolve({ sessionInvalid: true, lastSeq: current?.lastSeq ?? 0 });
  }
  current.lastSeenAt = now();

  if (after < current.firstSeq - 1) {
    return Promise.resolve({ reset: true, lastSeq: current.lastSeq });
  }

  const next = Array.from(current.commands.values())
    .sort((left, right) => left.seq - right.seq)
    .find((candidate) => candidate.seq > after && !current.acked.has(candidate.seq));
  if (next) return Promise.resolve({ lastSeq: current.lastSeq, command: next });

  return new Promise((resolve) => {
    const waiter: Waiter = {
      after,
      resolve,
      timer: setTimeout(() => {
        current.waiters.delete(waiter);
        resolve({ lastSeq: current.lastSeq });
      }, Math.max(1_000, Math.min(waitMs, 25_000))),
    };
    waiter.timer.unref?.();
    current.waiters.add(waiter);
  });
}

export function acknowledgeVoxaCommand(sessionId: string, ack: LiveAck): boolean {
  const current = session;
  if (!current || current.id !== sessionId) return false;
  current.lastSeenAt = now();
  if (ack.snapshot) current.lastSnapshot = ack.snapshot;

  const pending = current.pending.get(ack.id);
  if (!pending) {
    const command = Array.from(current.commands.values()).find(
      (candidate) => candidate.id === ack.id,
    );
    if (command) {
      current.lastAction = {
        id: command.id,
        kind: command.kind,
        status: ack.ok ? 'ok' : 'error',
        actor: command.actor,
        at: ack.at || now(),
        summary: summarize(ack),
        result: ack.result,
      };
      completeOperation(current, command.id, ack.ok ? 'ok' : 'error', summarize(ack));
      if (ack.ok && command.kind === 'observe') current.requiresObserve = false;
    }
    return true;
  }

  current.pending.delete(ack.id);
  clearTimeout(pending.timer);
  current.acked.add(pending.command.seq);
  current.lastAction = {
    id: pending.command.id,
    kind: pending.command.kind,
    status: ack.ok ? 'ok' : 'error',
    actor: pending.command.actor,
    at: ack.at || now(),
    summary: summarize(ack),
    result: ack.result,
  };
  completeOperation(
    current,
    pending.command.id,
    ack.ok ? 'ok' : 'error',
    summarize(ack),
  );
  if (ack.ok && pending.command.kind === 'observe') current.requiresObserve = false;
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

export function progressVoxaEditor(
  sessionId: string,
  snapshot: LiveSnapshot,
  note?: string,
): boolean {
  const current = session;
  if (!current || current.id !== sessionId) return false;
  current.lastSeenAt = now();
  current.lastSnapshot = snapshot;
  if (note) {
    if (current.lastAction) current.lastAction.summary = note;
    current.progress.push({
      at: now(),
      operationId: current.lastAction?.id,
      note: note.slice(0, 200),
    });
    if (current.progress.length > MAX_PROGRESS) {
      current.progress.splice(0, current.progress.length - MAX_PROGRESS);
    }
  }
  return true;
}

export function dispatchVoxaCommand(
  kind: string,
  args: Record<string, unknown>,
  actor: LiveActor,
  waitMs = DEFAULT_COMMAND_WAIT_MS,
): Promise<LiveCommandOutcome> {
  const startedAt = Date.now();
  const current = session;
  if (!current) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'EDITOR_NOT_ATTACHED',
        message: '当前没有打开的 VOXA 编辑器',
        retryable: true,
        hint: '在浏览器打开 VOXA（本地 :3123 或部署域名），保持标签页可见，然后重试',
      },
      elapsedMs: 0,
    });
  }
  if (isStale(current)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'EDITOR_STALE',
        message: 'VOXA 编辑器已超过 2 分钟没有心跳',
        retryable: true,
        hint: '确认标签页仍在运行；刷新后重新 observe',
      },
      elapsedMs: 0,
    });
  }
  if (current.requiresObserve && !OBSERVE_FREE_KINDS.has(kind)) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'OBSERVE_REQUIRED',
        message: `在上一次超时/重连后还没有重新 observe，拒绝执行 ${kind}`,
        retryable: true,
        hint: '先调用 observe 读取当前模型；如果那一步其实已经生效，避免重复写入',
      },
      elapsedMs: 0,
    });
  }

  const seq = current.lastSeq + 1;
  const command: LiveCommand = {
    id: `vxcmd_${seq}_${randomUUID().slice(0, 8)}`,
    seq,
    kind,
    args: args || {},
    actor,
    createdAt: now(),
  };
  current.lastSeq = seq;
  current.commands.set(seq, command);
  current.lastAction = {
    id: command.id,
    kind,
    status: 'running',
    actor,
    at: command.createdAt,
    summary: `等待编辑器执行 ${kind}`,
  };
  current.operations.push({
    operationId: command.id,
    kind,
    status: 'running',
    actor,
    startedAt: command.createdAt,
  });
  if (current.operations.length > MAX_OPERATIONS) {
    current.operations.splice(0, current.operations.length - MAX_OPERATIONS);
  }
  prune(current);
  wake(current);

  return new Promise((resolve) => {
    const timeoutMs = Math.max(5_000, Math.min(waitMs, MAX_COMMAND_WAIT_MS));
    const timer = setTimeout(() => {
      current.pending.delete(command.id);
      current.requiresObserve = true;
      current.lastAction = {
        id: command.id,
        kind,
        status: 'timeout',
        actor,
        at: now(),
        summary: `命令 ${kind} 超过 ${timeoutMs} ms 未回执`,
      };
      completeOperation(current, command.id, 'timeout', '回执超时，必须先 observe');
      resolve({
        ok: false,
        commandId: command.id,
        operationId: command.id,
        error: {
          code: 'EDITOR_TIMEOUT',
          message: `VOXA 编辑器在 ${timeoutMs} ms 内没有回执`,
          retryable: true,
          hint: '先 observe 确认这一步是否已经生效，再决定是否重试；不要盲目重放写操作',
        },
        elapsedMs: Date.now() - startedAt,
      });
    }, timeoutMs);
    timer.unref?.();
    current.pending.set(command.id, {
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
                  message: 'VOXA 编辑器拒绝执行该命令',
                  retryable: false,
                },
                elapsedMs: Date.now() - startedAt,
              },
        );
      },
    });
  });
}

export function voxaLiveStatus(): LiveStatus {
  const current = session;
  if (!current) {
    return {
      attached: false,
      stale: false,
      lastSeq: 0,
      queued: 0,
      requiresObserve: true,
      operations: [],
      progress: [],
    };
  }
  const stale = isStale(current);
  return {
    attached: !stale,
    stale,
    sessionId: current.id,
    attachedAt: current.attachedAt,
    lastSeenAt: current.lastSeenAt,
    lastSeq: current.lastSeq,
    lastAction: current.lastAction,
    snapshot: current.lastSnapshot,
    queued: Array.from(current.commands.values()).filter(
      (command) => !current.acked.has(command.seq),
    ).length,
    requiresObserve: current.requiresObserve,
    operations: current.operations.slice(-20),
    progress: current.progress.slice(-20),
  };
}

/** Drop the session entirely. Used by tests and explicit editor reset. */
export function resetVoxaLiveSession(): void {
  session = undefined;
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

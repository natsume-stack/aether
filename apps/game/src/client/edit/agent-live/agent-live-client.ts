import { quat, vec3 } from 'gl-matrix';
import { CameraMode } from '@box/schema/camera/camera-schema';
import { EntitySeedRDA } from '@box/schema/project/project-rda';
import { VoxelRaycastHitResult, raycast } from '@box/schema/voxel/voxel-raycast';

import { clientConfig } from 'src/config/client';
import { screenToRay } from 'src/engine/camera/camera-controller';
import { reduxDispatch, store } from 'src/redux/edit';
import { setNavMode } from 'src/redux/edit/creator';
import { setSelectedTreeNodes } from 'src/redux/edit/seeds';
import { LeftNavModeEnum } from 'src/views/edit/defs';
import type { EditClient } from '../edit-client';
import {
  getAgentPresence,
  resetAgentPresence,
  setAgentPresence,
} from './presence';

type Vec3Tuple = [number, number, number];

type LiveCommand = {
  id: string;
  seq: number;
  kind: string;
  args: Record<string, unknown>;
  actor: { id: string; name: string };
  createdAt: string;
};

type CommandFailure = { code: string; message: string; hint?: string };
type CommandResult = Record<string, unknown>;

const KIND_LABEL: Record<string, string> = {
  observe: '观察世界',
  inspect: '读取体素',
  look: '移动视角',
  cursor: '移动光标',
  place: '放置方块',
  erase: '移除方块',
  place_path: '沿路径搭建',
  fill_box: '填充区域',
  entities: '查看实体',
  select_entity: '选中实体',
  place_model: '放置模型',
  undo: '撤销',
  redo: '重做',
  save: '保存地图',
  preview_start: '启动预览',
  preview_stop: '停止预览',
  say: '播报',
  wait: '停留观察',
  screenshot: '截图',
  release_camera: '交还视角',
  script_files: '查看脚本',
  script_open: '打开脚本',
  script_read: '读取脚本',
  script_replace: '改写脚本',
  script_insert: '插入代码',
};

const MAX_PATH_POINTS = 2_048;
/** Upper bound for one live command before the tab reports a timeout and moves on. */
const COMMAND_DEADLINE_MS = 30_000;
const MAX_FILL_BLOCKS = 8_192;

/** Commands that change authored content and therefore need a fresh observe. */
const WRITE_KINDS = new Set([
  'place',
  'erase',
  'place_path',
  'fill_box',
  'place_model',
  'undo',
  'redo',
  'save',
  'script_replace',
  'script_insert',
  'preview_start',
  'preview_stop',
]);

type ActivityEntry = {
  operationId: string;
  actor: 'agent' | 'human';
  name: string;
  kind: string;
  at: string;
  summary: string;
  revision: number;
  undoDepth: number;
};

type ProgressReceipt = {
  at: string;
  done: number;
  total: number;
  note: string;
};

class LiveCommandError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'LiveCommandError';
  }
}

class CameraTween {
  private token = 0;

  cancel() {
    this.token += 1;
  }

  run(durationMs: number, onFrame: (t: number) => void): Promise<void> {
    const token = ++this.token;
    if (durationMs <= 0) {
      onFrame(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        if (token !== this.token) {
          resolve();
          return;
        }
        const raw = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - raw, 3);
        onFrame(eased);
        if (raw < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function asVec3(value: unknown): Vec3Tuple | undefined {
  if (Array.isArray(value) && value.length >= 3) {
    const tuple = value.slice(0, 3).map(Number);
    if (tuple.every(Number.isFinite)) return tuple as Vec3Tuple;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const x = Number(record.x);
    const y = Number(record.y);
    const z = Number(record.z);
    if ([x, y, z].every(Number.isFinite)) return [x, y, z];
  }
  return undefined;
}

function tuple(value: vec3 | ArrayLike<number>): Vec3Tuple {
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}

function roundTuple(value: ArrayLike<number>): Vec3Tuple {
  return [Math.round(value[0]), Math.round(value[1]), Math.round(value[2])];
}

function blockOf(state: any, id: number) {
  return state.blockIndex?.name?.[id] || state.blockInfo?.names?.[id] || String(id);
}

function resolveBlock(state: any, value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { id: value, name: blockOf(state, value) };
  }
  const name = String(value || '').trim();
  if (!name) {
    throw new LiveCommandError(
      'BLOCK_REQUIRED',
      '需要 block 参数（方块 id 或名称，如 stone / grass / 石头）',
      `示例：${Object.keys(state.blockIndex?.id || {}).slice(0, 12).join(', ')}`,
    );
  }
  const id = state.blockIndex?.id?.[name];
  if (!Number.isInteger(id)) {
    const known = Object.keys(state.blockIndex?.id || {});
    const fuzzy = known.filter((candidate) => candidate.includes(name)).slice(0, 12);
    throw new LiveCommandError(
      'UNKNOWN_BLOCK',
      `未知方块：${name}`,
      fuzzy.length ? `相近名称：${fuzzy.join(', ')}` : `可用示例：${known.slice(0, 16).join(', ')}`,
    );
  }
  return { id, name: blockOf(state, id) };
}

export class AgentLiveSession {
  private stopped = false;
  private sessionId = '';
  private container = '';
  private after = 0;
  private pollAbort: AbortController | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private cameraTween = new CameraTween();
  private savedCamera:
    | { mode: number; eye: Vec3Tuple; target: Vec3Tuple; distance: number; fovY: number }
    | undefined;
  private lastProgressAt = 0;
  private humanCameraHandler = () => this.releaseCamera();

  // Content revision tracking. Every local voxel write funnels through
  // `setVoxelOptimistic`, so wrapping it once gives a single counter that both
  // AI and human edits bump — and lets the agent prove it observed the world
  // it is about to overwrite.
  private terrainRevision = 0;
  private humanEpoch = 0;
  private observedHumanEpoch = -1;
  private observedUndoDepth = -1;
  private hasObserved = false;
  private agentWriteDepth = 0;
  private undoDepthAfterAgentWrite = -1;
  private currentOperationId = '';
  private activity: ActivityEntry[] = [];
  private humanOperation:
    | { id: string; lastAt: number; writes: number; entry: ActivityEntry }
    | undefined;
  private voxelInstrumented = false;

  constructor(private editor: EditClient) {}

  public start() {
    this.container = String(clientConfig.name || '').trim();
    if (!this.container) {
      setAgentPresence({
        phase: 'error',
        error: '无法识别当前地图容器（clientConfig.name 为空），活体通道未启动',
      });
      return;
    }
    setAgentPresence({ phase: 'connecting' });
    this.instrumentVoxel();
    void this.connectLoop();
  }

  public stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cameraTween.cancel();
    this.pollAbort?.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.removeHumanCameraListener();
    this.releaseCamera();
    const sessionId = this.sessionId;
    const container = this.container;
    this.sessionId = '';
    resetAgentPresence();
    if (sessionId && container) {
      void fetch('/api/agent/v1/live/detach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, sessionId }),
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  private async connectLoop() {
    while (!this.stopped) {
      try {
        await this.attach();
        await this.pollLoop();
      } catch (error) {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        setAgentPresence({ phase: 'error', error: message });
        await sleep(4_000);
      }
    }
  }

  private async attach() {
    const response = await fetch('/api/agent/v1/live/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: this.container, snapshot: this.snapshot() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || `活体接入失败（HTTP ${response.status}）`);
    }
    this.sessionId = String(data.sessionId || '');
    this.after = Number(data.lastSeq) || 0;
    setAgentPresence({
      phase: 'attached',
      sessionId: this.sessionId,
      error: undefined,
      note: 'AI 通道已接入，等待指令',
    });
    this.addHumanCameraListener();
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.postProgress('心跳'), 4_000);
    }
  }

  private async pollLoop() {
    while (!this.stopped && this.sessionId) {
      const controller = new AbortController();
      this.pollAbort = controller;
      try {
        const response = await fetch(
          `/api/agent/v1/live/next?container=${encodeURIComponent(this.container)}` +
            `&sessionId=${encodeURIComponent(this.sessionId)}&after=${this.after}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (response.status === 409) {
          this.sessionId = '';
          setAgentPresence({ phase: 'connecting', error: undefined });
          return;
        }
        if (!response.ok) {
          await sleep(2_000);
          continue;
        }
        const data = await response.json();
        if (data.reset) {
          this.after = Number(data.lastSeq) || this.after;
          continue;
        }
        const command = data.command as LiveCommand | undefined;
        if (!command) continue;
        this.after = command.seq;
        await this.executeWithDeadline(command);
      } catch (error) {
        if (this.stopped || controller.signal.aborted) return;
        await sleep(1_500);
      }
    }
  }

  /**
   * A command that wedges must not wedge the queue. The editor executes one
   * command at a time; without a deadline a single stuck animation (or a
   * throttled background tab) leaves every later command unacked and the hub
   * queue grows until the agent gives up. Report a timeout once, then continue.
   */
  private async executeWithDeadline(command: LiveCommand) {
    let settled = false;
    const running = this.execute(command).finally(() => { settled = true; });
    const deadline = sleep(COMMAND_DEADLINE_MS).then(() => {
      if (settled) return;
      settled = true;
      void this.postAck(command.id, false, undefined, this.snapshot(), {
        code: 'CLIENT_TIMEOUT',
        message: `命令在编辑器内超过 ${Math.round(COMMAND_DEADLINE_MS / 1000)} 秒未完成，已跳过`,
        hint: '先 observe 确认这一步是否已经生效，再决定是否重发',
      });
      setAgentPresence((current) => ({
        ...current,
        action: { kind: command.kind, label: KIND_LABEL[command.kind] || command.kind, status: 'error', detail: '超时已跳过', operationId: command.id, at: Date.now() },
        note: '命令超时，已跳过并继续处理队列',
      }));
    });
    await Promise.race([running.catch(() => undefined), deadline]);
  }

  private async execute(command: LiveCommand) {
    const label = KIND_LABEL[command.kind] || command.kind;
    this.currentOperationId = command.id;
    setAgentPresence((current) => ({
      ...current,
      agentName: command.actor?.name || current.agentName,
      action: {
        kind: command.kind,
        label,
        status: 'running',
        operationId: command.id,
        at: Date.now(),
      },
      note: `${command.actor?.name || 'AI'} 正在${label}`,
    }));

    try {
      this.ensureWriteAllowed(command.kind);
      const result = (await this.run(command.kind, command.args || {})) as CommandResult;
      const enriched = { ...result, operationId: command.id };
      const snapshot =
        (result?.snapshot as Record<string, unknown> | undefined) || this.snapshot();
      await this.postAck(command.id, true, enriched, snapshot);
      setAgentPresence((current) => ({
        ...current,
        action: {
          kind: command.kind,
          label,
          status: 'done',
          detail: typeof result?.summary === 'string' ? result.summary : undefined,
          operationId: command.id,
          at: Date.now(),
        },
        note: typeof result?.summary === 'string' ? result.summary : `已完成：${label}`,
      }));
    } catch (error) {
      const failure: CommandFailure =
        error instanceof LiveCommandError
          ? { code: error.code, message: error.message, hint: error.hint }
          : {
              code: 'EXECUTION_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
      await this.postAck(command.id, false, undefined, this.snapshot(), failure);
      setAgentPresence((current) => ({
        ...current,
        action: {
          kind: command.kind,
          label,
          status: 'error',
          detail: failure.message,
          operationId: command.id,
          at: Date.now(),
        },
        note: `${label}失败：${failure.message}`,
      }));
    } finally {
      this.currentOperationId = '';
    }
  }

  private instrumentVoxel() {
    if (this.voxelInstrumented) return;
    // Writes go through the VoxelClient (`game.voxel.setVoxelOptimistic`),
    // while `state.voxel` is only the VoxelView data used for reads.
    const voxel: any = (this.editor.game as any)?.voxel;
    if (!voxel || typeof voxel.setVoxelOptimistic !== 'function') return;
    const original = voxel.setVoxelOptimistic.bind(voxel);
    const session = this;
    voxel.setVoxelOptimistic = function patchedSetVoxelOptimistic(
      x: number,
      y: number,
      z: number,
      block: number,
    ) {
      const result = original(x, y, z, block);
      session.terrainRevision += 1;
      if (session.agentWriteDepth === 0) session.noteHumanWrite();
      return result;
    };
    (voxel as any).__agentLiveInstrumented = true;
    this.voxelInstrumented = true;
  }

  private noteHumanWrite = () => {
    const nowMs = Date.now();
    const previous = this.humanOperation;
    if (!previous || nowMs - previous.lastAt > 700) {
      const entry: ActivityEntry = {
        operationId: `human_${nowMs.toString(36)}_${this.humanEpoch + 1}`,
        actor: 'human',
        name: 'human',
        kind: 'voxel',
        at: new Date(nowMs).toISOString(),
        summary: '人工编辑地形',
        revision: this.terrainRevision,
        undoDepth: this.currentUndoDepth(),
      };
      this.humanOperation = { id: entry.operationId, lastAt: nowMs, writes: 0, entry };
      this.pushActivity(entry);
      setAgentPresence({ note: '检测到人工编辑；AI 需要重新 observe 后再继续' });
    }
    const operation = this.humanOperation!;
    operation.lastAt = nowMs;
    operation.writes += 1;
    operation.entry.summary = `人工编辑地形（${operation.writes} 格）`;
    operation.entry.revision = this.terrainRevision;
    this.humanEpoch += 1;
  };

  private currentUndoDepth(): number {
    try {
      return Number((this.editor.state.replica as any)?.undoHistory?.length) || 0;
    } catch {
      return 0;
    }
  }

  private pushActivity(entry: ActivityEntry) {
    this.activity.push(entry);
    if (this.activity.length > 60) this.activity.splice(0, this.activity.length - 60);
  }

  private recordAgentActivity(kind: string, summary: string) {
    const entry: ActivityEntry = {
      operationId: this.currentOperationId || `agent_${Date.now().toString(36)}`,
      actor: 'agent',
      name: getAgentPresence().agentName || 'agent',
      kind,
      at: new Date().toISOString(),
      summary,
      revision: this.terrainRevision,
      undoDepth: this.currentUndoDepth(),
    };
    this.pushActivity(entry);
    this.observedUndoDepth = entry.undoDepth;
    if (kind !== 'save' && kind !== 'script_replace' && kind !== 'script_insert') {
      this.undoDepthAfterAgentWrite = entry.undoDepth;
    }
  }

  private ensureWriteAllowed(kind: string) {
    if (!WRITE_KINDS.has(kind)) return;
    if (!this.hasObserved) {
      throw new LiveCommandError(
        'OBSERVE_REQUIRED',
        '还没有观察这张地图，拒绝写入',
        '先调用 observe 读取相机、光标与当前地形，再下发写命令',
      );
    }
    if (
      this.humanEpoch !== this.observedHumanEpoch ||
      this.currentUndoDepth() !== this.observedUndoDepth
    ) {
      throw new LiveCommandError(
        'HUMAN_EDITED',
        '上次观察之后有人工编辑了地图，拒绝覆盖',
        `先 observe 看清新状态（自上次观察以来人工改动 ${Math.max(
          0,
          this.humanEpoch - this.observedHumanEpoch,
        )} 格），基于它继续`,
      );
    }
  }

  private async run(kind: string, args: Record<string, unknown>): Promise<CommandResult> {
    switch (kind) {
      case 'observe':
        return this.observe(args);
      case 'inspect':
        return this.inspect(args);
      case 'look':
        return this.look(args);
      case 'cursor':
        return this.moveCursor(args);
      case 'place':
        return this.place(args);
      case 'erase':
        return this.erase(args);
      case 'place_path':
        return this.placePath(args);
      case 'fill_box':
        return this.fillBox(args);
      case 'entities':
        return this.listEntities(args);
      case 'select_entity':
        return this.selectEntity(args);
      case 'place_model':
        return this.placeModel(args);
      case 'undo':
        return this.undoAction();
      case 'redo':
        return this.redoAction();
      case 'save':
        return this.save();
      case 'preview_start':
        await this.editor.replica.startProject();
        return { summary: '预览已启动' };
      case 'preview_stop':
        await this.editor.replica.stopProject();
        return { summary: '预览已停止' };
      case 'say':
        return this.say(args);
      case 'wait':
        await sleep(Math.min(5_000, Math.max(0, Number(args.ms) || 0)));
        return { summary: '已停留观察' };
      case 'screenshot':
        return this.screenshot();
      case 'release_camera':
        this.releaseCamera();
        return { summary: '视角已交还给人' };
      case 'script_files':
        return this.scriptFiles();
      case 'script_open':
        return this.scriptOpen(args);
      case 'script_read':
        return this.scriptRead(args);
      case 'script_replace':
        return this.scriptReplace(args);
      case 'script_insert':
        return this.scriptInsert(args);
      default:
        throw new LiveCommandError(
          'UNKNOWN_COMMAND',
          `不认识的指令：${kind}`,
          `支持：${Object.keys(KIND_LABEL).join(', ')}`,
        );
    }
  }

  private observe(args: Record<string, unknown>): CommandResult {
    this.hasObserved = true;
    this.observedHumanEpoch = this.humanEpoch;
    this.observedUndoDepth = this.currentUndoDepth();
    const snapshot = this.snapshot({ includeTerrain: Boolean(args.includeTerrain) });
    return { summary: '观察完成', snapshot };
  }

  private inspect(args: Record<string, unknown>): CommandResult {
    const cells = Array.isArray(args.cells)
      ? (args.cells.map(asVec3).filter(Boolean) as Vec3Tuple[])
      : [];
    if (!cells.length) {
      throw new LiveCommandError('INVALID_ARGS', 'inspect 需要 cells: [[x,y,z], ...]');
    }
    const state = this.editor.game.state;
    const shape = state.voxel.shape;
    const blocks = cells.slice(0, 256).map((cell) => {
      const voxel = roundTuple(cell);
      const inside =
        voxel[0] >= 0 && voxel[1] >= 0 && voxel[2] >= 0 &&
        voxel[0] < shape[0] && voxel[1] < shape[1] && voxel[2] < shape[2];
      const block = inside ? state.voxel.getVoxel(voxel[0], voxel[1], voxel[2]) : -1;
      return {
        at: voxel,
        inside,
        block,
        blockName: inside ? blockOf(state, block) : null,
      };
    });
    return {
      summary: `读取 ${blocks.length} 格`,
      cells: blocks,
      revision: this.terrainRevision,
      undoDepth: this.currentUndoDepth(),
    };
  }

  /** Local review action: no command queue, observation prerequisite or map write.
   * Reuses the existing camera restore-on-human-input behavior. */
  public reviewRegion(region: { min: number[]; max: number[] }) {
    if (region.min.length !== 3 || region.max.length !== 3 ||
      ![...region.min,...region.max].every(Number.isFinite) ||
      region.min.some((value,axis)=>value > region.max[axis]))
      throw new Error('无法定位无效选区');
    const target = region.min.map((value,axis)=>(value+region.max[axis]+1)/2);
    const distance = Math.max(12,Math.hypot(...region.max.map((value,axis)=>value-region.min[axis]+1))*1.8);
    return this.look({target,distance,pitch:0.9,yaw:-0.65,durationMs:0});
  }

  public endRegionReview() { this.releaseCamera(); }

  private async look(args: Record<string, unknown>): Promise<CommandResult> {
    const target = asVec3(args.target) || asVec3(args.at);
    if (!target) {
      throw new LiveCommandError('INVALID_ARGS', 'look 需要 target: [x,y,z]', '例如 {"target":[12,8,30],"distance":24}');
    }
    const eye = asVec3(args.eye);
    const state = this.editor.game.state;
    const distance = Math.max(2, Number(args.distance) || 24);
    const yaw = Number.isFinite(Number(args.yaw)) ? Number(args.yaw) : -0.65;
    const pitch = Number.isFinite(Number(args.pitch)) ? Number(args.pitch) : 0.55;
    const computedEye: Vec3Tuple = eye || [
      target[0] + Math.cos(pitch) * Math.sin(yaw) * distance,
      target[1] + Math.sin(pitch) * distance,
      target[2] + Math.cos(pitch) * Math.cos(yaw) * distance,
    ];
    const duration = Math.max(0, Math.min(5_000, Number(args.durationMs) ?? 650));
    await this.moveCamera(computedEye, target, duration);
    return {
      summary: `镜头移动到 [${target.map((v) => v.toFixed(1)).join(', ')}]`,
      camera: {
        eye: computedEye,
        target,
        distance: vec3.distance(computedEye, target),
        running: state.replica.running,
      },
    };
  }

  private moveCursor(args: Record<string, unknown>): CommandResult {
    const at = asVec3(args.at) || asVec3(args.target) || asVec3(args);
    if (!at) {
      throw new LiveCommandError('INVALID_ARGS', 'cursor 需要 at: [x,y,z]');
    }
    const state = this.editor.game.state;
    const voxel = roundTuple(at);
    const block = state.voxel.getVoxel(voxel[0], voxel[1], voxel[2]);
    const face = asVec3(args.face);
    this.setCursor(voxel, face, block);
    return {
      summary: `光标指向 [${voxel.join(', ')}]${block ? `（${blockOf(state, block)}）` : '（空气）'}`,
      cursor: { voxel, block, blockName: blockOf(state, block) },
    };
  }

  private async place(args: Record<string, unknown>): Promise<CommandResult> {
    const at = asVec3(args.at) || asVec3(args.target) || asVec3(args);
    if (!at) {
      throw new LiveCommandError('INVALID_ARGS', 'place 需要 at: [x,y,z] 或 x/y/z');
    }
    const block = resolveBlock(this.editor.game.state, args.block ?? args.voxel);
    const replace = args.replace !== false;
    const transaction = this.editor.replica.voxelTransaction();
    const outcome = this.commitVoxels(() => {
      const result = this.applyBlock(roundTuple(at), block.id, replace, transaction);
      if (!result.skipped) transaction.commit();
      return result;
    });
    const summary = outcome.skipped
      ? `[${outcome.voxel.join(', ')}] 已有方块，未覆盖（replace=false）`
      : `放置 ${block.name} 于 [${outcome.voxel.join(', ')}]`;
    this.recordAgentActivity('place', summary);
    return {
      summary,
      ...outcome,
      block: block.name,
      revision: this.terrainRevision,
      paced: false,
    };
  }

  private async erase(args: Record<string, unknown>): Promise<CommandResult> {
    const at = asVec3(args.at) || asVec3(args.target) || asVec3(args);
    if (!at) {
      throw new LiveCommandError('INVALID_ARGS', 'erase 需要 at: [x,y,z]');
    }
    const transaction = this.editor.replica.voxelTransaction();
    const outcome = this.commitVoxels(() => {
      const result = this.applyBlock(roundTuple(at), 0, true, transaction);
      if (!result.skipped) transaction.commit();
      return result;
    });
    const summary = outcome.skipped
      ? `[${outcome.voxel.join(', ')}] 本来就是空气`
      : `移除 [${outcome.voxel.join(', ')}] 的方块`;
    this.recordAgentActivity('erase', summary);
    return { summary, ...outcome, revision: this.terrainRevision, paced: false };
  }

  private async placePath(args: Record<string, unknown>): Promise<CommandResult> {
    const points = Array.isArray(args.points) ? args.points.map(asVec3).filter(Boolean) as Vec3Tuple[] : [];
    if (!points.length) {
      throw new LiveCommandError('INVALID_ARGS', 'place_path 需要 points: [[x,y,z], ...]');
    }
    if (points.length > MAX_PATH_POINTS) {
      throw new LiveCommandError('TOO_MANY_BLOCKS', `一次最多 ${MAX_PATH_POINTS} 个点`, '拆成多段，让人能跟上');
    }
    const block = resolveBlock(this.editor.game.state, args.block ?? args.voxel);
    const replace = args.replace !== false;
    const pace = Math.max(0, Math.min(1_000, Number(args.paceMs) ?? 80));
    const transaction = this.editor.replica.voxelTransaction();
    const receipts: ProgressReceipt[] = [];
    const startedAt = Date.now();
    let placed = 0;
    for (let index = 0; index < points.length; index += 1) {
      const voxel = roundTuple(points[index]);
      const outcome = this.commitVoxels(() =>
        this.applyBlock(voxel, block.id, replace, transaction),
      );
      if (!outcome.skipped) placed += 1;
      this.setCursor(voxel, undefined, block.id);
      const boundary = index % 12 === 0 || index === points.length - 1;
      if (boundary) {
        const note = `正在沿路径搭建 ${index + 1}/${points.length}`;
        receipts.push({ at: new Date().toISOString(), done: index + 1, total: points.length, note });
        this.postProgress(note);
      }
      if (pace) await sleep(pace);
      if (this.stopped) break;
    }
    if (placed > 0) this.commitVoxels(() => transaction.commit());
    const summary = `沿路径放置 ${placed}/${points.length} 个 ${block.name}`;
    this.recordAgentActivity('place_path', summary);
    return {
      summary,
      placed,
      total: points.length,
      block: block.name,
      paceMs: pace,
      durationMs: Date.now() - startedAt,
      receipts,
      revision: this.terrainRevision,
      paced: pace > 0,
    };
  }

  private async fillBox(args: Record<string, unknown>): Promise<CommandResult> {
    const from = asVec3(args.from) || asVec3(args.min);
    const to = asVec3(args.to) || asVec3(args.max);
    if (!from || !to) {
      throw new LiveCommandError('INVALID_ARGS', 'fill_box 需要 from 与 to（各为 [x,y,z]）');
    }
    const min = from.map((value, index) => Math.min(value, to[index])) as Vec3Tuple;
    const max = from.map((value, index) => Math.max(value, to[index])) as Vec3Tuple;
    const size = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    const volume = size[0] * size[1] * size[2];
    if (volume > MAX_FILL_BLOCKS) {
      throw new LiveCommandError(
        'TOO_MANY_BLOCKS',
        `填充体积 ${volume} 超过上限 ${MAX_FILL_BLOCKS}`,
        '拆成几层/几块分别填充，或先用 place_path 画轮廓',
      );
    }
    const block = resolveBlock(this.editor.game.state, args.block ?? args.voxel);
    const hollow = Boolean(args.hollow);
    const pace = Math.max(0, Math.min(1_000, Number(args.paceMs) ?? (volume > 600 ? 0 : 45)));
    const transaction = this.editor.replica.voxelTransaction();
    const receipts: ProgressReceipt[] = [];
    const startedAt = Date.now();
    let placed = 0;
    let visited = 0;
    for (let y = min[1]; y <= max[1] && !this.stopped; y += 1) {
      for (let x = min[0]; x <= max[0]; x += 1) {
        for (let z = min[2]; z <= max[2]; z += 1) {
          visited += 1;
          if (
            hollow &&
            x > min[0] && x < max[0] &&
            y > min[1] && y < max[1] &&
            z > min[2] && z < max[2]
          ) {
            continue;
          }
          const outcome = this.commitVoxels(() =>
            this.applyBlock([x, y, z], block.id, args.replace !== false, transaction),
          );
          if (!outcome.skipped) placed += 1;
          if (visited % 32 === 0) {
            this.setCursor([x, y, z], undefined, block.id);
            const note = `正在填充 ${visited}/${volume}`;
            receipts.push({ at: new Date().toISOString(), done: visited, total: volume, note });
            this.postProgress(note);
          }
          if (pace) await sleep(pace);
        }
      }
    }
    if (placed > 0) this.commitVoxels(() => transaction.commit());
    const summary = `填充 ${placed} 个 ${block.name}（体积 ${volume}${hollow ? '，空心' : ''}）`;
    this.recordAgentActivity('fill_box', summary);
    return {
      summary,
      placed,
      volume,
      block: block.name,
      paceMs: pace,
      durationMs: Date.now() - startedAt,
      receipts,
      revision: this.terrainRevision,
      paced: pace > 0,
    };
  }

  private commitVoxels<T>(run: () => T): T {
    this.agentWriteDepth += 1;
    try {
      return run();
    } finally {
      this.agentWriteDepth -= 1;
    }
  }

  private undoAction(): CommandResult {
    const depth = this.currentUndoDepth();
    if (this.undoDepthAfterAgentWrite < 0 || depth !== this.undoDepthAfterAgentWrite) {
      throw new LiveCommandError(
        'NOT_MY_ACTION',
        '撤销栈顶部不是这次会话的 AI 操作，拒绝撤销',
        '先 observe；如果确实要撤销人工改动，请人在编辑器里操作 Ctrl+Z',
      );
    }
    this.commitVoxels(() => this.editor.replica.undo());
    const summary = '已撤销上一步 AI 操作';
    this.recordAgentActivity('undo', summary);
    return {
      summary,
      undoDepth: this.currentUndoDepth(),
      revision: this.terrainRevision,
    };
  }

  private redoAction(): CommandResult {
    const depth = this.currentUndoDepth();
    const redoDepth = Number((this.editor.state.replica as any)?.redoHistory?.length) || 0;
    if (redoDepth <= 0 || depth !== this.undoDepthAfterAgentWrite) {
      throw new LiveCommandError(
        'NOTHING_TO_REDO',
        '没有可重做的 AI 操作，或撤销栈已经被人改动',
        '先 observe 确认当前状态',
      );
    }
    this.commitVoxels(() => this.editor.replica.redo());
    const summary = '已重做 AI 操作';
    this.recordAgentActivity('redo', summary);
    return {
      summary,
      undoDepth: this.currentUndoDepth(),
      revision: this.terrainRevision,
    };
  }

  private listEntities(args: Record<string, unknown>): CommandResult {
    const entities = this.entitySummaries();
    const query = String(args.query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(120, Number(args.limit) || 40));
    const filtered = query
      ? entities.filter((entity) =>
          `${entity.id} ${entity.name} ${entity.mesh}`.toLowerCase().includes(query),
        )
      : entities;
    return {
      summary: `实体 ${filtered.length}/${entities.length}${query ? `（筛选 ${query}）` : ''}`,
      entities: filtered.slice(0, limit),
      total: entities.length,
    };
  }

  private async selectEntity(args: Record<string, unknown>): Promise<CommandResult> {
    const id = String(args.id || args.entityId || '').trim();
    if (!id) {
      throw new LiveCommandError('INVALID_ARGS', 'select_entity 需要 id', '先 entities 查 id');
    }
    if (!args.all) reduxDispatch(setSelectedTreeNodes([id]));
    const entities = this.entitySummaries();
    const entity = entities.find((candidate) => candidate.id === id);
    if (!entity) {
      throw new LiveCommandError('ENTITY_NOT_FOUND', `实体不存在：${id}`, '先调用 entities 获取当前 id');
    }
    if (args.focus !== false) {
      const target: Vec3Tuple = entity.position;
      const distance = Math.max(6, Number(args.distance) || Math.max(10, entity.dimension * 2.2));
      const eye: Vec3Tuple = [target[0] + distance, target[1] + distance * 0.7, target[2] + distance];
      await this.moveCamera(eye, target, 600);
    }
    return { summary: `已选中实体 ${entity.name || id}`, entity };
  }

  private async placeModel(args: Record<string, unknown>): Promise<CommandResult> {
    const mesh = String(args.mesh || args.model || '').trim();
    const at = asVec3(args.at) || asVec3(args.position);
    if (!mesh || !at) {
      throw new LiveCommandError('INVALID_ARGS', 'place_model 需要 mesh 与 at: [x,y,z]');
    }
    const meshes = this.availableMeshes();
    if (!meshes.includes(mesh)) {
      const fuzzy = meshes.filter((candidate) => candidate.includes(mesh)).slice(0, 10);
      throw new LiveCommandError(
        'UNKNOWN_MODEL',
        `工程里没有模型资源：${mesh}`,
        fuzzy.length ? `相近：${fuzzy.join(', ')}` : `可用示例：${meshes.slice(0, 12).join(', ')}`,
      );
    }

    const seed = EntitySeedRDA.stateSchema.alloc();
    const position = roundTuple(at);
    const scale = Math.max(0.01, Number(args.scale) || 1);
    seed.name = String(args.name || this.editor.seedController.genNewName('模型')).slice(0, 32);
    vec3.set(seed.position, position[0], position[1], position[2]);
    vec3.set(seed.scale, scale, scale, scale);
    quat.identity(seed.orientation);
    if (Number.isFinite(Number(args.rotationY))) {
      quat.setAxisAngle(seed.orientation, [0, 1, 0], Number(args.rotationY));
    }
    seed.mesh = mesh;
    const asset = this.meshAsset(mesh) as Record<string, unknown> | undefined;
    if (asset && Number.isFinite(Number(asset.modelId))) {
      (seed as any).meshId = Number(asset.modelId);
    }
    seed.tint[0] = 255;
    seed.tint[1] = 255;
    seed.tint[2] = 255;
    seed.tint[3] = 255;

    const id = this.editor.seedController.genNodeId();
    this.editor.seedController.addSeed(id, seed);
    reduxDispatch(setSelectedTreeNodes([id]));
    this.setCursor(position, undefined, 0);

    if (args.focus !== false) {
      const distance = Math.max(8, Number(args.distance) || 14);
      await this.moveCamera(
        [position[0] + distance, position[1] + distance * 0.65, position[2] + distance],
        position,
        600,
      );
    }
    const summary = `放置模型 ${seed.name}（${mesh}）于 [${position.join(', ')}]`;
    this.recordAgentActivity('place_model', summary);
    return {
      summary,
      entity: { id, name: seed.name, mesh, position, scale },
      revision: this.terrainRevision,
    };
  }

  private async save(): Promise<CommandResult> {
    const running = Boolean(this.editor.game.state.replica.running);
    if (running) {
      throw new LiveCommandError(
        'PREVIEW_RUNNING',
        '预览运行中不能保存地形（体素 chunk 不会被记录）',
        '先执行 preview_stop，再 save；或者让人在编辑器里停预览',
      );
    }
    const hash = await this.editor.replica.saveProject();
    const summary = `地图已保存${hash ? `（${String(hash).slice(0, 12)}…）` : ''}`;
    this.recordAgentActivity('save', summary);
    return { summary, hash };
  }

  private say(args: Record<string, unknown>): CommandResult {
    const text = String(args.text || args.message || '').trim().slice(0, 240);
    if (!text) {
      throw new LiveCommandError('INVALID_ARGS', 'say 需要 text');
    }
    setAgentPresence({ note: text });
    return { summary: text };
  }

  private async screenshot(): Promise<CommandResult> {
    const blob = await this.editor.captureScreenshot();
    if (!blob) {
      throw new LiveCommandError('SCREENSHOT_UNAVAILABLE', '当前没有可截图的画布');
    }
    const bitmap = await createImageBitmap(blob);
    let width = bitmap.width;
    let height = bitmap.height;
    const maxWidth = 960;
    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new LiveCommandError('SCREENSHOT_UNAVAILABLE', '无法创建截图画布');
    context.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    return {
      summary: `截图 ${width}×${height}`,
      mimeType: 'image/jpeg',
      width,
      height,
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    };
  }

  // ---- Script authoring -------------------------------------------------
  //
  // The human must watch the code change, so every write goes through the
  // Monaco editor's own model (which then syncs into the collaborative text
  // replica the same way typing does). Nothing is written to disk behind the
  // scene: `save` is still a separate, visible step.

  private scriptController() {
    const controller = this.editor.codeEditorController;
    if (!controller) {
      throw new LiveCommandError(
        'SCRIPT_UNAVAILABLE',
        '当前编辑器没有脚本控制器（地图可能还没加载完）',
        '等编辑器完全打开后再试',
      );
    }
    return controller;
  }

  private scriptFileDict(): Record<string, { name?: string; content?: string }> {
    return (this.editor.state.codeEditor?.fileDict || {}) as Record<
      string,
      { name?: string; content?: string }
    >;
  }

  private findScriptFile(raw: unknown) {
    const dict = this.scriptFileDict();
    const ids = Object.keys(dict);
    if (!ids.length) {
      throw new LiveCommandError('SCRIPT_FILES_EMPTY', '这张地图还没有脚本文件', '先 addFile 在编辑器里建一个');
    }
    const wanted = String(raw || '').trim();
    if (!wanted) {
      // Default: the server script is where map logic lives.
      const server = ids.find((id) => dict[id]?.name === 'server');
      return server || ids[0];
    }
    if (dict[wanted]) return wanted;
    const byName = ids.find((id) => dict[id]?.name === wanted);
    if (byName) return byName;
    throw new LiveCommandError(
      'SCRIPT_NOT_FOUND',
      `没有这个脚本：${wanted}`,
      `现有文件：${ids.map((id) => dict[id]?.name || id).join(', ')}`,
    );
  }

  private scriptFiles(): CommandResult {
    const dict = this.scriptFileDict();
    const selected = this.editor.state.codeEditor?.selectedFileId;
    const files = Object.keys(dict).map((id) => ({
      id,
      name: dict[id]?.name || '',
      characters: String(dict[id]?.content || '').length,
    }));
    return { summary: `脚本 ${files.length} 个`, files, selectedFileId: selected || null };
  }

  private scriptOpen(args: Record<string, unknown>): CommandResult {
    const controller = this.scriptController();
    const fileId = this.findScriptFile(args.file ?? args.name);
    // Switch the left nav to the script panel first, so the human sees the
    // editor appear before the text changes.
    reduxDispatch(setNavMode(LeftNavModeEnum.Script));
    controller.selectFile(fileId);
    const file = this.scriptFileDict()[fileId];
    return {
      summary: `已打开脚本 ${file?.name || fileId}`,
      fileId,
      name: file?.name || '',
      characters: String(file?.content || '').length,
    };
  }

  private scriptRead(args: Record<string, unknown>): CommandResult {
    const fileId = this.findScriptFile(args.file ?? args.name);
    const file = this.scriptFileDict()[fileId];
    const content = String(file?.content || '');
    const limit = Math.max(200, Math.min(20_000, Number(args.limit) || 6_000));
    return {
      summary: `读取脚本 ${file?.name || fileId}（${content.length} 字符）`,
      fileId,
      name: file?.name || '',
      characters: content.length,
      truncated: content.length > limit,
      content: content.slice(0, limit),
    };
  }

  private scriptReplace(args: Record<string, unknown>): CommandResult {
    const controller = this.scriptController();
    const content = args.content;
    if (typeof content !== 'string') {
      throw new LiveCommandError('INVALID_ARGS', 'script_replace 需要 content 字符串');
    }
    const fileId = this.findScriptFile(args.file ?? args.name);
    reduxDispatch(setNavMode(LeftNavModeEnum.Script));
    controller.selectFile(fileId);
    const before = String(this.scriptFileDict()[fileId]?.content || '');
    controller.monacoController.setText(content);
    const after = String(this.scriptFileDict()[fileId]?.content || content);
    const summary = `已改写脚本 ${this.scriptFileDict()[fileId]?.name || fileId}（${before.length} → ${after.length} 字符）`;
    this.recordAgentActivity('script_replace', summary);
    return {
      summary,
      fileId,
      before: before.length,
      after: after.length,
    };
  }

  private scriptInsert(args: Record<string, unknown>): CommandResult {
    const controller = this.scriptController();
    const text = args.text ?? args.content;
    if (typeof text !== 'string' || !text) {
      throw new LiveCommandError('INVALID_ARGS', 'script_insert 需要 text 字符串');
    }
    const fileId = this.findScriptFile(args.file ?? args.name);
    reduxDispatch(setNavMode(LeftNavModeEnum.Script));
    controller.selectFile(fileId);
    controller.monacoController.insertCodeToSelection(text);
    const summary = `已在脚本 ${this.scriptFileDict()[fileId]?.name || fileId} 光标处插入 ${text.length} 字符`;
    this.recordAgentActivity('script_insert', summary);
    return {
      summary,
      fileId,
      inserted: text.length,
    };
  }

  private applyBlock(
    voxel: Vec3Tuple,
    blockId: number,
    replace: boolean,
    transaction: ReturnType<EditClient['replica']['voxelTransaction']>,
  ): { voxel: Vec3Tuple; skipped: boolean; previous: number } {
    const state = this.editor.game.state;
    const shape = state.voxel.shape;
    if (
      voxel[0] < 0 || voxel[1] < 0 || voxel[2] < 0 ||
      voxel[0] >= shape[0] || voxel[1] >= shape[1] || voxel[2] >= shape[2]
    ) {
      throw new LiveCommandError(
        'OUT_OF_BOUNDS',
        `[${voxel.join(', ')}] 超出地图范围 [0..${shape[0] - 1}, 0..${shape[1] - 1}, 0..${shape[2] - 1}]`,
      );
    }
    const previous = state.voxel.getVoxel(voxel[0], voxel[1], voxel[2]);
    if (!replace && previous !== 0) {
      return { voxel, skipped: true, previous };
    }
    transaction.push(voxel[0], voxel[1], voxel[2], blockId);
    if (blockId !== 0) this.setCursor(voxel, undefined, blockId);
    return { voxel, skipped: false, previous };
  }

  private setCursor(voxel: Vec3Tuple, face: Vec3Tuple | undefined, block: number) {
    setAgentPresence({
      cursor: {
        voxel,
        face,
        block,
        blockName: blockOf(this.editor.game.state, block),
        visible: true,
      },
    });
  }

  private async moveCamera(eye: Vec3Tuple, target: Vec3Tuple, durationMs: number) {
    const config: any = (this.editor.game.state as any).secret?.replica?.camera;
    if (!config) return;
    if (!this.savedCamera) {
      this.savedCamera = {
        mode: Number(config.mode) || 0,
        eye: tuple(config.eye),
        target: tuple(config.target),
        distance: Number(config.distance) || 8.5,
        fovY: Number(config.fovY) || 0,
      };
    }
    const fromEye = tuple(this.editor.game.state.camera.eye);
    const fromTarget = tuple(this.editor.game.state.camera.targetLook);
    config.mode = CameraMode.FIXED;
    this.cameraTween.cancel();
    setAgentPresence({ lookTarget: target });
    // The tween advances on animation frames. A backgrounded or throttled tab
    // may not paint for seconds, so cap the wait by wall clock: the final
    // vec3.set below still lands the camera even if the animation never ran.
    await Promise.race([
      this.cameraTween.run(durationMs, (t) => {
        const nextEye = vec3.lerp(vec3.create(), fromEye, eye, t);
        const nextTarget = vec3.lerp(vec3.create(), fromTarget, target, t);
        vec3.set(config.eye, nextEye[0], nextEye[1], nextEye[2]);
        vec3.set(config.target, nextTarget[0], nextTarget[1], nextTarget[2]);
      }),
      sleep(durationMs + 400),
    ]);
    vec3.set(config.eye, eye[0], eye[1], eye[2]);
    vec3.set(config.target, target[0], target[1], target[2]);
  }

  private releaseCamera() {
    const config: any = (this.editor.game.state as any).secret?.replica?.camera;
    const saved = this.savedCamera;
    this.savedCamera = undefined;
    this.cameraTween.cancel();
    if (!config || !saved) {
      setAgentPresence({ lookTarget: undefined });
      return;
    }
    config.mode = saved.mode;
    vec3.set(config.eye, saved.eye[0], saved.eye[1], saved.eye[2]);
    vec3.set(config.target, saved.target[0], saved.target[1], saved.target[2]);
    config.distance = saved.distance;
    if (saved.fovY) config.fovY = saved.fovY;
    setAgentPresence({ lookTarget: undefined });
  }

  private addHumanCameraListener() {
    if (typeof window === 'undefined') return;
    window.addEventListener('pointerdown', this.humanCameraHandler, true);
    window.addEventListener('wheel', this.humanCameraHandler, true);
  }

  private removeHumanCameraListener() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', this.humanCameraHandler, true);
    window.removeEventListener('wheel', this.humanCameraHandler, true);
  }

  public snapshot(options: { includeTerrain?: boolean } = {}): Record<string, unknown> {
    const game = this.editor.game;
    const state = game.state;
    const camera = state.camera;
    const hit = this.raycastCenter();
    const entities = this.entitySummaries();
    const selected = store.getState().seeds.selectedTreeNodes;
    const presence = getAgentPresence();
    const shape = tuple(state.voxel.shape);
    const cursorHit = hit
      ? {
          voxel: roundTuple(hit.hitVoxel),
          face: tuple(hit.hitNormal),
          block: hit.hitBlock,
          blockName: blockOf(state, hit.hitBlock),
          distance: Number(hit.hitDistance.toFixed(2)),
          position: tuple(hit.hitPosition).map((value) => Number(value.toFixed(2))),
        }
      : null;

    const snapshot: Record<string, unknown> = {
      at: new Date().toISOString(),
      container: this.container,
      project: {
        name: clientConfig.mapInfo?.name || '',
        permanentMapId: clientConfig.mapInfo?.permanentMapId || '',
        running: Boolean(state.replica.running),
      },
      camera: {
        eye: tuple(camera.eye).map((value) => Number(value.toFixed(2))),
        target: tuple(camera.targetLook).map((value) => Number(value.toFixed(2))),
        distance: Number(Number(camera.distance).toFixed(2)),
        fovY: Number(Number(camera.fovY).toFixed(3)),
        viewport: [camera.viewport[0], camera.viewport[1]],
        agentControlled: Boolean(this.savedCamera),
      },
      cursor: presence.cursor
        ? {
            voxel: presence.cursor.voxel,
            face: presence.cursor.face,
            block: presence.cursor.block,
            blockName: presence.cursor.blockName,
          }
        : null,
      lookHit: cursorHit,
      selection: {
        entityIds: selected,
        entities: entities.filter((entity) => selected.includes(entity.id)),
      },
      entities: entities.slice(0, 80),
      entityCount: entities.length,
      models: this.availableMeshes().slice(0, 80),
      uiNodeCount: Object.keys(this.editor.state.replica.project.uiTree || {}).length,
      scriptCount: Object.keys(this.editor.state.codeEditor?.fileDict || {}).length,
      navMode: store.getState().creator?.navMode,
      terrain: {
        shape,
        heightmap: options.includeTerrain ? this.sampleHeightmap() : undefined,
      },
      agent: {
        phase: presence.phase,
        action: presence.action,
        operationId: presence.action?.operationId,
      },
      revision: {
        terrain: this.terrainRevision,
        humanEdits: this.humanEpoch,
        undoDepth: this.currentUndoDepth(),
        observedHumanEdits: this.observedHumanEpoch,
        requiresObserve:
          !this.hasObserved ||
          this.humanEpoch !== this.observedHumanEpoch ||
          this.currentUndoDepth() !== this.observedUndoDepth,
      },
      activity: this.activity.slice(-20),
    };
    return snapshot;
  }

  private raycastCenter(): VoxelRaycastHitResult | undefined {
    const state = this.editor.game.state;
    try {
      const direction = screenToRay(state.camera, 0, 0, vec3.create());
      const hit = new VoxelRaycastHitResult();
      const found = raycast(
        hit,
        state.blockIndex,
        state.voxel,
        state.camera.eye,
        direction,
        160,
        true,
      );
      return found ? hit : undefined;
    } catch {
      return undefined;
    }
  }

  private entitySummaries() {
    const entities: Array<{
      id: string;
      name: string;
      mesh: string;
      position: Vec3Tuple;
      scale: Vec3Tuple;
      fixed: boolean;
      dimension: number;
    }> = [];
    const tree = this.editor.state.replica.project.entitiesTree || {};
    for (const id of Object.keys(tree)) {
      const value: any = tree[id]?.value;
      if (!value) continue;
      const position = tuple(value.position || [0, 0, 0]);
      const scale = tuple(value.scale || [1, 1, 1]);
      entities.push({
        id,
        name: String(value.name || ''),
        mesh: String(value.mesh || ''),
        position: position.map((item) => Number(item.toFixed(2))) as Vec3Tuple,
        scale: scale.map((item) => Number(item.toFixed(2))) as Vec3Tuple,
        fixed: Boolean(value.fixed),
        dimension: Math.max(scale[0], scale[1], scale[2]),
      });
    }
    return entities;
  }

  private meshAsset(mesh: string) {
    return (
      this.editor.state.replica.extraProjectInfo?.meshAssets?.[mesh] ||
      (this.editor.state.replica.project.assets as any)?.[mesh]
    );
  }

  private availableMeshes(): string[] {
    const names = new Set<string>();
    const extra = this.editor.state.replica.extraProjectInfo?.meshAssets || {};
    for (const name of Object.keys(extra)) names.add(name);
    const assets = (this.editor.state.replica.project.assets || {}) as Record<string, unknown>;
    for (const name of Object.keys(assets)) names.add(name);
    return Array.from(names).sort();
  }

  private sampleHeightmap(): { size: number; step: number; origin: Vec3Tuple; heights: number[][] } {
    const state = this.editor.game.state;
    const shape = state.voxel.shape;
    const step = 8;
    const radius = 48;
    const center = this.raycastCenter()
      ? roundTuple(this.raycastCenter()!.hitVoxel)
      : [Math.floor(shape[0] / 2), 0, Math.floor(shape[2] / 2)] as Vec3Tuple;
    const origin: Vec3Tuple = [
      Math.max(0, center[0] - radius),
      0,
      Math.max(0, center[2] - radius),
    ];
    const heights: number[][] = [];
    for (let x = origin[0]; x <= Math.min(shape[0] - 1, center[0] + radius); x += step) {
      const row: number[] = [];
      for (let z = origin[2]; z <= Math.min(shape[2] - 1, center[2] + radius); z += step) {
        let height = 0;
        for (let y = shape[1] - 1; y >= 0; y -= 1) {
          if (state.voxel.getVoxel(x, y, z) !== 0) {
            height = y;
            break;
          }
        }
        row.push(height);
      }
      heights.push(row);
    }
    return { size: heights.length, step, origin, heights };
  }

  private async postAck(
    id: string,
    ok: boolean,
    result: unknown,
    snapshot: Record<string, unknown>,
    error?: CommandFailure,
  ) {
    if (!this.sessionId) return;
    try {
      await fetch('/api/agent/v1/live/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          container: this.container,
          sessionId: this.sessionId,
          id,
          ok,
          result,
          error,
          snapshot,
          at: new Date().toISOString(),
        }),
      });
    } catch {
      // The poll loop will notice a dead session; an ack loss is reported to
      // the agent as EDITOR_TIMEOUT, and it must observe before retrying.
    }
  }

  private postProgress(note: string) {
    if (!this.sessionId) return;
    const now = Date.now();
    if (now - this.lastProgressAt < 250) return;
    this.lastProgressAt = now;
    void fetch('/api/agent/v1/live/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        container: this.container,
        sessionId: this.sessionId,
        snapshot: this.snapshot(),
        note,
      }),
    }).catch(() => undefined);
  }
}

let active: AgentLiveSession | undefined;

export function startAgentLive(editor: EditClient): () => void {
  if (active) return () => undefined;
  active = new AgentLiveSession(editor);
  active.start();
  return () => {
    active?.stop();
    active = undefined;
  };
}

export function getAgentLiveSession() {
  return active;
}

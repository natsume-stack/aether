import {ProjectNodeType,setHoveredId,setHoveredObjectId,setHoveredSkinPartIds,setEditingNodeId} from '../../redux/animator-slice';
import {setEditingSkinPartId,setEditingVoxelId} from '../../redux/app-slice';
import {ROOT_ID,ROOT_BONE_ID,ROOT_SKIN_ID} from '../../defs';
import {loadAiSnapshot, storeAiSnapshot, removeAiSnapshot} from './panel-snapshot';
import { vec3, quat } from 'gl-matrix';
import {RGBToHsv} from '../../utils/color';
import {DEFAULT_GROUP_ID} from '../../defs';
import {projectSchemaToBytes, projectV10} from '@box/voxa-project';

import type { VoxelEditor } from '../editor';
import { store } from '../../redux/store';
import { setSelectedId } from '../../redux/palette-slice';
import { getQueryValue } from '../../utils/url';
import {
  getVoxaAgentPresence,
  resetVoxaAgentPresence,
  setVoxaAgentPresence,
} from '../../utils/agent-presence';

/**
 * VOXA Agent Live — the editor-side "body" of an AI collaborator.
 *
 * The remote agent posts one small command at a time; this class executes it
 * through the same objects the UI uses:
 *
 *   look       → stage camera position/target + orbitControls.update()
 *   cursor     → the native voxel pointer (setAgentVoxelPosition)
 *   paint      → `models.destination.voxels` + bakeData() + saveHistory()
 *   save       → `editor.manualSave()`
 *   screenshot → canvas.toDataURL (regl keeps preserveDrawingBuffer)
 *
 * Nothing here synthesises a model file and writes it behind the user's back:
 * the whole point is that the human watches the voxels appear.
 */

type Vec3Tuple = [number, number, number];

type LiveCommand = {
  id: string;
  seq: number;
  kind: string;
  args: Record<string, unknown>;
  actor: { id: string; name: string };
  createdAt: string;
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

const KIND_LABEL: Record<string, string> = {
  observe: '观察模型',
  inspect: '读取体素',
  look: '移动视角',
  cursor: '移动体素光标',
  paint: '放置体素',
  erase: '擦除体素',
  paint_path: '沿路径上色',
  fill_box: '填充区域',
  palette: '读取调色板',
  set_color: '切换颜色',
  trim: '裁掉空白',
  undo: '撤销',
  redo: '重做',
  save: '保存模型',
  screenshot: '截图',
  say: '播报',
  wait: '停留观察',
};

const MAX_PATH_CELLS = 4_096;
const MAX_FILL_CELLS = 8_192;

const WRITE_KINDS = new Set([
  'paint',
  'erase',
  'paint_path',
  'fill_box',
  'trim',
  'undo',
  'redo',
  'save',
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

function roundTuple(value: ArrayLike<number>): Vec3Tuple {
  return [Math.round(value[0]), Math.round(value[1]), Math.round(value[2])];
}

export class VoxaAgentLiveSession {
  private stopped = false;
  private panelBusy = false;
  private panelRollbackFingerprint = '';
  private panelUndo: Awaited<ReturnType<VoxelEditor['projectManager']['getData']>> | undefined;
  private sessionId = '';
  private after = 0;
  private pollAbort: AbortController | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastProgressAt = 0;
  private savedCamera: { position: Vec3Tuple; target: Vec3Tuple; zoom: number } | undefined;

  // Same revision discipline as the map side: the editor's own history sink is
  // wrapped so AI and human edits share one counter and the agent can prove it
  // observed the model before writing.
  private modelRevision = 0;
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
  private historyInstrumented = false;

  constructor(private editor: VoxelEditor) {}

  private async panelFingerprint(data: Awaited<ReturnType<VoxelEditor['projectManager']['getData']>>) {
    const bytes = projectSchemaToBytes(data);
    if(bytes.length>16*1024*1024) throw new Error('Model exceeds AI snapshot budget');
    const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer);
    return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  }

  public async panelContext() {
    const data = await this.editor.projectManager.getData();
    const parts = Object.entries(data.nodes).slice(0,128).map(([id,node]) => ({id,name:node.name,type:node.type,parentId:node.parentId,position:Array.from(node.position),scale:Array.from(node.scale),pivot:Array.from(node.pivot),rotationDegrees:Array.from(node.euler),alpha:node.alpha}));
    const shape=this.shape();
    const voxels=this.model().voxels;
    const cells:number[][]=[];
    let scanned=0;
    const volume=shape[0]*shape[1]*shape[2];
    scan: for(let x=0;x<shape[0];x++) for(let y=0;y<shape[1];y++) for(let z=0;z<shape[2];z++) {
      if(scanned>=262144 || cells.length>=2048) break scan;
      scanned++;
      const colorId=voxels.getVoxel(x,y,z);
      if(colorId>0) cells.push([x,y,z,colorId]);
    }
    return {voxelContext:{partId:store.getState().app.editingSkinPartId,shape,cells,scanned,totalCells:volume,truncated:scanned<volume,order:'x,y,z; each cell [x,y,z,colorId]'},fingerprint:await this.panelFingerprint(data),snapshot:this.snapshot(),parts,palette:this.paletteInfo({limit:64}),revision:this.modelRevision,humanEpoch:this.humanEpoch,undoDepth:this.voxaDepth().undo};
  }

  public async executePanelPlan(commands: Array<{kind:string;args:Record<string,unknown>}>, expected: {revision:number;humanEpoch:number;undoDepth:number;fingerprint:string}, signal:AbortSignal,metadata:{providerId?:string;model?:string;mode?:'review'|'autonomous'}={},onEvent?:(event:{type:'command-start'|'command-done'|'command-error'|'batch-done';index?:number;kind?:string;message?:string;total?:number})=>void) {
    if(this.panelBusy) throw new Error('AI plan already running');
    if(this.modelRevision!==expected.revision || this.humanEpoch!==expected.humanEpoch || this.voxaDepth().undo!==expected.undoDepth) throw new Error('Model changed after planning; generate a new plan');
    if(commands.length>32) throw new Error('AI plan exceeds command budget');
    this.panelBusy=true;
    let mutated=false;
    let executionRunId:string|undefined;
    const record=async(phase:string,action:string,snapshot='')=>{
      const response=await fetch('/api/ai/authorize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelId:store.getState().app.projectId,runId:executionRunId,phase,action,snapshot,...metadata}),signal:phase==='before'?signal:undefined});
      if(!response.ok) throw new Error('AI execution quota or administrator policy refused request');
      const value=await response.json();executionRunId=value.runId || executionRunId;
    };
    let currentFingerprint=expected.fingerprint;
    try {
      const source=await this.editor.projectManager.getData();
      if(await this.panelFingerprint(source)!==expected.fingerprint) throw new Error('Model source changed; generate a new plan');
      this.panelUndo=projectV10.ProjectDataV10Schema.clone(source);
      this.panelRollbackFingerprint='';
      const shape=this.shape();
      const aliases=new Map<string,string>();
      const colorAliases=new Map<string,number>();
      const resolveId=(value:unknown) => aliases.get(String(value)) || String(value || '');
      let cells=0;
      const coordinate=(value:unknown) => {
        if(!Array.isArray(value) || value.length!==3 || value.some(n=>!Number.isSafeInteger(n) || n<0 || n>=256)) throw new Error('Invalid or out-of-bounds voxel coordinates');
        return value as number[];
      };
      for(const command of commands) {
        if(['paint','erase'].includes(command.kind)) {coordinate(command.args.at);cells++;}
        if(command.kind==='paint_path') {
          if(!Array.isArray(command.args.points) || command.args.points.length>4096) throw new Error('Invalid voxel path');
          command.args.points.forEach(coordinate);cells+=command.args.points.length;
        }
        if(command.kind==='fill_box') {
          const a=coordinate(command.args.from),b=coordinate(command.args.to);
          const volume=a.reduce((v,n,i)=>v*(Math.abs(n-b[i])+1),1);
          if(volume>8192) throw new Error('Voxel fill exceeds budget');
          cells+=volume;
        }
      }
      if(cells>32768) throw new Error('AI batch exceeds voxel budget');
      const before=await this.editor.projectManager.saveProject({autoSave:false});
      if(!before.isSuccess) throw new Error('Cannot save model snapshot');
      if(await this.panelFingerprint(await this.editor.projectManager.getData())!==expected.fingerprint) throw new Error('Model changed while saving snapshot');
      await record('before','voxa-batch',currentFingerprint);
      await this.run('observe',{});
      await storeAiSnapshot(String(store.getState().app.projectId), this.panelUndo, currentFingerprint);
      let commandIndex=-1;
      for(const command of commands) {
        commandIndex++;
        onEvent?.({type:'command-start',index:commandIndex,kind:command.kind,total:commands.length});
        try {
        if(signal.aborted) throw new Error('AI plan cancelled');
        if(this.humanEpoch!==expected.humanEpoch) throw new Error('Human edits interrupted the AI batch');
        await record('before',command.kind,currentFingerprint);
        if(await this.panelFingerprint(await this.editor.projectManager.getData())!==currentFingerprint || this.humanEpoch!==expected.humanEpoch) throw new Error('Model changed during AI execution');
        this.ensureWriteAllowed('paint');
        mutated=true;
        if(command.kind==='palette_add') {
          const rgb=command.args.rgb;
          const alias=String(command.args.alias || '');
          const emissive=command.args.emissive ?? 0;
          if(!/^\$[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(alias) || colorAliases.has(alias)) throw new Error('A unique color $alias is required');
          if(!Array.isArray(rgb) || rgb.length!==3 || rgb.some(v=>!Number.isInteger(v) || v<0 || v>255) || typeof emissive!=='number' || !Number.isFinite(emissive) || emissive<0 || emissive>255) throw new Error('Invalid palette color');
          let ids:number[]=[];
          this.commitVoxels(()=>{ids=this.editor.palette.addGroupItems({id:DEFAULT_GROUP_ID,items:[{rgb:rgb as Vec3Tuple,hsv:RGBToHsv(rgb[0],rgb[1],rgb[2]),material:{emissive}}]});});
          if(ids.length!==1) throw new Error('Palette capacity exceeded');
          colorAliases.set(alias,ids[0]);
          this.modelRevision++;this.observedUndoDepth=this.voxaDepth().undo;
        } else if(command.kind==='workspace_resize') {
          const size=command.args.size;
          if(!Array.isArray(size) || size.length!==3 || size.some(v=>!Number.isInteger(v) || v<1 || v>256) || size.reduce((v,n)=>v*n,1)>1048576) throw new Error('Workspace exceeds AI size budget');
          // Native resize recenters X/Z and can crop voxels; the persisted pre-batch snapshot is the recovery path.
          this.commitVoxels(()=>this.editor.voxelApp.updateSpaceSize(vec3.fromValues(size[0],size[1],size[2])));
          this.modelRevision++;this.observedUndoDepth=this.voxaDepth().undo;
        } else if(['part_create','part_select','part_delete','part_group','part_move'].includes(command.kind)) {
          if(!store.getState().permission.editParts) throw new Error('Part editing is not allowed');
          const manager=this.editor.animatorApp.nodeManager;
          const hierarchy=store.getState().animator.hierarchyData;
          const id=resolveId(command.args.id);
          const protectedIds=[ROOT_ID,ROOT_BONE_ID,ROOT_SKIN_ID];
          let createdId='';
          if(['part_create','part_group'].includes(command.kind)) {
            const alias=String(command.args.alias || '');
            if(!/^\$[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(alias) || aliases.has(alias)) throw new Error('A unique $alias is required for new parts');
            if(command.args.name!==undefined && (typeof command.args.name!=='string' || !command.args.name.trim() || command.args.name.length>64)) throw new Error('Invalid part name');
          }
          this.commitVoxels(()=>{
            if(command.kind==='part_create') {
              if(Object.keys(hierarchy).length>=256) throw new Error('AI part budget exceeded');
              createdId=manager.addSkinPart({toRename:false}).uuid;
              this.editor.switchToVoxel(createdId);
            } else if(command.kind==='part_select') {
              if(hierarchy[id]?.type!==ProjectNodeType.SkinPart) throw new Error('Select an existing voxel part');
              this.editor.switchToVoxel(id);
            } else if(command.kind==='part_delete') {
              if(!hierarchy[id] || protectedIds.includes(id)) throw new Error('Cannot remove this part');
              this.editor.switchToAnimator();
              manager.removeNodes([id]);
              manager.setActiveIds([]);
            } else if(command.kind==='part_group') {
              if(!Array.isArray(command.args.ids) || !command.args.ids.length || command.args.ids.length>32) throw new Error('Invalid group members');
              const ids=command.args.ids.map(resolveId);
              if(new Set(ids).size!==ids.length || ids.some(v=>!hierarchy[v] || protectedIds.includes(v) || ![ProjectNodeType.SkinPart,ProjectNodeType.Group].includes(hierarchy[v].type))) throw new Error('Invalid group members');
              if(ids.some(v=>hierarchy[v].parentId!==hierarchy[ids[0]]?.parentId)) throw new Error('Group members must be siblings');
              this.editor.switchToAnimator();
              createdId=manager.addGroup(ids).uuid;
            } else {
              const parentId=resolveId(command.args.parentId);
              if(!hierarchy[id] || protectedIds.includes(id) || ![ProjectNodeType.SkinPart,ProjectNodeType.Group].includes(hierarchy[id].type) || !hierarchy[parentId] || (hierarchy[parentId].type!==ProjectNodeType.Group && parentId!==ROOT_SKIN_ID)) throw new Error('Invalid reparent operation');
              const seen=new Set<string>();let ancestor:string|undefined=parentId;
              while(ancestor) {if(ancestor===id || seen.has(ancestor)) throw new Error('Cyclic hierarchy is forbidden');seen.add(ancestor);ancestor=hierarchy[ancestor]?.parentId;}
              this.editor.switchToAnimator();manager.setActiveIds([id]);manager.moveActiveSkinNodes(parentId,'box');
              if(store.getState().animator.hierarchyData[id]?.parentId!==parentId) throw new Error('Reparent operation was refused');
            }
          });
          if(createdId) {
            const alias=String(command.args.alias || '');
            if(!/^\$[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(alias) || aliases.has(alias)) throw new Error('A unique $alias is required for new parts');
            aliases.set(alias,createdId);
            if(command.args.name!==undefined) {
              if(typeof command.args.name!=='string' || !command.args.name.trim() || command.args.name.length>64) throw new Error('Invalid part name');
              const data=await this.editor.projectManager.getData();
              const createdNode=data.nodes[createdId];
              if(createdNode) {
                createdNode.name=command.args.name;
                this.commitVoxels(()=>this.editor.projectManager.restoreAiSnapshot(data));
                if(command.kind==='part_create') this.commitVoxels(()=>this.editor.switchToVoxel(createdId));
              }
            }
          }
          this.modelRevision++;this.observedUndoDepth=this.voxaDepth().undo;this.observedHumanEpoch=expected.humanEpoch;
        } else if(command.kind==='part_patch') {
          if(!store.getState().permission.editParts) throw new Error('Part editing is not allowed');
          const data=await this.editor.projectManager.getData();
          if(await this.panelFingerprint(data)!==currentFingerprint) throw new Error('Part data changed during AI execution');
          const node=data.nodes[resolveId(command.args.id)];
          if(!node) throw new Error('Unknown part ID');
          if(command.args.name!==undefined) {if(typeof command.args.name!=='string' || !command.args.name.trim() || command.args.name.length>64) throw new Error('Invalid part name');node.name=command.args.name;}
          for(const key of ['position','scale','pivot','rotationDegrees'] as const) {
            const value=command.args[key];
            if(value!==undefined) {
              if(!Array.isArray(value) || value.length!==3 || value.some(v=>typeof v!=='number' || !Number.isFinite(v) || Math.abs(v)>10000 || (key==='scale' && v<=0))) throw new Error('Invalid part transform');
              if(key==='rotationDegrees') {node.euler.set(value);quat.fromEuler(node.quaternion,value[0],value[1],value[2]);}
              else node[key].set(value);
            }
          }
          if(command.args.alpha!==undefined) {const alpha=command.args.alpha;if(typeof alpha!=='number' || !Number.isFinite(alpha) || alpha<0 || alpha>1) throw new Error('Invalid part opacity');node.alpha=alpha;}
          this.commitVoxels(()=>this.editor.projectManager.restoreAiSnapshot(data));
          this.modelRevision++;
          this.observedUndoDepth=this.voxaDepth().undo;
        } else {
          if(!['paint','erase','paint_path','fill_box','set_color','trim'].includes(command.kind)) throw new Error('Unsupported panel command');
          const args={...command.args,paceMs:0} as Record<string,unknown>;
          for(const key of ['id','colorId']) if(typeof args[key]==='string' && String(args[key]).startsWith('$')) {const color=colorAliases.get(String(args[key]));if(color===undefined) throw new Error('Unknown palette alias');args[key]=color;}
          await this.run(command.kind,args);
        }
        currentFingerprint=await this.panelFingerprint(await this.editor.projectManager.getData());
        await storeAiSnapshot(String(store.getState().app.projectId), this.panelUndo!, currentFingerprint);
        await record('after',command.kind,currentFingerprint);
        onEvent?.({type:'command-done',index:commandIndex,kind:command.kind});
        } catch(error) {
          onEvent?.({type:'command-error',index:commandIndex,kind:command.kind,message:(error as Error)?.message || 'Command failed'});
          throw error;
        }
      }
      const saved=await this.editor.projectManager.saveProject({autoSave:false});
      if(!saved.isSuccess) throw new Error('Model changed but save failed; inspect before retry');
      if(await this.panelFingerprint(await this.editor.projectManager.getData())!==currentFingerprint) throw new Error('Model changed during AI save');
      this.panelRollbackFingerprint=currentFingerprint;
      await record('complete','voxa-batch',currentFingerprint);
      executionRunId=undefined;
      onEvent?.({type:'batch-done',total:commands.length});
      return {success:true,commands:commands.length};
    } finally {
      if(executionRunId) await record(signal.aborted?'cancelled':'failed','voxa-batch',currentFingerprint).catch(()=>undefined);
      if(mutated) {
        // Capture partial writes as well; rollback is still guarded by full-source CAS.
        if(this.humanEpoch===expected.humanEpoch) {
          currentFingerprint=await this.panelFingerprint(await this.editor.projectManager.getData());
          this.panelRollbackFingerprint=currentFingerprint;
          await storeAiSnapshot(String(store.getState().app.projectId),this.panelUndo!,currentFingerprint);
        } else this.panelRollbackFingerprint='';
      }
      this.panelBusy=false;
    }
  }

  public async rollbackPanelPlan() {
    if(this.panelBusy) throw new Error('AI plan is running');
    if(!this.panelUndo) {
      const saved=await loadAiSnapshot(String(store.getState().app.projectId));
      if(saved) {this.panelUndo=saved.data;this.panelRollbackFingerprint=saved.fingerprint;}
    }
    if(!this.panelUndo) throw new Error('No AI snapshot available');
    if(!this.panelRollbackFingerprint || await this.panelFingerprint(await this.editor.projectManager.getData())!==this.panelRollbackFingerprint) throw new Error('Model changed after AI execution; rollback would overwrite later edits');
    this.commitVoxels(()=>this.editor.projectManager.restoreAiSnapshot(this.panelUndo!));
    // 快照恢复后旧的选中/编辑/hover id可能已失效，先清空避免后续解引用
    this.editor.animatorApp.nodeManager.setActiveIds([], false);
    store.dispatch(setHoveredId(undefined));
    store.dispatch(setHoveredObjectId(undefined));
    store.dispatch(setHoveredSkinPartIds([]));
    store.dispatch(setEditingNodeId(undefined));
    store.dispatch(setEditingSkinPartId(undefined));
    store.dispatch(setEditingVoxelId(undefined));
    this.modelRevision++;
    this.observedUndoDepth=this.voxaDepth().undo;
    const saved=await this.editor.projectManager.saveProject({autoSave:false});
    if(!saved.isSuccess) throw new Error('Snapshot restored but save failed');
    this.panelUndo=undefined;
    await removeAiSnapshot(String(store.getState().app.projectId));
  }

  public start() {
    setVoxaAgentPresence({ phase: 'connecting' });
    this.instrumentHistory();
    void this.connectLoop();
  }

  public stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pollAbort?.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    const sessionId = this.sessionId;
    this.sessionId = '';
    resetVoxaAgentPresence();
    this.restoreCamera();
    if (sessionId) {
      void fetch('/api/agent/v1/live/detach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
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
        setVoxaAgentPresence({ phase: 'error', error: message });
        await sleep(4_000);
      }
    }
  }

  private async attach() {
    const response = await fetch('/api/agent/v1/live/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: this.snapshot() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || `VOXA live attach failed (HTTP ${response.status})`);
    }
    this.sessionId = String(data.sessionId || '');
    this.after = Number(data.lastSeq) || 0;
    setVoxaAgentPresence({
      phase: 'attached',
      sessionId: this.sessionId,
      error: undefined,
      note: 'AI 通道已接入，等待指令',
    });
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
          `/api/agent/v1/live/next?sessionId=${encodeURIComponent(this.sessionId)}&after=${this.after}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (response.status === 409) {
          this.sessionId = '';
          setVoxaAgentPresence({ phase: 'connecting', error: undefined });
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
        await this.execute(command);
      } catch (error) {
        if (this.stopped || controller.signal.aborted) return;
        await sleep(1_500);
      }
    }
  }

  private async execute(command: LiveCommand) {
    const label = KIND_LABEL[command.kind] || command.kind;
    this.currentOperationId = command.id;
    setVoxaAgentPresence((current) => ({
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
      const result = (await this.run(command.kind, command.args || {})) as Record<string, unknown>;
      const enriched = { ...result, operationId: command.id };
      const snapshot = (result?.snapshot as Record<string, unknown> | undefined) || this.snapshot();
      await this.postAck(command.id, true, enriched, snapshot);
      setVoxaAgentPresence((current) => ({
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
      const failure =
        error instanceof LiveCommandError
          ? { code: error.code, message: error.message, hint: error.hint }
          : {
              code: 'EXECUTION_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
      await this.postAck(command.id, false, undefined, this.snapshot(), failure);
      setVoxaAgentPresence((current) => ({
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

  private instrumentHistory() {
    if (this.historyInstrumented) return;
    const history: any = this.editor.history;
    if (!history || typeof history.saveVoxel !== 'function') return;
    const originalSaveVoxel = history.saveVoxel.bind(history);
    const session = this;
    history.saveVoxel = function patchedSaveVoxel(data: unknown) {
      const before = session.voxaDepth().undo;
      const result = originalSaveVoxel(data);
      session.modelRevision += 1;
      if (session.agentWriteDepth === 0 && session.voxaDepth().undo > before) {
        session.noteHumanWrite();
      }
      return result;
    };
    (history as any).__agentLiveInstrumented = true;
    this.historyInstrumented = true;
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
        summary: '人工编辑模型',
        revision: this.modelRevision,
        undoDepth: this.voxaDepth().undo,
      };
      this.humanOperation = { id: entry.operationId, lastAt: nowMs, writes: 0, entry };
      this.pushActivity(entry);
      setVoxaAgentPresence({ note: '检测到人工编辑；AI 需要重新 observe 后再继续' });
    }
    const operation = this.humanOperation!;
    operation.lastAt = nowMs;
    operation.writes += 1;
    operation.entry.summary = `人工编辑模型（${operation.writes} 次）`;
    operation.entry.revision = this.modelRevision;
    this.humanEpoch += 1;
  };

  private voxaDepth() {
    try {
      return this.editor.history.getDepth();
    } catch {
      return { undo: 0, redo: 0 };
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
      name: getVoxaAgentPresence().agentName || 'agent',
      kind,
      at: new Date().toISOString(),
      summary,
      revision: this.modelRevision,
      undoDepth: this.voxaDepth().undo,
    };
    this.pushActivity(entry);
    this.observedUndoDepth = entry.undoDepth;
    if (kind !== 'save') this.undoDepthAfterAgentWrite = entry.undoDepth;
  }

  private ensureWriteAllowed(kind: string) {
    if (!WRITE_KINDS.has(kind)) return;
    if (!this.hasObserved) {
      throw new LiveCommandError(
        'OBSERVE_REQUIRED',
        '还没有观察这个模型，拒绝写入',
        '先调用 observe 读取模型尺寸、光标与调色板，再下发写命令',
      );
    }
    if (
      this.humanEpoch !== this.observedHumanEpoch ||
      this.voxaDepth().undo !== this.observedUndoDepth
    ) {
      throw new LiveCommandError(
        'HUMAN_EDITED',
        '上次观察之后有人工编辑了模型，拒绝覆盖',
        `先 observe 看清新状态（自上次观察以来人工改动 ${Math.max(
          0,
          this.humanEpoch - this.observedHumanEpoch,
        )} 次），基于它继续`,
      );
    }
  }

  private commitVoxels<T>(run: () => T): T {
    this.agentWriteDepth += 1;
    try {
      return run();
    } finally {
      this.agentWriteDepth -= 1;
    }
  }

  private async run(kind: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (kind) {
      case 'inspect':
        return this.inspect(args);
      case 'observe':
        this.hasObserved = true;
        this.observedHumanEpoch = this.humanEpoch;
        this.observedUndoDepth = this.voxaDepth().undo;
        return { summary: '观察完成', snapshot: this.snapshot() };
      case 'look':
        return this.look(args);
      case 'cursor':
        return this.moveCursor(args);
      case 'paint':
        return this.paint(args);
      case 'erase':
        return this.erase(args);
      case 'paint_path':
        return this.paintPath(args);
      case 'fill_box':
        return this.fillBox(args);
      case 'palette':
        return this.paletteInfo(args);
      case 'set_color':
        return this.setColor(args);
      case 'trim':
        return this.trim();
      case 'undo':
        return this.undoAction();
      case 'redo':
        return this.redoAction();
      case 'save':
        return this.save();
      case 'screenshot':
        return this.screenshot();
      case 'say': {
        const text = String(args.text || args.message || '').trim().slice(0, 240);
        if (!text) throw new LiveCommandError('INVALID_ARGS', 'say 需要 text');
        setVoxaAgentPresence({ note: text });
        return { summary: text };
      }
      case 'wait':
        await sleep(Math.min(5_000, Math.max(0, Number(args.ms) || 0)));
        return { summary: '已停留观察' };
      default:
        throw new LiveCommandError(
          'UNKNOWN_COMMAND',
          `不认识的指令：${kind}`,
          `支持：${Object.keys(KIND_LABEL).join(', ')}`,
        );
    }
  }

  private inspect(args: Record<string, unknown>) {
    const cells = Array.isArray(args.cells)
      ? (args.cells.map(asVec3).filter(Boolean) as Vec3Tuple[])
      : [];
    if (!cells.length) {
      throw new LiveCommandError('INVALID_ARGS', 'inspect 需要 cells: [[x,y,z], ...]');
    }
    const shape = this.shape();
    const model = this.model();
    const blocks = cells.slice(0, 256).map((cell) => {
      const voxel = roundTuple(cell);
      const inside =
        voxel[0] >= 0 && voxel[1] >= 0 && voxel[2] >= 0 &&
        voxel[0] < shape[0] && voxel[1] < shape[1] && voxel[2] < shape[2];
      return {
        at: voxel,
        inside,
        paletteId: inside ? model.voxels.getVoxel(voxel[0], voxel[1], voxel[2]) : -1,
      };
    });
    return {
      summary: `读取 ${blocks.length} 格`,
      cells: blocks,
      revision: this.modelRevision,
      undoDepth: this.voxaDepth().undo,
    };
  }

  private model() {
    return this.editor.voxelApp.models.destination;
  }

  private shape(): Vec3Tuple {
    const shape = this.model().voxels.shape as ArrayLike<number>;
    return [Number(shape[0]), Number(shape[1]), Number(shape[2])];
  }

  private async look(args: Record<string, unknown>) {
    const target = asVec3(args.target) || asVec3(args.at);
    if (!target) {
      throw new LiveCommandError(
        'INVALID_ARGS',
        'look 需要 target: [x,y,z]',
        '例如 {"target":[8,8,8],"distance":32}',
      );
    }
    const camera = this.editor.stage.getCamera();
    const controls = this.editor.stage.orbitControls;
    const distance = Math.max(4, Number(args.distance) || 32);
    const yaw = Number.isFinite(Number(args.yaw)) ? Number(args.yaw) : 0.85;
    const pitch = Number.isFinite(Number(args.pitch)) ? Number(args.pitch) : 0.62;
    const eye: Vec3Tuple = asVec3(args.eye) || [
      target[0] + Math.cos(pitch) * Math.sin(yaw) * distance,
      target[1] + Math.sin(pitch) * distance,
      target[2] + Math.cos(pitch) * Math.cos(yaw) * distance,
    ];
    const duration = Math.max(0, Math.min(5_000, Number(args.durationMs) ?? 700));

    if (!this.savedCamera) {
      this.savedCamera = {
        position: [camera.position[0], camera.position[1], camera.position[2]],
        target: [camera.target[0], camera.target[1], camera.target[2]],
        zoom: Number(camera.zoom) || 1,
      };
    }

    setVoxaAgentPresence({ lookTarget: target });
    const fromPosition: Vec3Tuple = [camera.position[0], camera.position[1], camera.position[2]];
    const fromTarget: Vec3Tuple = [camera.target[0], camera.target[1], camera.target[2]];

    await this.tween(duration, (t) => {
      const nextPosition = vec3.lerp(vec3.create(), fromPosition, eye, t);
      const nextTarget = vec3.lerp(vec3.create(), fromTarget, target, t);
      camera.setPosition(nextPosition);
      vec3.copy(camera.target, nextTarget);
      camera.lookAt(nextTarget);
      vec3.copy(controls.target, nextTarget);
      controls.update();
    });

    camera.setPosition(eye);
    vec3.copy(camera.target, target);
    camera.lookAt(target);
    vec3.copy(controls.target, target);
    controls.update();
    this.editor.voxelApp.pointer.update();

    return {
      summary: `镜头移动到 [${target.map((value) => value.toFixed(1)).join(', ')}]`,
      camera: { eye, target, distance },
    };
  }

  private tween(durationMs: number, onFrame: (t: number) => void) {
    if (durationMs <= 0) {
      onFrame(1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        if (this.stopped) {
          resolve();
          return;
        }
        const raw = Math.min(1, (now - start) / durationMs);
        onFrame(1 - Math.pow(1 - raw, 3));
        if (raw < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private moveCursor(args: Record<string, unknown>) {
    const at = asVec3(args.at) || asVec3(args.target) || asVec3(args);
    if (!at) throw new LiveCommandError('INVALID_ARGS', 'cursor 需要 at: [x,y,z]');
    const voxel = roundTuple(at);
    const normal = asVec3(args.normal) || asVec3(args.face);
    this.editor.voxelApp.pointer.setAgentVoxelPosition(
      vec3.fromValues(voxel[0], voxel[1], voxel[2]),
      normal ? vec3.fromValues(normal[0], normal[1], normal[2]) : undefined,
    );
    const color = this.model().voxels.getVoxel(voxel[0], voxel[1], voxel[2]);
    return {
      summary: `光标指向 [${voxel.join(', ')}]${color ? `（调色板 ${color}）` : '（空气）'}`,
      cursor: { voxel, paletteId: color },
    };
  }

  private paint(args: Record<string, unknown>) {
    const at = asVec3(args.at) || asVec3(args.target) || asVec3(args);
    if (!at) throw new LiveCommandError('INVALID_ARGS', 'paint 需要 at: [x,y,z]');
    const applied = this.commitVoxels(() => this.applyVoxel(roundTuple(at), this.resolveColor(args)));
    const summary = `放置体素于 [${applied.voxel.join(', ')}]（调色板 ${applied.color}）`;
    this.recordAgentActivity('paint', summary);
    return {
      summary,
      ...applied,
      revision: this.modelRevision,
      paced: false,
    };
  }

  private erase(args: Record<string, unknown>) {
    const at = asVec3(args.at) || asVec3(args.target) || asVec3(args);
    if (!at) throw new LiveCommandError('INVALID_ARGS', 'erase 需要 at: [x,y,z]');
    const applied = this.commitVoxels(() => this.applyVoxel(roundTuple(at), 0));
    const summary = applied.skipped
      ? `[${applied.voxel.join(', ')}] 本来就是空的`
      : `擦除 [${applied.voxel.join(', ')}]`;
    this.recordAgentActivity('erase', summary);
    return {
      summary,
      ...applied,
      revision: this.modelRevision,
      paced: false,
    };
  }

  private async paintPath(args: Record<string, unknown>) {
    const points = Array.isArray(args.points)
      ? (args.points.map(asVec3).filter(Boolean) as Vec3Tuple[])
      : [];
    if (!points.length) {
      throw new LiveCommandError('INVALID_ARGS', 'paint_path 需要 points: [[x,y,z], ...]');
    }
    if (points.length > MAX_PATH_CELLS) {
      throw new LiveCommandError(
        'TOO_MANY_CELLS',
        `一次最多 ${MAX_PATH_CELLS} 个点`,
        '拆成多段，让人能跟上',
      );
    }
    const color = this.resolveColor(args);
    const pace = Math.max(0, Math.min(1_000, Number(args.paceMs) ?? 45));
    const receipts: ProgressReceipt[] = [];
    const startedAt = Date.now();
    this.editor.history.setGroup();
    this.agentWriteDepth += 1;
    let grouped = true;
    let painted = 0;
    try {
      for (let index = 0; index < points.length; index += 1) {
        const outcome = this.applyVoxel(roundTuple(points[index]), color, true);
        if (!outcome.skipped) painted += 1;
        if (index % 16 === 0 || index === points.length - 1) {
          const note = `正在沿路径上色 ${index + 1}/${points.length}`;
          receipts.push({ at: new Date().toISOString(), done: index + 1, total: points.length, note });
          this.postProgress(note);
        }
        if (pace) await sleep(pace);
        if (this.stopped) break;
      }
      this.editor.history.unsetGroup();
      grouped = false;
      this.editor.voxelApp.saveHistory();
    } finally {
      if (grouped) this.editor.history.unsetGroup();
      this.agentWriteDepth -= 1;
    }
    const summary = `沿路径放置 ${painted}/${points.length} 个体素`;
    this.recordAgentActivity('paint_path', summary);
    return {
      summary,
      painted,
      total: points.length,
      paceMs: pace,
      durationMs: Date.now() - startedAt,
      receipts,
      revision: this.modelRevision,
      paced: pace > 0,
    };
  }

  private async fillBox(args: Record<string, unknown>) {
    const from = asVec3(args.from) || asVec3(args.min);
    const to = asVec3(args.to) || asVec3(args.max);
    if (!from || !to) {
      throw new LiveCommandError('INVALID_ARGS', 'fill_box 需要 from 与 to（各为 [x,y,z]）');
    }
    const min = from.map((value, index) => Math.min(value, to[index])) as Vec3Tuple;
    const max = from.map((value, index) => Math.max(value, to[index])) as Vec3Tuple;
    const size = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    const volume = size[0] * size[1] * size[2];
    if (volume > MAX_FILL_CELLS) {
      throw new LiveCommandError(
        'TOO_MANY_CELLS',
        `填充体积 ${volume} 超过上限 ${MAX_FILL_CELLS}`,
        '拆成几层/几块分别填充，或先用 paint_path 画轮廓',
      );
    }
    const color = this.resolveColor(args);
    const hollow = Boolean(args.hollow);
    const pace = Math.max(0, Math.min(1_000, Number(args.paceMs) ?? (volume > 600 ? 0 : 24)));
    const receipts: ProgressReceipt[] = [];
    const startedAt = Date.now();
    this.editor.history.setGroup();
    this.agentWriteDepth += 1;
    let grouped = true;
    let painted = 0;
    let visited = 0;
    try {
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
            const outcome = this.applyVoxel([x, y, z], color, true);
            if (!outcome.skipped) painted += 1;
            if (visited % 64 === 0) {
              const note = `正在填充 ${visited}/${volume}`;
              receipts.push({ at: new Date().toISOString(), done: visited, total: volume, note });
              this.postProgress(note);
            }
            if (pace) await sleep(pace);
          }
        }
      }
      this.editor.history.unsetGroup();
      grouped = false;
      this.editor.voxelApp.saveHistory();
    } finally {
      if (grouped) this.editor.history.unsetGroup();
      this.agentWriteDepth -= 1;
    }
    const summary = `填充 ${painted} 个体素（体积 ${volume}${hollow ? '，空心' : ''}）`;
    this.recordAgentActivity('fill_box', summary);
    return {
      summary,
      painted,
      volume,
      paceMs: pace,
      durationMs: Date.now() - startedAt,
      receipts,
      revision: this.modelRevision,
      paced: pace > 0,
    };
  }

  private undoAction() {
    const depth = this.voxaDepth().undo;
    if (this.undoDepthAfterAgentWrite < 0 || depth !== this.undoDepthAfterAgentWrite) {
      throw new LiveCommandError(
        'NOT_MY_ACTION',
        '撤销栈顶部不是这次会话的 AI 操作，拒绝撤销',
        '先 observe；如果确实要撤销人工改动，请人在 VOXA 里操作',
      );
    }
    this.commitVoxels(() => this.editor.history.undo());
    this.modelRevision += 1;
    const summary = '已撤销上一步 AI 操作';
    this.recordAgentActivity('undo', summary);
    return { summary, undoDepth: this.voxaDepth().undo, revision: this.modelRevision };
  }

  private redoAction() {
    const depth = this.voxaDepth();
    if (depth.redo <= 0 || depth.undo !== this.undoDepthAfterAgentWrite) {
      throw new LiveCommandError(
        'NOTHING_TO_REDO',
        '没有可重做的 AI 操作，或撤销栈已经被人改动',
        '先 observe 确认当前状态',
      );
    }
    this.commitVoxels(() => this.editor.history.redo());
    this.modelRevision += 1;
    const summary = '已重做 AI 操作';
    this.recordAgentActivity('redo', summary);
    return { summary, undoDepth: this.voxaDepth().undo, revision: this.modelRevision };
  }

  private paletteInfo(args: Record<string, unknown>) {
    const palette = store.getState().palette;
    const limit = Math.max(1, Math.min(64, Number(args.limit) || 24));
    const items = palette.items
      .map((item, index) => ({ index, item }))
      .filter((entry) => entry.item !== -1)
      .slice(0, limit)
      .map((entry) => ({ id: entry.index, rgb: (entry.item as { rgb?: number[] }).rgb }));
    return {
      summary: `调色板 ${palette.items.filter((item) => item !== -1).length} 个颜色，当前选中 ${palette.selectedId}`,
      selectedId: palette.selectedId,
      items,
    };
  }

  private setColor(args: Record<string, unknown>) {
    const id = Number(args.id ?? args.colorId ?? args.index);
    if (!Number.isInteger(id) || id < 0) {
      throw new LiveCommandError(
        'INVALID_ARGS',
        'set_color 需要 id（调色板序号）',
        '先 palette 读取可用 id',
      );
    }
    const palette = store.getState().palette;
    if (id >= palette.items.length || palette.items[id] === -1) {
      throw new LiveCommandError(
        'UNKNOWN_COLOR',
        `调色板没有这个颜色：${id}`,
        `有效范围 1..${palette.items.length - 1}（0 为保留位）`,
      );
    }
    store.dispatch(setSelectedId(id));
    return { summary: `已切换到调色板 ${id}`, selectedId: id };
  }

  private trim() {
    const result = this.commitVoxels(() => {
      const trimmed = this.editor.voxelApp.models.trim();
      this.editor.voxelApp.saveHistory();
      this.model().bakeData();
      return trimmed;
    });
    const summary = result.changed ? '已裁掉空白边界' : '没有需要裁剪的空白';
    this.recordAgentActivity('trim', summary);
    return {
      summary,
      changed: result.changed,
      revision: this.modelRevision,
    };
  }

  private async save() {
    await this.editor.manualSave();
    const summary = '模型已保存';
    this.recordAgentActivity('save', summary);
    return { summary };
  }

  private async screenshot() {
    const canvas = this.editor.stage.renderer.domElement;
    if (!canvas) throw new LiveCommandError('SCREENSHOT_UNAVAILABLE', '当前没有可截图的画布');
    // Force one frame so the buffer holds the latest camera/voxel state.
    this.editor.render();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!base64) throw new LiveCommandError('SCREENSHOT_UNAVAILABLE', '截图失败（画布为空）');
    return {
      summary: `截图 ${canvas.width}×${canvas.height}`,
      mimeType: 'image/jpeg',
      width: canvas.width,
      height: canvas.height,
      data: base64,
    };
  }

  private resolveColor(args: Record<string, unknown>) {
    const explicit = Number(args.paletteId ?? args.colorId ?? args.color);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const selected = Number(store.getState().palette.selectedId);
    if (!Number.isInteger(selected) || selected <= 0) {
      throw new LiveCommandError(
        'NO_COLOR_SELECTED',
        '当前没有选中调色板颜色',
        '先用 palette 读取颜色，再 set_color 选中，或在 paint 里传 paletteId',
      );
    }
    return selected;
  }

  private applyVoxel(voxel: Vec3Tuple, color: number, deferHistory = false) {
    const model = this.model();
    const shape = this.shape();
    if (
      voxel[0] < 0 || voxel[1] < 0 || voxel[2] < 0 ||
      voxel[0] >= shape[0] || voxel[1] >= shape[1] || voxel[2] >= shape[2]
    ) {
      throw new LiveCommandError(
        'OUT_OF_BOUNDS',
        `[${voxel.join(', ')}] 超出模型范围 [0..${shape[0] - 1}, 0..${shape[1] - 1}, 0..${shape[2] - 1}]`,
        '先 observe 拿到 bounds，或调整工作区尺寸',
      );
    }
    const previous = model.voxels.getVoxel(voxel[0], voxel[1], voxel[2]);
    if (previous === color) return { voxel, skipped: true, previous, color };
    model.voxels.setVoxel(voxel[0], voxel[1], voxel[2], color);
    model.bakeData();
    if (!deferHistory) this.editor.voxelApp.saveHistory();
    this.editor.voxelApp.pointer.update();
    return { voxel, skipped: false, previous, color };
  }

  private restoreCamera() {
    const saved = this.savedCamera;
    this.savedCamera = undefined;
    if (!saved) return;
    const camera = this.editor.stage.getCamera();
    const controls = this.editor.stage.orbitControls;
    camera.setPosition(saved.position);
    vec3.copy(camera.target, saved.target);
    camera.lookAt(saved.target);
    camera.zoom = saved.zoom;
    vec3.copy(controls.target, saved.target);
    controls.update();
  }

  /** Called when the human takes the camera back. */
  public releaseCamera() {
    this.restoreCamera();
    setVoxaAgentPresence({ lookTarget: undefined });
  }

  public snapshot(): Record<string, unknown> {
    const app = store.getState().app;
    const camera = this.editor.stage.getCamera();
    const presence = getVoxaAgentPresence();
    const model = this.model();
    const palette = store.getState().palette;
    const shape = this.shape();
    const pointer = this.editor.voxelApp.pointer as unknown as {
      voxelPos?: ArrayLike<number>;
      isAgentControlled?: () => boolean;
    };
    return {
      at: new Date().toISOString(),
      url: typeof window === 'undefined' ? null : window.location.href,
      project: {
        modelId:
          app.projectId ||
          (typeof window === 'undefined' ? 0 : getQueryValue(window.location.href, 'modelId')),
        projectType: app.projectType,
        mode: app.mode,
        editingSkinPartId: app.editingSkinPartId || null,
        saveState: app.saveState,
        editLocked: Boolean(app.editLock),
      },
      camera: {
        position: roundTuple(camera.position),
        target: roundTuple(camera.target),
        zoom: Number(Number(camera.zoom).toFixed(3)),
        agentControlled: Boolean(this.savedCamera),
      },
      cursor: pointer.voxelPos
        ? {
            voxel: roundTuple(pointer.voxelPos),
            agentControlled: Boolean(pointer.isAgentControlled?.()),
          }
        : null,
      bounds: { shape, cells: shape[0] * shape[1] * shape[2] },
      palette: {
        selectedId: palette.selectedId,
        available: palette.items.filter((item) => item !== -1).length,
      },
      occupiedCells: this.countOccupied(model),
      agent: { phase: presence.phase, action: presence.action, operationId: presence.action?.operationId },
      revision: {
        terrain: this.modelRevision,
        humanEdits: this.humanEpoch,
        undoDepth: this.voxaDepth().undo,
        observedHumanEdits: this.observedHumanEpoch,
        requiresObserve:
          !this.hasObserved ||
          this.humanEpoch !== this.observedHumanEpoch ||
          this.voxaDepth().undo !== this.observedUndoDepth,
      },
      activity: this.activity.slice(-20),
    };
  }

  private countOccupied(model: ReturnType<VoxaAgentLiveSession['model']>) {
    const data = model.voxels.data as unknown as ArrayLike<number>;
    let occupied = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0) occupied += 1;
    }
    return occupied;
  }

  private async postAck(
    id: string,
    ok: boolean,
    result: unknown,
    snapshot: Record<string, unknown>,
    error?: { code: string; message: string; hint?: string },
  ) {
    if (!this.sessionId) return;
    try {
      await fetch('/api/agent/v1/live/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      // The poll loop notices a dead session; a lost ack surfaces to the agent
      // as EDITOR_TIMEOUT and it must observe before retrying.
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
      body: JSON.stringify({ sessionId: this.sessionId, snapshot: this.snapshot(), note }),
    }).catch(() => undefined);
  }
}

let active: VoxaAgentLiveSession | undefined;

export function startVoxaAgentLive(editor: VoxelEditor): () => void {
  if (active) return () => undefined;
  active = new VoxaAgentLiveSession(editor);
  active.start();
  return () => {
    active?.stop();
    active = undefined;
  };
}

export function getVoxaAgentLiveSession() {
  return active;
}

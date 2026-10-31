import type { NextApiRequest, NextApiResponse } from 'next';
import {safeProviderFetch} from '../../../services/game-server/src/edit/ai/provider-http';
import {providerRequestUrl} from '../../../services/game-server/src/edit/ai/provider-url';
import {parseProviderUsage, cacheHitRate} from '../../../services/game-server/src/edit/ai/provider-usage';
import {conversationKey, loadConversation, loadConversationContext, saveConversation, type ConversationMessage} from './agent-conversation';
import {buildContextPayload, canonicalContext, type AgentContext} from './agent-context';
import {batRecipe, detectRecipe, type RecipeState} from './modeling-recipes';
import {retrieveDesignReferences} from './model-gallery';
import {buildProjections, buildQuality, formatModelingBrief} from './modeling-context';

export type VoxaAiCommand = {kind: string; args: Record<string, unknown>};
export type VoxaAiPlan = {message: string; commands: VoxaAiCommand[]; done: boolean; stage?: string};
export type VoxaToolResult = {kind: string; ok: boolean; error?: string};
export type VoxaHistoryRow = {role: 'user' | 'assistant'; content: string};
export type VoxaReasoning = 'off' | 'low' | 'medium' | 'high';

const kinds = new Set(['paint', 'erase', 'paint_path', 'fill_box', 'set_color', 'trim', 'part_patch', 'part_create', 'part_select', 'part_delete', 'part_group', 'part_move', 'palette_add', 'workspace_resize', 'sphere', 'ellipsoid', 'cylinder', 'erase_box', 'replace_color', 'copy_region', 'mirror']);
const PLAN_TIMEOUT_MS = 180_000;

const KIND_ALIASES: Record<string, string> = {
  createpart: 'part_create', partcreate: 'part_create', add_part: 'part_create', new_part: 'part_create',
  selectpart: 'part_select', partselect: 'part_select',
  deletepart: 'part_delete', partdelete: 'part_delete', remove_part: 'part_delete', partremove: 'part_delete',
  groupparts: 'part_group', partgroup: 'part_group', group_parts: 'part_group',
  movepart: 'part_move', partmove: 'part_move', move_part: 'part_move',
  patchpart: 'part_patch', partpatch: 'part_patch', patch_part: 'part_patch',
  paintvoxel: 'paint', paint_voxel: 'paint', place: 'paint', setvoxel: 'paint',
  remove: 'erase', erase_voxel: 'erase',
  path: 'paint_path', paintpath: 'paint_path', paint_path: 'paint_path', line: 'paint_path',
  fill: 'fill_box', fillbox: 'fill_box', box_fill: 'fill_box', boxfill: 'fill_box',
  setcolor: 'set_color', color: 'set_color',
  trimempty: 'trim', trim_empty: 'trim',
  paletteadd: 'palette_add', add_color: 'palette_add', addcolor: 'palette_add', palette: 'palette_add',
  resize: 'workspace_resize', resizeworkspace: 'workspace_resize', workspace: 'workspace_resize',
};

const COMMAND_FIELDS = new Set([
  'kind', 'tool', 'cmd', 'command', 'type', 'action', 'tool_name', 'toolName', 'functionName',
  'args', 'arguments', 'input', 'parameters', 'params', 'tool_input', 'action_input',
  'function', 'fn', 'tool_call', 'toolCall', 'functionCall', 'function_call', 'call', 'id', 'status',
]);
const NOISE_TYPES = new Set(['message', 'reasoning', 'output_text', 'reasoning_text', 'text', 'content']);

function normalizeKind(value: unknown) {
  const raw = String(value ?? '').trim();
  if (kinds.has(raw)) return raw;
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (kinds.has(key)) return key;
  return KIND_ALIASES[key] || KIND_ALIASES[key.replace(/_/g, '')] || key;
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isNoiseRow(row: Record<string, unknown>) {
  return NOISE_TYPES.has(String(row.type ?? '').toLowerCase());
}

function normalizeArgs(kind: string, args: Record<string, unknown>) {
  const value = { ...args };
  if (['paint', 'erase', 'paint_path', 'fill_box'].includes(kind)) {
    if (value.at === undefined) {
      const at = value.position ?? value.pos ?? value.coordinate ?? value.point;
      if (Array.isArray(at)) value.at = at;
    }
    if (value.colorId === undefined && value.color !== undefined) value.colorId = value.color;
    if (value.points === undefined && Array.isArray(value.path)) value.points = value.path;
    if (value.from === undefined && Array.isArray(value.start)) value.from = value.start;
    if (value.to === undefined && Array.isArray(value.end)) value.to = value.end;
  }
  if (kind === 'palette_add' && value.alias === undefined && typeof value.name === 'string' && value.name.startsWith('$')) value.alias = value.name;
  return value;
}

/**
 * Real gateways emit several command shapes:
 * {kind,args}, {cmd,...flat}, {tool,...flat}, {"paint":{...}} (DeepSeek stream),
 * Anthropic {type:"tool_use",name,input}, OpenAI {type:"function",function:{name,arguments}},
 * Responses {type:"function_call",name,arguments}, Gemini {functionCall:{name,args}}.
 */
export function coerceCommand(row: unknown): VoxaAiCommand | undefined {
  if (typeof row === 'string') {
    const kind = normalizeKind(row);
    return kinds.has(kind) ? {kind, args: {}} : undefined;
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const item = row as Record<string, unknown>;
  const keys = Object.keys(item);

  if (keys.length === 1) {
    const kind = normalizeKind(keys[0]);
    if (kinds.has(kind)) {
      const value = item[keys[0]];
      const parsed = parseArgs(value);
      if (parsed) return {kind, args: normalizeArgs(kind, parsed)};
      if (value && typeof value === 'object' && !Array.isArray(value)) return {kind, args: normalizeArgs(kind, value as Record<string, unknown>)};
      if (value === undefined || value === null) return {kind, args: {}};
      return undefined;
    }
  }

  const fnRaw = item.function ?? item.fn;
  const fn = fnRaw && typeof fnRaw === 'object' && !Array.isArray(fnRaw) ? fnRaw as Record<string, unknown> : undefined;
  const callRaw = item.tool_call ?? item.toolCall ?? item.functionCall ?? item.function_call ?? item.call;
  const call = callRaw && typeof callRaw === 'object' && !Array.isArray(callRaw) ? callRaw as Record<string, unknown> : undefined;

  let rawKind: unknown;
  const candidates = [
    item.kind, item.tool, item.cmd, item.command, item.action,
    item.tool_name, item.toolName, item.functionName,
    typeof fnRaw === 'string' ? fnRaw : undefined,
    fn?.name, call?.name, call?.tool, item.name,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) { rawKind = candidate; break; }
  }
  let kind = normalizeKind(rawKind);
  if (!kinds.has(kind)) {
    const typed = normalizeKind(item.type ?? call?.type ?? '');
    if (kinds.has(typed)) kind = typed;
  }
  if (!kinds.has(kind)) {
    for (const key of keys) {
      const candidate = normalizeKind(key);
      if (!kinds.has(candidate)) continue;
      const value = item[key];
      const parsed = parseArgs(value);
      if (parsed) return {kind: candidate, args: normalizeArgs(candidate, parsed)};
      if (value && typeof value === 'object' && !Array.isArray(value)) return {kind: candidate, args: normalizeArgs(candidate, value as Record<string, unknown>)};
      break;
    }
    return undefined;
  }

  const kindFromName = rawKind === item.name || rawKind === fn?.name || rawKind === call?.name || rawKind === call?.tool;
  const nested = item.args ?? item.arguments ?? item.input ?? item.parameters ?? item.params
    ?? item.tool_input ?? item.action_input ?? fn?.arguments ?? fn?.args ?? call?.args ?? call?.input ?? call?.arguments;
  const hasNested = nested !== undefined;
  let args = parseArgs(nested);
  if (!args) {
    if (hasNested) return undefined;
    args = {};
    for (const [key, value] of Object.entries(item)) {
      if (COMMAND_FIELDS.has(key)) continue;
      if (key === 'name' && kindFromName) continue;
      args[key] = value;
    }
  }
  return {kind, args: normalizeArgs(kind, args)};
}

export function coercePlanValue(value: unknown): VoxaAiPlan & { rejected: number; rejectedKinds: string[] } {
  let message = '';
  let rows: unknown[] = [];
  let done: boolean | undefined;
  let stage: string | undefined;

  if (Array.isArray(value)) {
    rows = value;
  } else if (value && typeof value === 'object') {
    let plan = value as Record<string, unknown>;
    if (plan.plan && typeof plan.plan === 'object') {
      const nested = coercePlanValue(plan.plan);
      if (nested.commands.length || nested.rejected) {
        return { ...nested, message: nested.message || (typeof plan.message === 'string' ? plan.message : '') };
      }
      plan = plan.plan as Record<string, unknown>;
    }
    message = typeof plan.message === 'string' ? plan.message
      : typeof plan.reply === 'string' ? plan.reply
        : typeof plan.text === 'string' ? plan.text : '';
    const arrayKeys = ['commands', 'actions', 'steps', 'tool_calls', 'toolCalls', 'function_calls', 'functionCalls', 'calls', 'operations', 'output', 'content'];
    for (const key of arrayKeys) {
      if (Array.isArray(plan[key])) { rows = plan[key] as unknown[]; break; }
    }
    if (!rows.length) {
      for (const key of ['commands', 'command', 'action', 'tool_call', 'toolCall', 'function_call', 'functionCall', 'call']) {
        const candidate = plan[key];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) { rows = [candidate]; break; }
      }
    }
    if (typeof plan.done === 'boolean') done = plan.done;
    else if (typeof plan.finished === 'boolean') done = plan.finished;
    else if (typeof plan.complete === 'boolean') done = plan.complete;
    else if (typeof plan.isDone === 'boolean') done = plan.isDone;
    if (typeof plan.stage === 'string' && /^S[0-5]$/.test(plan.stage)) stage = plan.stage;
  }

  if (rows.length > 32) throw new Error('Invalid model plan');
  const commands: VoxaAiCommand[] = [];
  const rejectedKinds: string[] = [];
  let considered = 0;
  for (const row of rows) {
    const object = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : undefined;
    if (object && isNoiseRow(object)) continue;
    considered += 1;
    const command = coerceCommand(row);
    if (command) {
      commands.push(command);
      continue;
    }
    const label = object
      ? object.kind ?? object.tool ?? object.cmd ?? object.command ?? object.name ?? `keys:${Object.keys(object).slice(0, 5).join('|')}`
      : typeof row;
    rejectedKinds.push(String(label).slice(0, 60));
  }
  if (commands.length > 32) throw new Error('Invalid model plan');
  return {
    message: message || (commands.length ? `已生成 ${commands.length} 项修改。` : '没有需要执行的修改。'),
    commands,
    done: done === true || (commands.length === 0 && considered === 0),
    stage,
    rejected: considered - commands.length,
    rejectedKinds,
  };
}

export function validateVoxaAiPlan(value: unknown): VoxaAiPlan {
  if (!value || typeof value !== 'object') throw new Error('Invalid model plan');
  const plan = value as Record<string, unknown>;
  if (typeof plan.message !== 'string' || plan.message.length > 32000 || !Array.isArray(plan.commands) || plan.commands.length > 32) throw new Error('Invalid model plan');
  if (plan.done !== undefined && typeof plan.done !== 'boolean') throw new Error('Invalid model plan');
  const commands = plan.commands.map((row: unknown) => {
    const cmd = row as Record<string, unknown>;
    if (!cmd || !kinds.has(String(cmd.kind)) || !cmd.args || typeof cmd.args !== 'object' || Array.isArray(cmd.args) || JSON.stringify(cmd.args).length > 64000) throw new Error('Invalid model command');
    return {kind: String(cmd.kind), args: cmd.args as Record<string, unknown>};
  });
  const stage = typeof plan.stage === 'string' && /^S[0-5]$/.test(plan.stage) ? plan.stage : undefined;
  return {message: plan.message, commands, done: plan.done === true || commands.length === 0, stage};
}

function historyRows(value: unknown): VoxaHistoryRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('Invalid conversation history');
  return value.map((row) => {
    const item = row as Record<string, unknown>;
    if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 8000) throw new Error('Invalid conversation history');
    return {role: item.role, content: item.content};
  });
}

function toolResultRows(value: unknown): VoxaToolResult[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid execution report');
  return value.map((row) => {
    const item = row as Record<string, unknown>;
    if (!item || typeof item.kind !== 'string' || item.kind.length > 40 || typeof item.ok !== 'boolean' || (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 500))) throw new Error('Invalid execution report');
    return {kind: item.kind, ok: item.ok, error: item.error as string | undefined};
  });
}

function stepValue(value: unknown) {
  if (value === undefined) return 0;
  const step = Number(value);
  if (!Number.isInteger(step) || step < 0 || step > 6) throw new Error('Invalid agent step');
  return step;
}

function reasoningValue(value: unknown): VoxaReasoning {
  if (value === undefined || value === 'off') return 'off';
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('Invalid reasoning effort');
}

function base() {
  const url = String(process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').replace(/\/$/, '');
  if (!url || !process.env.PERMISSION_TOKEN_SECRET) throw new Error('Identity service unavailable');
  return url;
}
async function internal(path: string, body: unknown, req: NextApiRequest, res: NextApiResponse) {
  const response = await fetch(`${base()}${path}`, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: {
    Authorization: `Bearer ${process.env.PERMISSION_TOKEN_SECRET}`, 'Content-Type': 'application/json',
    Cookie: String(req.headers.cookie || ''), 'X-Box-Player-IP': String(req.socket.remoteAddress || ''),
    'X-Box-Player-Proto': String(req.headers['x-forwarded-proto'] || 'https'),
    'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0,512),
  }, body: JSON.stringify(body)});
  const cookies = response.headers.getSetCookie?.();
  if (cookies?.length) res.setHeader('Set-Cookie', cookies);
  if (!response.ok) throw new Error(`Identity service refused request (${response.status})`);
  return response.json();
}

export async function voxaAiIdentity(req: NextApiRequest, res: NextApiResponse) {
  const result = await internal('/api/player-internal/runtime-identity', {}, req, res);
  if (!result.identity?.userId) throw new Error('Login required');
  return String(result.identity.userId);
}

export async function authorizeVoxaAiWrite(req: NextApiRequest, res: NextApiResponse, modelId: unknown) {
  if(!Number.isSafeInteger(Number(modelId)) || Number(modelId)<=0) throw new Error('Save the model before AI execution');
  const userId = await voxaAiIdentity(req, res);
  if(req.body?.runId && ['after','complete','failed','cancelled','unknown'].includes(req.body.phase)) return internal('/api/player-ai-internal/execution',{userId,runId:req.body.runId,event:{phase:req.body.phase,action:req.body.action,snapshot:req.body.snapshot}},req,res);
  const result = await internal('/api/player-ai-internal/policy', {userId, mapId: `voxa:${String(modelId || '')}`}, req, res);
  if (result.allowed !== true) throw new Error('AI execution disabled by administrator');
  const input=req.body;
  return internal('/api/player-ai-internal/execution',input.runId?{userId,runId:input.runId,event:{phase:input.phase || 'before',action:input.action || 'voxa-batch',snapshot:input.snapshot || ''}}:{userId,scope:`voxa:${String(modelId)}`,mode:input.mode==='review'?'review':'autonomous',providerId:input.providerId,model:input.model},req,res);
}

export const SYSTEM = `You are a senior VOXA voxel modeler and agent. Your output must read as a deliberate, hand-built model, not a few giant blocks.

Workflow (follow it across steps):
1. Read modelingBrief/projections/quality, parts and voxel cells. Propose a short part tree with target bounds (body, head, ears, wings, eyes, fangs, tail...). Keep independent parts separate.
2. Blockout with a few primitives/fill_box at the right proportions. Then REFINE the silhouette: erase_box and paint/erase single voxels to shape edges.
3. Add secondary forms and details: 1-voxel eyes, fangs, claws, wing membrane ridges, ears, joints, shading with 2-5 palette colors. Use mirror/copy_region for symmetry instead of hand-copying.
4. After each batch inspect projections and quality. If symmetry < 0.85, floating/extra components exist, proportions read poorly, or the front/side/top silhouettes do not resemble the target, fix those first.
5. done=true only when the model is recognizable from all three projections, parts are proportioned, symmetric where expected, detailed (eyes/fangs/edges), and palette/contrast are coherent. Otherwise continue with a small batch.

Rules:
- The prompt may include 'references' from the public VOXA gallery. Treat them as structural inspiration (proportions, part counts, palette size, detail density), never as templates to copy; invent a new design for the request.
- Never satisfy a character with one or two big boxes. A recognizable character normally needs a blockout plus 2-4 refinement/detail batches. Separate parts for body/head/limbs/wings/eyes; use mirror for paired parts; eyes/fangs/claws should be 1-voxel details (emissive eyes are encouraged).
- A character part tree is usually: body mass, head, ears, limbs/wings, eyes, fangs/claws, tail. Keep each part named and proportioned; do not merge everything into one part.
- Stages: the FIRST batch is S1 and must contain both the named part tree and its initial primitive blockout (part_create + sphere/ellipsoid/cylinder/fill_box). Do not spend a batch on an empty part tree; S0 is only for a clarification question when genuinely needed. Then S2 carve the silhouette with erase_box/paint_path; S3 secondary parts (ears, wing fingers, membrane scallops, tail, joints); S4 1-voxel details (eyes, fangs, claws) and 2-3 value steps per material; S5 polish (weld floaters, unify palette). Do not skip straight to S4.
- Part ordering: immediately after part_create (or part_select) emit that part's voxel commands; never create all parts first and paint later, because voxel commands apply to the most recently selected part.
- Organic masses use sphere/ellipsoid; ears/tail use cylinder or small boxes; wings use thin fill_box or hollow shells plus erase_box scallops; eyes/fangs use single paint. This is guidance, not a reason to skip any stage.
- Anti-block rules: a single fill_box/sphere/ellipsoid/cylinder should cover less than half of its part bounds; after every two large fills add at least one erase/paint/paint_path; a detail batch must be at least half paint/erase/paint_path; one box per part is forbidden. For symmetric parts build only one side and use mirror/copy_region.
- Done criteria: projections readable from front/side/top, symmetry score >= 0.9, floatingComponents 0, 4-8 palette colors for a 16^3 character, eyes/fangs/edge details present, and no new quality issue in two consecutive batches. Use modelingBrief/quality numbers; if symmetry is low or floaters exist, fix them before adding more mass.
- Prefer small precise commands over huge fills. Use fill_box only for solid masses; use sphere/ellipsoid/cylinder for organic masses; use erase_box/paint/erase for carving and edges.
- Use at most 32 commands per batch. Stay within shape bounds. Prefer symmetry; model one side then mirror/copy.
- Return ONLY JSON: {"stage":"S1","commands":[...],"message":"short reply in the user language","done":false}. Put commands first; keep message under 120 words; no reasoning or long prose.
- done=true only when complete; otherwise done=false and give the next batch.
- If an execution report lists failures, repair them first; never repeat successful changes.
- Never claim a change was applied; the editor applies commands.

Commands: paint/erase {at:[x,y,z],colorId}, paint_path {points:[[x,y,z]],colorId,paceMs:0}, fill_box {from:[x,y,z],to:[x,y,z],colorId,hollow?:false,paceMs:0}, erase_box {from,to} carves a region, replace_color {fromColorId,toColorId,from?,to?}, sphere {center:[x,y,z],radius:1..64,colorId,hollow?}, ellipsoid {center,radii:[rx,ry,rz],colorId,hollow?}, cylinder {base:[x,y,z],radius,height,axis:'x'|'y'|'z',colorId,hollow?}, copy_region {from,to,offset:[dx,dy,dz],mirrorAxis?:'x'|'y'|'z'}, mirror {axis:'x'|'y'|'z',plane?:number}, set_color {id}, trim {}, palette_add {alias:"$red",rgb:[255,0,0],emissive?:0}, workspace_resize {size:[x,y,z]}, part_patch {id,name?,position?,scale?,pivot?,rotationDegrees?,alpha?}, part_create {alias:"$body",name?}, part_select {id}, part_delete {id}, part_group {ids,alias,name?}, part_move {id,parentId}.

Root nodes cannot be removed or moved; cyclic hierarchy is forbidden. Max 32 commands, 8192 cells per fill/sphere, 4096 points per path. Coordinates are integer local voxels. Do not generate scripts. voxelContext.cells are occupied cells of the active part; truncated=true means unknown, not empty. The user message contains either 'context' (full state) or 'contextDelta': apply added/removed cells to the previous turn, treat omitted cells as unchanged, replace parts/palette only when present, and use current shape/partId. Use existing palette colorId or palette_add with $alias.`;


function redact(text: string, secret: string) {
  const value = String(text || '');
  return (secret ? value.split(secret).join('***') : value).replace(/\s+/g, ' ').trim().slice(0, 300);
}

type Prepared = {
  provider: any;
  prompt: string;
  systemMessages: ConversationMessage[];
  modelMessages: Array<{role: 'user' | 'assistant'; content: string}>;
  history: VoxaHistoryRow[];
  execution: VoxaToolResult[];
  step: number;
  reasoning: VoxaReasoning;
  model: string;
  userId: string;
  contextChars: number;
  projectId?: string;
  context: AgentContext;
  contextMode: 'full' | 'delta';
  quality: {symmetry: number; floating: number; components: number; colors: number; occupied: number; truncated: boolean};
  recipe?: RecipeState;
  conversationKey?: string;
};

async function prepare(req: NextApiRequest, res: NextApiResponse): Promise<Prepared> {
  const input = req.body;
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 || typeof input.providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.providerId) || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || JSON.stringify(input.context || {}).length > 200000) throw new Error('Invalid AI request');
  const history = historyRows(input.history);
  const execution = toolResultRows(input.toolResults);
  const step = stepValue(input.step);
  const reasoning = reasoningValue(input.reasoning);
  const userId = await voxaAiIdentity(req, res);
  const {provider} = await internal('/api/player-ai-internal/resolve', {userId, providerId: input.providerId}, req, res);
  const conversationId = typeof input.conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(input.conversationId) ? input.conversationId : '';
  const projectId = typeof input.projectId === 'number' && Number.isSafeInteger(input.projectId)
    ? String(input.projectId)
    : typeof input.projectId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(input.projectId) ? input.projectId : '';
  const cacheKey = conversationId ? conversationKey(userId, String(provider.id), String(input.model), SYSTEM, conversationId, projectId) : '';
  const stored = cacheKey ? loadConversation(cacheKey) : undefined;
  const previousRaw = cacheKey ? loadConversationContext(cacheKey) : undefined;
  const previousRecord = previousRaw && typeof previousRaw === 'object' && !Array.isArray(previousRaw) ? previousRaw as Record<string, any> : undefined;
  const storedContext = previousRecord && previousRecord.context ? previousRecord.context : previousRaw;
  const storedRecipe = previousRecord && previousRecord.recipe && previousRecord.recipe.kind === 'bat' ? previousRecord.recipe as RecipeState : undefined;
  const context = canonicalContext(input.context);
  const previous = storedContext ? canonicalContext(storedContext) : undefined;
  const built = buildContextPayload(context, previous);
  const projections = buildProjections(context);
  const quality = buildQuality(context);
  const modelingBrief = formatModelingBrief(projections, quality);
  const goal = typeof input.goal === 'string' && input.goal.trim() && input.goal.length <= 16000 ? input.goal : input.prompt;
  const references = retrieveDesignReferences(goal, 4);
  const qualitySummary = {
    symmetry: Number(quality.symmetryX.toFixed(3)),
    floating: quality.floatingComponents,
    components: quality.components,
    colors: quality.paletteUsage.length,
    occupied: quality.occupiedCells,
    truncated: quality.truncated,
  };
  // Stable context first; the request and step are the volatile tail.
  const prompt = JSON.stringify({
    ...built.payload,
    modelingBrief,
    references: references.length ? references : undefined,
    execution: execution.length ? execution : undefined,
    request: input.prompt,
    step,
  });
  const systemMessages: ConversationMessage[] = stored?.length
    ? [...stored, {role: 'user', content: prompt}]
    : [{role: 'system', content: SYSTEM}, ...history, {role: 'user', content: prompt}];
  const modelMessages = systemMessages.filter((message) => message.role !== 'system') as Array<{role: 'user' | 'assistant'; content: string}>;
  return {
    provider,
    prompt,
    systemMessages,
    modelMessages,
    history,
    execution,
    step,
    reasoning,
    model: String(input.model),
    userId,
    contextChars: prompt.length,
    projectId: projectId || undefined,
    context,
    contextMode: built.mode,
    quality: qualitySummary,
    recipe: storedRecipe,
    conversationKey: cacheKey || undefined,
  };
}

function takeRecipePlan(prepared: Prepared, prompt: string) {
  // The auto-template path is opt-in; the default agent designs from model
  // reasoning + gallery references + verification instead of copying a recipe.
  if (process.env.BOX_AI_RECIPE_FALLBACK !== 'true') return undefined;
  const blank = prepared.context.voxelContext.cells.length === 0;
  let state = prepared.recipe;
  if (!state) {
    if (!blank || detectRecipe(prompt) !== 'bat') return undefined;
    const shape = prepared.context.voxelContext.shape;
    state = {
      kind: 'bat',
      next: 0,
      shape: shape.length === 3
        ? [Math.max(1, shape[0] || 16), Math.max(1, shape[1] || 16), Math.max(1, shape[2] || 16)] as [number, number, number]
        : [16, 16, 16],
    };
  }
  const batches = batRecipe(state.shape);
  if (state.next >= batches.length) return undefined;
  const batch = batches[state.next];
  const next = state.next + 1;
  const done = next >= batches.length;
  if (prepared.conversationKey) {
    saveConversation(
      prepared.conversationKey,
      [...prepared.systemMessages, {role: 'assistant' as const, content: `[配方 ${batch.stage}] ${batch.message}`}],
      {context: prepared.context, recipe: done ? undefined : {...state, next}},
    );
  }
  return {message: batch.message, commands: batch.commands, done, stage: batch.stage};
}

function headersFor(provider: any) {
  const headers: Record<string, string> = {'Content-Type': 'application/json', ...(provider.headers || {})};
  if (provider.protocol === 'anthropic-messages') {
    headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function isOpenAIHost(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com' || host.endsWith('.openai.com') || host.endsWith('.openai.azure.com');
  } catch {
    return false;
  }
}

function anthropicMessages(messages: Array<{role: 'user' | 'assistant'; content: string}>) {
  const list: Array<{role: 'user' | 'assistant'; content: any}> = messages.map((message) => ({ role: message.role, content: message.content }));
  const mark = (index: number) => {
    if (index < 0 || index >= list.length) return;
    const item = list[index];
    if (typeof item.content !== 'string') return;
    list[index] = { role: item.role, content: [{ type: 'text', text: item.content, cache_control: { type: 'ephemeral' } }] };
  };
  // Last prior turn is a read anchor; the current user turn is a cache write.
  mark(list.length - 2);
  mark(list.length - 1);
  return list;
}

function isDeepSeekHost(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('deepseek.com');
  } catch {
    return false;
  }
}

/** DeepSeek uses none/low/high/max; OpenAI uses low/medium/high. */
function mappedReasoning(provider: any, reasoning: VoxaReasoning) {
  if (isDeepSeekHost(provider.baseUrl)) {
    if (reasoning === 'off') return 'none';
    if (reasoning === 'low') return 'low';
    if (reasoning === 'medium') return 'high';
    return 'max';
  }
  return reasoning === 'off' ? undefined : reasoning;
}

function bodyFor(prepared: Prepared, stream: boolean) {
  const {provider, modelMessages, model, reasoning, conversationKey: cacheKey} = prepared;
  if (provider.protocol === 'chat-completions') {
    const body: Record<string, unknown> = {model, messages: [{role: 'system', content: SYSTEM}, ...modelMessages], max_tokens: reasoning === 'off' ? 8192 : 12288, stream};
    const effort = mappedReasoning(provider, reasoning);
    if (effort) body.reasoning_effort = effort;
    if (isOpenAIHost(provider.baseUrl)) body.prompt_cache_key = `voxa-${model}`.slice(0, 64);
    return body;
  }
  if (provider.protocol === 'responses') {
    const body: Record<string, unknown> = {model, instructions: SYSTEM, input: modelMessages, max_output_tokens: reasoning === 'off' ? 12288 : 16384};
    if (stream) body.stream = true;
    const effort = mappedReasoning(provider, reasoning);
    if (effort) body.reasoning = {effort};
    if (isOpenAIHost(provider.baseUrl)) body.prompt_cache_key = `voxa-${model}`.slice(0, 64);
    return body;
  }
  if (provider.protocol === 'anthropic-messages') {
    const body: Record<string, unknown> = {
      model,
      system: [{type: 'text', text: SYSTEM, cache_control: {type: 'ephemeral'}}],
      messages: anthropicMessages(modelMessages),
      max_tokens: reasoning === 'off' ? 8192 : 12288,
    };
    if (stream) body.stream = true;
    if (reasoning !== 'off') body.thinking = {type: 'enabled', budget_tokens: reasoning === 'low' ? 1024 : reasoning === 'medium' ? 2048 : 4096};
    return body;
  }
  throw new Error('Unsupported AI protocol');
}

function contentText(provider: any, data: any) {
  if (provider.protocol === 'chat-completions') {
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }
  if (provider.protocol === 'responses') {
    return (data?.output || []).flatMap((item: any) => (item.content || []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text)).join('');
  }
  return (data?.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
}

/** Complete command objects that have already arrived inside the JSON stream. */
function completeCommands(raw: string): VoxaAiCommand[] {
  const key = raw.indexOf('"commands"');
  if (key < 0) return [];
  const start = raw.indexOf('[', key);
  if (start < 0) return [];
  const out: VoxaAiCommand[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') { if (depth === 0) objStart = index; depth += 1; continue; }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        try {
          const value = JSON.parse(raw.slice(objStart, index + 1));
          const command = coerceCommand(value);
          if (command) out.push(command);
        } catch {
          // Partial or malformed object: wait for more bytes.
        }
        objStart = -1;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }
  return out;
}

function deltaText(provider: any, payload: any) {
  if (provider.protocol === 'chat-completions') {
    const content = payload?.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  }
  if (provider.protocol === 'responses') {
    return payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string' ? payload.delta : '';
  }
  return payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta' && typeof payload.delta.text === 'string' ? payload.delta.text : '';
}

export async function generateVoxaAiPlan(req: NextApiRequest, res: NextApiResponse) {
  const prepared = await prepare(req, res);
  const {provider, userId, model} = prepared;
  const started = Date.now();
  const {runId} = await internal('/api/player-ai-internal/execution', {userId, scope: `voxa:${prepared.projectId || String(req.body?.context?.snapshot?.project?.modelId || 'planner')}`, mode: 'review', providerId: provider.id, model}, req, res);
  let completed = false;
  const recipe = takeRecipePlan(prepared, String(req.body?.prompt || ''));
  if (recipe) { completed = true; return {...recipe, quality: prepared.quality.occupied > 0 ? prepared.quality : undefined}; }
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  res.on('close', cancel);
  const timer = setTimeout(cancel, PLAN_TIMEOUT_MS);
  try {
    const response = await safeProviderFetch(providerRequestUrl(provider.baseUrl, provider.protocol), {
      method: 'POST', headers: headersFor(provider), body: JSON.stringify(bodyFor(prepared, false)), signal: abort.signal, redirect: 'error',
    });
    console.info('[voxa-ai] plan response', {status: response.status, contextChars: prepared.contextChars, elapsedMs: Date.now() - started});
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = '';
      try { detail = redact(JSON.parse(text)?.error?.message || JSON.parse(text)?.message || '', provider.apiKey); } catch { detail = redact(text, provider.apiKey); }
      throw new Error(`AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await response.json();
    const usage = parseProviderUsage(provider.protocol, data);
    inputTokens = usage.input; outputTokens = usage.output; cachedTokens = usage.cached; cacheWriteTokens = usage.cacheWrite;
    const text = contentText(provider, data);
    if (provider.protocol === 'responses' && data?.status === 'incomplete' && !String(text || '').trim()) {
      throw new Error(`模型未返回正文（${data?.incomplete_details?.reason || 'incomplete'}）：思考耗尽输出预算，请提高输出上限或换非推理模型`);
    }
    if (provider.protocol === 'chat-completions' && data?.choices?.[0]?.finish_reason === 'length' && !String(text || '').trim()) {
      throw new Error('模型只返回了思考内容：输出预算耗尽，请提高输出上限或换非推理模型');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 250000) throw new Error('AI provider returned invalid content');
    const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let value: unknown;
    try { value = JSON.parse(clean); } catch { completed = true; return {message: text, commands: [], done: true}; }
    const plan = coercePlanValue(value);
    if (plan.commands.length === 0 && plan.rejected > 0) throw new Error(`模型返回的命令格式不受支持：${plan.rejectedKinds.join(', ')}`);
    console.info('[voxa-ai] plan parsed', { commands: plan.commands.length, rejected: plan.rejected, stage: plan.stage });
    completed = true;
    return { message: plan.message, commands: plan.commands, done: plan.done, stage: plan.stage, quality: prepared.quality };
  } finally {
    clearTimeout(timer); res.off('close', cancel);
    console.info('[voxa-ai] plan finished', {completed, elapsedMs: Date.now() - started, contextMode: prepared.contextMode, contextChars: prepared.contextChars, inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheHitRate: cacheHitRate({input: inputTokens, output: outputTokens, cached: cachedTokens, cacheWrite: cacheWriteTokens, cacheMiss: Math.max(0, inputTokens - cachedTokens)})});
    await internal('/api/player-ai-internal/execution', {userId, runId, event: {phase: abort.signal.aborted ? 'cancelled' : completed ? 'complete' : 'failed', action: 'voxa-plan', inputTokens, outputTokens, cachedTokens, cacheWriteTokens}}, req, res).catch(() => undefined);
  }
}

export async function streamVoxaAiPlan(req: NextApiRequest, res: NextApiResponse) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const started = Date.now();
  let closed = false;
  const send = (value: Record<string, unknown>) => {
    if (closed || res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(value)}\n`);
  };
  let prepared: Prepared | undefined;
  let runId = '';
  let completed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', cancel);
  const timer = setTimeout(() => abort.abort(), PLAN_TIMEOUT_MS);
  try {
    send({type: 'phase', phase: 'preparing'});
    prepared = await prepare(req, res);
    const {provider, userId, model} = prepared;
    send({type: 'phase', phase: 'waiting'});
    const lease = await internal('/api/player-ai-internal/execution', {userId, scope: `voxa:${prepared.projectId || String(req.body?.context?.snapshot?.project?.modelId || 'planner')}`, mode: 'review', providerId: provider.id, model}, req, res);
    runId = String(lease.runId || '');
    const recipe = takeRecipePlan(prepared, String(req.body?.prompt || ''));
    if (recipe) {
      send({type: 'plan', message: recipe.message, commands: recipe.commands, done: recipe.done, stage: recipe.stage, quality: prepared.quality.occupied > 0 ? prepared.quality : undefined, usage: {input: 0, output: 0, cached: 0, cacheWrite: 0, hitRate: 0}});
      completed = true;
      return;
    }
    console.info('[voxa-ai] stream start', {contextChars: prepared.contextChars, reasoning: prepared.reasoning});
    const response = await safeProviderFetch(providerRequestUrl(provider.baseUrl, provider.protocol), {
      method: 'POST', headers: headersFor(provider), body: JSON.stringify(bodyFor(prepared, true)),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]), redirect: 'error',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = '';
      try { detail = redact(JSON.parse(text)?.error?.message || JSON.parse(text)?.message || '', provider.apiKey); } catch { detail = redact(text, provider.apiKey); }
      throw new Error(`AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const contentType = response.headers.get('content-type') || '';
    let text = '';
    let emitted = 0;
    let firstByteMs = 0;
    let incompleteReason = '';
    const emitCommands = (raw: string) => {
      const list = completeCommands(raw);
      while (emitted < list.length) {
        const command = list[emitted];
        send({type: 'command', index: emitted, kind: command.kind, args: command.args});
        emitted += 1;
      }
    };
    if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const {value, done} = await reader.read();
        if (done) break;
        if (!firstByteMs) { firstByteMs = Date.now() - started; send({type: 'phase', phase: 'generating'}); }
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payloadText = line.slice(5).trim();
          if (!payloadText) continue;
          if (payloadText === '[DONE]') { finished = true; break; }
          let payload: any;
          try { payload = JSON.parse(payloadText); } catch { continue; }
          if (payload?.type === 'response.incomplete' || payload?.type === 'response.failed') {
            incompleteReason = payload?.response?.incomplete_details?.reason || payload?.response?.error?.message || payload?.error?.message || String(payload.type);
          }
          const delta = deltaText(provider, payload);
          if (delta) {
            text += delta;
            emitCommands(text);
            if (text.length % 400 < delta.length) send({type: 'progress', chars: text.length});
          }
          const usage = parseProviderUsage(provider.protocol, payload);
          if (usage.input || usage.output || usage.cached || usage.cacheWrite) { inputTokens = usage.input || inputTokens; outputTokens = usage.output || outputTokens; cachedTokens = usage.cached || cachedTokens; cacheWriteTokens = usage.cacheWrite || cacheWriteTokens; }
        }
      }
      buffer += decoder.decode();
      for (const rawLine of buffer.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payloadText = line.slice(5).trim();
        if (!payloadText || payloadText === '[DONE]') continue;
        try {
          const payload = JSON.parse(payloadText);
          const delta = deltaText(provider, payload);
          if (delta) { text += delta; emitCommands(text); }
          const usage = parseProviderUsage(provider.protocol, payload);
          if (usage.input || usage.output || usage.cached || usage.cacheWrite) { inputTokens = usage.input || inputTokens; outputTokens = usage.output || outputTokens; cachedTokens = usage.cached || cachedTokens; cacheWriteTokens = usage.cacheWrite || cacheWriteTokens; }
        } catch { /* ignore partial trailing line */ }
      }
    } else {
      const data = await response.json();
      const usage = parseProviderUsage(provider.protocol, data);
      inputTokens = usage.input; outputTokens = usage.output; cachedTokens = usage.cached; cacheWriteTokens = usage.cacheWrite;
      text = contentText(provider, data);
      emitCommands(text);
    }
    send({type: 'phase', phase: 'parsing'});
    if (!text.trim() || text.length > 250000) throw new Error(incompleteReason ? `模型未返回正文（${incompleteReason}）：思考耗尽输出预算，请提高输出上限或换非推理模型` : 'AI provider returned invalid content');
    if (prepared.conversationKey) saveConversation(prepared.conversationKey, [...prepared.systemMessages, {role: 'assistant', content: text}], {context: prepared.context});
    const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let value: unknown;
    try { value = JSON.parse(clean); } catch {
      completed = true;
      send({type: 'plan', message: text, commands: [], done: true});
      return;
    }
    const plan = coercePlanValue(value);
    if (plan.commands.length === 0 && plan.rejected > 0) throw new Error(`模型返回的命令格式不受支持：${plan.rejectedKinds.join(', ')}`);
    completed = true;
    console.info('[voxa-ai] stream done', {firstByteMs, totalMs: Date.now() - started, contextMode: prepared.contextMode, contextChars: prepared.contextChars, chars: text.length, commands: plan.commands.length, rejected: plan.rejected, rejectedKinds: plan.rejectedKinds.slice(0, 6), inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheHitRate: cacheHitRate({input: inputTokens, output: outputTokens, cached: cachedTokens, cacheWrite: cacheWriteTokens, cacheMiss: Math.max(0, inputTokens - cachedTokens)})});
    send({type: 'plan', message: plan.message, commands: plan.commands, done: plan.done, stage: plan.stage, quality: prepared.quality, usage: {input: inputTokens, output: outputTokens, cached: cachedTokens, cacheWrite: cacheWriteTokens, hitRate: cacheHitRate({input: inputTokens, output: outputTokens, cached: cachedTokens, cacheWrite: cacheWriteTokens, cacheMiss: Math.max(0, inputTokens - cachedTokens)})}});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI request failed';
    console.info('[voxa-ai] stream failed', {elapsedMs: Date.now() - started, message: message.slice(0, 120)});
    send({type: 'error', message: redact(message, prepared?.provider?.apiKey || '') || 'AI request failed'});
  } finally {
    clearTimeout(timer);
    res.off('close', cancel);
    if (prepared) {
      await internal('/api/player-ai-internal/execution', {
        userId: prepared.userId,
        runId: runId || undefined,
        event: {phase: abort.signal.aborted ? 'cancelled' : completed ? 'complete' : 'failed', action: 'voxa-plan', inputTokens, outputTokens, cachedTokens, cacheWriteTokens},
      }, req, res).catch(() => undefined);
    }
    closed = true;
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

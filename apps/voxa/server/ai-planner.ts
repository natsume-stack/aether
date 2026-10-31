import type { NextApiRequest, NextApiResponse } from 'next';
import {safeProviderFetch} from '../../../services/game-server/src/edit/ai/provider-http';
import {providerRequestUrl} from '../../../services/game-server/src/edit/ai/provider-url';

export type VoxaAiCommand = {kind: string; args: Record<string, unknown>};
export type VoxaAiPlan = {message: string; commands: VoxaAiCommand[]; done: boolean};
export type VoxaToolResult = {kind: string; ok: boolean; error?: string};
export type VoxaHistoryRow = {role: 'user' | 'assistant'; content: string};
export type VoxaReasoning = 'off' | 'low' | 'medium' | 'high';

const kinds = new Set(['paint', 'erase', 'paint_path', 'fill_box', 'set_color', 'trim', 'part_patch', 'part_create', 'part_select', 'part_delete', 'part_group', 'part_move', 'palette_add', 'workspace_resize']);
const PLAN_TIMEOUT_MS = 180_000;

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
  return {message: plan.message, commands, done: plan.done === true || commands.length === 0};
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
  if (!Number.isInteger(step) || step < 0 || step > 4) throw new Error('Invalid agent step');
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

const SYSTEM = `You are the VOXA voxel agent. Work the way a coding agent works: read the supplied context, plan the smallest correct batch, execute it, inspect the execution report, repair failures, and continue only while the goal is unfinished.

Return ONLY a JSON object: {"message":"reply in the user language","commands":[...],"done":false}.
- done=true only when the user's goal is fully satisfied by the work already applied. Otherwise return the next batch and done=false.
- If the execution report lists failures, fix those first. Never repeat changes that already succeeded.
- If the report shows every command succeeded and the goal is met, return commands:[] and done=true.
- Never claim a change was applied; the editor applies commands after this reply.
- Prefer a few precise commands over broad rewrites. Re-read voxelContext and parts before editing.

Commands: paint/erase {at:[x,y,z],colorId}, paint_path {points:[[x,y,z]],colorId,paceMs:0}, fill_box {from:[x,y,z],to:[x,y,z],colorId,hollow:false,paceMs:0}, set_color {id}, trim {}, palette_add {alias:"$red",rgb:[255,0,0],emissive?:0} adds an RGB color (0..255), workspace_resize {size:[x,y,z]} resizes the active voxel canvas (axes 1..256, at most 1048576 cells; native resize recenters X/Z and may crop voxels), part_patch {id,name?,position?:[x,y,z],scale?:[x,y,z],pivot?:[x,y,z],rotationDegrees?:[x,y,z],alpha?:0.5}, part_create {alias:"$body",name?} creates a part and selects its voxel canvas, part_select {id} selects a part before painting, part_delete {id} removes an existing part or group, part_group {ids:[id,...],alias:"$group",name?} groups sibling parts, part_move {id,parentId} reparents a part/group into an existing group.

Root nodes cannot be removed or moved; cyclic hierarchy is forbidden. Maximum 32 commands per batch, 8192 cells per fill, 4096 points per path. Coordinates are integer local voxel coordinates within the current shape. Do not generate scripts or arbitrary code. Empty commands for advice. Parts/context describe the currently open unsaved model. voxelContext.cells are occupied cells of the active part only; truncated=true means missing cells are unknown, not empty. Select the correct part before editing. Use existing palette colorId or palette_add and reference its $alias in later commands.`;

function redact(text: string, secret: string) {
  const value = String(text || '');
  return (secret ? value.split(secret).join('***') : value).replace(/\s+/g, ' ').trim().slice(0, 300);
}

type Prepared = {
  provider: any;
  prompt: string;
  messages: Array<{role: 'user' | 'assistant'; content: string}>;
  history: VoxaHistoryRow[];
  execution: VoxaToolResult[];
  step: number;
  reasoning: VoxaReasoning;
  model: string;
  userId: string;
  contextChars: number;
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
  const prompt = JSON.stringify({request: input.prompt, step, context: input.context, execution: execution.length ? execution : undefined});
  const messages = [...history, {role: 'user' as const, content: prompt}];
  return {
    provider,
    prompt,
    messages,
    history,
    execution,
    step,
    reasoning,
    model: String(input.model),
    userId,
    contextChars: prompt.length,
  };
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

function bodyFor(prepared: Prepared, stream: boolean) {
  const {provider, messages, prompt, history, model, reasoning} = prepared;
  if (provider.protocol === 'chat-completions') {
    const body: Record<string, unknown> = {model, messages: [{role: 'system', content: SYSTEM}, ...messages], max_tokens: 4096, stream};
    if (reasoning !== 'off') body.reasoning_effort = reasoning;
    return body;
  }
  if (provider.protocol === 'responses') {
    const transcript = history.map((row) => `[${row.role}] ${row.content}`).join('\n\n');
    const body: Record<string, unknown> = {model, instructions: SYSTEM, input: transcript ? `${transcript}\n\n${prompt}` : prompt, max_output_tokens: 4096};
    if (stream) body.stream = true;
    if (reasoning !== 'off') body.reasoning = {effort: reasoning};
    return body;
  }
  if (provider.protocol === 'anthropic-messages') {
    const body: Record<string, unknown> = {model, system: SYSTEM, messages, max_tokens: reasoning === 'off' ? 4096 : 8192};
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

function usageOf(provider: any, data: any) {
  const usage = provider.protocol === 'responses' ? data?.response?.usage || data?.usage : data?.usage;
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  return {input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0};
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
          if (value && kinds.has(String(value.kind)) && value.args && typeof value.args === 'object' && !Array.isArray(value.args)) {
            out.push({kind: String(value.kind), args: value.args});
          }
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
  const {runId} = await internal('/api/player-ai-internal/execution', {userId, scope: `voxa:${String(req.body?.context?.snapshot?.project?.modelId || 'planner')}`, mode: 'review', providerId: provider.id, model}, req, res);
  let completed = false;
  let inputTokens = 0;
  let outputTokens = 0;
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
    const usage = usageOf(provider, data);
    inputTokens = usage.input; outputTokens = usage.output;
    const text = contentText(provider, data);
    if (typeof text !== 'string' || !text.trim() || text.length > 250000) throw new Error('AI provider returned invalid content');
    const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let value: unknown;
    try { value = JSON.parse(clean); } catch { completed = true; return {message: text, commands: [], done: true}; }
    const plan = validateVoxaAiPlan(value);
    completed = true;
    return plan;
  } finally {
    clearTimeout(timer); res.off('close', cancel);
    console.info('[voxa-ai] plan finished', {completed, elapsedMs: Date.now() - started, inputTokens, outputTokens});
    await internal('/api/player-ai-internal/execution', {userId, runId, event: {phase: abort.signal.aborted ? 'cancelled' : completed ? 'complete' : 'failed', action: 'voxa-plan', inputTokens, outputTokens}}, req, res).catch(() => undefined);
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
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', cancel);
  const timer = setTimeout(() => abort.abort(), PLAN_TIMEOUT_MS);
  try {
    send({type: 'phase', phase: 'preparing'});
    prepared = await prepare(req, res);
    const {provider, userId, model} = prepared;
    send({type: 'phase', phase: 'waiting'});
    const lease = await internal('/api/player-ai-internal/execution', {userId, scope: `voxa:${String(req.body?.context?.snapshot?.project?.modelId || 'planner')}`, mode: 'review', providerId: provider.id, model}, req, res);
    runId = String(lease.runId || '');
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
          const delta = deltaText(provider, payload);
          if (delta) {
            text += delta;
            emitCommands(text);
            if (text.length % 400 < delta.length) send({type: 'progress', chars: text.length});
          }
          const usage = usageOf(provider, payload);
          if (usage.input || usage.output) { inputTokens = usage.input || inputTokens; outputTokens = usage.output || outputTokens; }
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
          const usage = usageOf(provider, payload);
          if (usage.input || usage.output) { inputTokens = usage.input || inputTokens; outputTokens = usage.output || outputTokens; }
        } catch { /* ignore partial trailing line */ }
      }
    } else {
      const data = await response.json();
      const usage = usageOf(provider, data);
      inputTokens = usage.input; outputTokens = usage.output;
      text = contentText(provider, data);
      emitCommands(text);
    }
    send({type: 'phase', phase: 'parsing'});
    if (!text.trim() || text.length > 250000) throw new Error('AI provider returned invalid content');
    const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    let value: unknown;
    try { value = JSON.parse(clean); } catch {
      completed = true;
      send({type: 'plan', message: text, commands: [], done: true});
      return;
    }
    const plan = validateVoxaAiPlan(value);
    completed = true;
    console.info('[voxa-ai] stream done', {firstByteMs, totalMs: Date.now() - started, chars: text.length, commands: plan.commands.length, inputTokens, outputTokens});
    send({type: 'plan', ...plan});
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
        event: {phase: abort.signal.aborted ? 'cancelled' : completed ? 'complete' : 'failed', action: 'voxa-plan', inputTokens, outputTokens},
      }, req, res).catch(() => undefined);
    }
    closed = true;
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

import type { NextApiRequest, NextApiResponse } from 'next';
import {safeProviderFetch} from '../../../services/game-server/src/edit/ai/provider-http';

export type VoxaAiCommand = {kind: string; args: Record<string, unknown>};
const kinds = new Set(['paint', 'erase', 'paint_path', 'fill_box', 'set_color', 'trim', 'part_patch']);
export function validateVoxaAiPlan(value: unknown): {message: string; commands: VoxaAiCommand[]} {
  if (!value || typeof value !== 'object') throw new Error('Invalid model plan');
  const plan = value as Record<string, unknown>;
  if (typeof plan.message !== 'string' || plan.message.length > 32000 || !Array.isArray(plan.commands) || plan.commands.length > 32) throw new Error('Invalid model plan');
  const commands = plan.commands.map((row: unknown) => {
    const cmd = row as Record<string, unknown>;
    if (!cmd || !kinds.has(String(cmd.kind)) || !cmd.args || typeof cmd.args !== 'object' || Array.isArray(cmd.args) || JSON.stringify(cmd.args).length > 64000) throw new Error('Invalid model command');
    return {kind: String(cmd.kind), args: cmd.args as Record<string, unknown>};
  });
  return {message: plan.message, commands};
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
  const userId = await voxaAiIdentity(req, res);
  const result = await internal('/api/player-ai-internal/policy', {userId, mapId: `voxa:${String(modelId || '')}`}, req, res);
  if (result.allowed !== true) throw new Error('AI execution disabled by administrator');
}

export async function generateVoxaAiPlan(req: NextApiRequest, res: NextApiResponse) {
  const input = req.body;
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 || typeof input.providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.providerId) || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || JSON.stringify(input.context || {}).length > 200000) throw new Error('Invalid AI request');
  const userId = await voxaAiIdentity(req, res);
  const {provider} = await internal('/api/player-ai-internal/resolve', {userId, providerId: input.providerId}, req, res);
  const system = `You are a VOXA voxel model coauthor. Return ONLY a JSON object {"message":"explanation in the user language", "commands":[{"kind":"...", "args":{}}]}. Never claim commands are applied. Use existing palette colorId and existing part IDs only. Commands: paint/erase {at:[x,y,z],colorId}, paint_path {points:[[x,y,z]],colorId,paceMs:0}, fill_box {from:[x,y,z],to:[x,y,z],colorId,hollow:false,paceMs:0}, set_color {id}, trim {}, part_patch {id,name?,position?:[x,y,z],scale?:[x,y,z]}. Maximum 32 commands, 8192 cells per fill and 4096 points per path. Coordinates are integer local voxel coordinates within the current shape. Do not generate scripts or arbitrary code. Empty commands for advice. Parts/context describe the currently open unsaved model.`;
  const prompt = JSON.stringify({request: input.prompt, context: input.context});
  const messages = [{role: 'user', content: prompt}];
  const headers: Record<string,string> = {'Content-Type':'application/json', ...(provider.headers || {})};
  let path: string; let body: unknown;
  if (provider.protocol === 'chat-completions') {
    path='/chat/completions'; headers.Authorization=`Bearer ${provider.apiKey}`;
    body={model:input.model, messages:[{role:'system',content:system},...messages],max_tokens:4096,stream:false};
  } else if (provider.protocol === 'responses') {
    path='/responses';headers.Authorization=`Bearer ${provider.apiKey}`;
    body={model:input.model,instructions:system,input:prompt,max_output_tokens:4096};
  } else if (provider.protocol === 'anthropic-messages') {
    path='/messages';headers['x-api-key']=provider.apiKey;headers['anthropic-version']='2023-06-01';
    body={model:input.model,system,messages,max_tokens:4096};
  } else throw new Error('Unsupported AI protocol');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  res.on('close',cancel);
  const timer=setTimeout(cancel,120000);
  try {
    const response=await safeProviderFetch(`${String(provider.baseUrl).replace(/\/$/,'')}${path}`, {method:'POST',headers,body:JSON.stringify(body),signal:abort.signal,redirect:'error'});
    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
    const data=await response.json();
    const text=provider.protocol==='chat-completions' ? data.choices?.[0]?.message?.content : provider.protocol==='responses' ? (data.output || []).flatMap((item:any)=>(item.content || []).filter((part:any)=>part.type==='output_text').map((part:any)=>part.text)).join('') : (data.content || []).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('');
    if (typeof text!=='string' || !text.trim() || text.length>250000) throw new Error('AI provider returned invalid content');
    const clean=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    let value: unknown;
    try {value=JSON.parse(clean);} catch {return {message:text,commands:[]};}
    return validateVoxaAiPlan(value);
  } finally {clearTimeout(timer);res.off('close',cancel);}
}

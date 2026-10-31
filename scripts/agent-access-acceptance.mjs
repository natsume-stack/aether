#!/usr/bin/env node
/**
 * Map access acceptance — two isolated maps, end to end, against a real Creator.
 *
 * Proves:
 *   1. each map has its own code (no code reuse / no cross-talk);
 *   2. a credential issued for map A is rejected on map B (live + batch surfaces);
 *   3. rotation kills the old code for new joins but keeps existing agents working;
 *   4. revoking one agent kills only that token;
 *   5. manifest hands the agent the editor URL + join code, with honest prerequisites.
 *
 * Needs a browser session cookie (the panel/manifest routes require a creator
 * identity). Codes and tokens are never written to the evidence file — only
 * short fingerprints — so the evidence can be shared safely.
 *
 *   node scripts/agent-access-acceptance.mjs --cookie "<Cookie: ...>" [--base ...]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(value.slice(2), next);
      i += 1;
    } else {
      args.set(value.slice(2), 'true');
    }
  }
}

const base = (args.get('base') || 'http://127.0.0.1:3127').replace(/\/+$/, '');
const cookie = String(args.get('cookie') || process.env.BOX_ACCEPTANCE_COOKIE || '').trim();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(args.get('out') || '.local-evidence/agent-access');
const suffix = Date.now().toString(36);
const mapA = args.get('map-a') || `agent-accept-a-${suffix}`;
const mapB = args.get('map-b') || `agent-accept-b-${suffix}`;

if (!cookie) {
  console.error('缺少 --cookie（浏览器登录后的 Cookie 头）。面板/manifest 路由需要创建者会话。');
  process.exit(2);
}

const evidence = { startedAt: new Date().toISOString(), base, mapA, mapB, steps: [], ok: false };
const results = [];

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function record(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail });
  evidence.steps.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function call(method, url, body, headers = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      Cookie: cookie,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: response.status, data };
}

const agent = (token) => ({ Authorization: `Bearer ${token}` });

async function createMap(id, name) {
  const created = await call('POST', '/api/local-projects', {
    id,
    name,
    author: 'acceptance',
    description: 'agent access acceptance fixture',
    mapSize: 64,
  });
  // Reusing an id from a previous run is fine: the isolation guarantees are
  // what we are testing, not project creation.
  if (created.status === 400 && /already exists|已被/.test(String(created.data?.message || ''))) return id;
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`创建地图失败 ${id}: HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  }
  return id;
}

async function stateCode(container) {
  const state = await call('GET', `/api/agent/v1/state?container=${encodeURIComponent(container)}`);
  if (state.status !== 200 || !state.data?.code) {
    throw new Error(`读取 ${container} 的识别码失败: HTTP ${state.status}`);
  }
  return state.data.code;
}

async function join(code, name) {
  return call('POST', '/api/agent/v1/join', { code, name });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // ── fixtures ──────────────────────────────────────────────────────────────
  await createMap(mapA, `Agent 验收 A ${suffix}`);
  await createMap(mapB, `Agent 验收 B ${suffix}`);
  record('两张隔离测试地图已创建', true, `${mapA}, ${mapB}`);

  const codeA = await stateCode(mapA);
  const codeB = await stateCode(mapB);
  record('两张地图各有独立识别码', codeA !== codeB, `A=${fingerprint(codeA)} B=${fingerprint(codeB)}`);

  // ── join ──────────────────────────────────────────────────────────────────
  const joinA = await join(codeA, 'accept-a');
  const joinB = await join(codeB, 'accept-b');
  record('地图码 A → join 成功', joinA.status === 201, `HTTP ${joinA.status}, project=${joinA.data?.project?.id}`);
  record('地图码 B → join 成功', joinB.status === 201, `HTTP ${joinB.status}, project=${joinB.data?.project?.id}`);
  if (joinA.status !== 201 || joinB.status !== 201) throw new Error('join 失败，无法继续');

  const tokenA = joinA.data.token;
  const tokenB = joinB.data.token;
  record('join 响应自带 project id 与编辑器地址', joinA.data.project?.id === mapA && String(joinA.data.map?.editorUrl).endsWith(`/e/${mapA}`),
    `editorUrl=${joinA.data.map?.editorUrl}`);
  record('join 响应明确“非纯网页直连”', joinA.data.transport?.pureWebDirect === false && joinA.data.transport?.requiresEditorTab === true,
    `transport=${JSON.stringify(joinA.data.transport && { kind: joinA.data.transport.kind, pureWebDirect: joinA.data.transport.pureWebDirect })}`);

  // ── per-map binding ──────────────────────────────────────────────────────
  const statusA = await call('GET', `/api/agent/v1/live/map/${mapA}/status`, undefined, agent(tokenA));
  record('A 的凭据可读 A 的状态', statusA.status === 200 && statusA.data?.projectId === mapA, `HTTP ${statusA.status}`);

  const crossLive = await call('GET', `/api/agent/v1/live/map/${mapB}/status`, undefined, agent(tokenA));
  record('A 的凭据不能读 B 的活体状态', crossLive.status === 401 && crossLive.data?.code === 'CROSS_MAP_TOKEN',
    `HTTP ${crossLive.status} ${crossLive.data?.code}`);

  const crossBatch = await call('GET', `/api/agent/v1/map/${mapB}/tools`, undefined, agent(tokenA));
  record('A 的凭据不能读 B 的批量工具面', crossBatch.status === 401 && crossBatch.data?.code === 'CROSS_MAP_TOKEN',
    `HTTP ${crossBatch.status} ${crossBatch.data?.code}`);

  const reverse = await call('GET', `/api/agent/v1/live/map/${mapA}/status`, undefined, agent(tokenB));
  record('B 的凭据不能读 A 的活体状态', reverse.status === 401 && reverse.data?.code === 'CROSS_MAP_TOKEN',
    `HTTP ${reverse.status} ${reverse.data?.code}`);

  // ── rotation ─────────────────────────────────────────────────────────────
  const rotated = await call('POST', '/api/agent/v1/state', { action: 'rotate-code', container: mapA });
  const newCode = rotated.data?.code;
  record('轮换 A 的识别码', rotated.status === 200 && Boolean(newCode) && newCode !== codeA, `HTTP ${rotated.status}`);

  const oldCodeJoin = await join(codeA, 'late-a');
  record('轮换后旧码不能新加入', oldCodeJoin.status === 401 && oldCodeJoin.data?.code === 'INVALID_CODE',
    `HTTP ${oldCodeJoin.status} ${oldCodeJoin.data?.code}`);

  const oldAgentStill = await call('GET', `/api/agent/v1/live/map/${mapA}/status`, undefined, agent(tokenA));
  record('轮换不影响已加入的 agent', oldAgentStill.status === 200, `HTTP ${oldAgentStill.status}`);

  const newCodeJoin = await join(newCode, 'late-a');
  record('轮换后新码可加入', newCodeJoin.status === 201, `HTTP ${newCodeJoin.status}`);
  const tokenNew = newCodeJoin.data?.token;

  // ── revocation ───────────────────────────────────────────────────────────
  const agentsA = await call('GET', `/api/agent/v1/state?container=${encodeURIComponent(mapA)}`);
  const firstAgent = agentsA.data?.agents?.find((candidate) => candidate.name === 'accept-a');
  const revoked = await call('POST', '/api/agent/v1/state', { action: 'revoke-agent', container: mapA, agentId: firstAgent?.id });
  record('吊销 A 的 accept-a agent', revoked.status === 200, `agentId=${firstAgent?.id}`);

  const revokedUse = await call('GET', `/api/agent/v1/live/map/${mapA}/status`, undefined, agent(tokenA));
  record('被吊销的令牌立即失效', revokedUse.status === 401 && revokedUse.data?.code === 'INVALID_TOKEN',
    `HTTP ${revokedUse.status} ${revokedUse.data?.code}`);
  const newAgentUse = await call('GET', `/api/agent/v1/live/map/${mapA}/status`, undefined, agent(tokenNew));
  record('同图其他 agent 不受吊销影响', newAgentUse.status === 200, `HTTP ${newAgentUse.status}`);

  // ── manifest handoff ────────────────────────────────────────────────────
  const manifest = await call('GET', `/api/agent/v1/live/manifest?container=${encodeURIComponent(mapA)}`);
  const editorUrl = manifest.data?.editorUrl || manifest.data?.handoff?.editorUrl;
  record('manifest 返回该图的编辑器深链', manifest.status === 200 && String(editorUrl).endsWith(`/e/${mapA}`), editorUrl);
  record('manifest 的交接信息是地址+码', manifest.data?.handoff?.projectId === mapA && manifest.data?.joinCode === newCode,
    `handoff=${JSON.stringify(manifest.data?.handoff && { editorUrl: manifest.data.handoff.editorUrl, projectId: manifest.data.handoff.projectId, minimal: manifest.data.handoff.minimal })}`);
  record('manifest 声明前置条件（非纯网页直连）',
    Array.isArray(manifest.data?.prerequisites) && manifest.data.prerequisites.some((line) => /不是纯网页直连/.test(line)),
    `${manifest.data?.prerequisites?.length || 0} 条`);
  record('manifest 只在创建者会话下可见', (await call('GET', `/api/agent/v1/live/manifest?container=${encodeURIComponent(mapA)}`, undefined, { Cookie: '' })).status !== 200,
    'no-cookie request denied');

  evidence.tokens = { a: fingerprint(tokenA), b: fingerprint(tokenB), new: fingerprint(tokenNew) };
  evidence.codes = { a: fingerprint(codeA), b: fingerprint(codeB), rotated: fingerprint(newCode) };
  evidence.ok = results.every((result) => result.pass);
  return evidence;
}

try {
  const final = await main();
  evidence.finishedAt = new Date().toISOString();
  const file = path.join(outDir, `acceptance-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\n证据：${file}`);
  console.log(final.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(final.ok ? 0 : 1);
} catch (error) {
  evidence.ok = false;
  evidence.error = (error && error.message) || String(error);
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `acceptance-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(`\n验收中断：${evidence.error}`);
  console.error(`证据：${file}`);
  process.exit(1);
}

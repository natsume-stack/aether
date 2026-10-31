#!/usr/bin/env node
'use strict';

/**
 * Agent stack — one entry point that starts the engine and then tells you,
 * concretely, what is running and how an AI attaches.
 *
 * Why this exists: the deployment used to be "run dev-all, then guess". The
 * table this prints is the answer to "启动后也不知道什么情况": every service gets
 * a port, a health check that actually ran, the editor URL a human should
 * open, and whether an editor tab is currently attached to the live channel.
 *
 *   node scripts/agent-stack.js             start everything (creator + voxa + player-service)
 *   node scripts/agent-stack.js --status    probe only, start nothing
 *   node scripts/agent-stack.js --json      machine-readable status (for CI / agents)
 *
 * It does not start Play or the admin site unless asked: those are not part of
 * the authoring loop and each one costs real memory on a laptop.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(repoRoot, '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(path.join(repoRoot, '.env'));
}
const port = (name, fallback) => Number(process.env[name] || fallback);
const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const asJson = args.has('--json');
const includePlay = args.has('--with-play');
const includeAdmin = args.has('--with-admin');

const SERVICES = [
  {
    name: 'creator',
    port: port('BOX_DEV_CREATOR_PORT', 3127),
    base: 'http://127.0.0.1',
    health: '/api/health-check',
    editor: '/',
    note: '地图编辑器（Creator）',
  },
  {
    name: 'voxa',
    port: port('BOX_DEV_VOXA_PORT', 3123),
    base: 'http://127.0.0.1',
    health: '/api/agent/v1/state',
    editor: '/',
    note: 'VOXA 模型编辑器',
    /** 401 is the expected answer without a browser session: the port is alive. */
    healthyStatuses: [200, 401, 403],
  },
  {
    name: 'player-service',
    port: port('BOX_DEV_PLAYER_SERVICE_PORT', 3124),
    base: 'http://127.0.0.1',
    health: '/api/health-check',
    note: '玩家身份服务',
    healthyStatuses: [200, 404],
  },
  {
    name: 'edit-runtime',
    port: port('BOX_DEV_EDIT_RUNTIME_PORT', 9967),
    base: 'http://127.0.0.1',
    // The edit runtime speaks the game wire protocol, not HTTP: an HTTP GET
    // simply hangs. A completed TCP handshake is the honest health signal.
    tcpOnly: true,
    note: '地图运行时（预览 / WS）',
  },
];

function request(url, timeoutMs = 2_500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 400),
          elapsedMs: Date.now() - started,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', elapsedMs: Date.now() - started, error: 'timeout' });
    });
    req.on('error', (error) => {
      resolve({ status: 0, body: '', elapsedMs: Date.now() - started, error: error.code || error.message });
    });
  });
}

function localDataPath(...parts) {
  const root = process.env.BOX_DEV_DATA_DIRECTORY || path.join(repoRoot, '.local-data');
  return path.join(root, ...parts);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The VOXA- code a human hands to the agent. */
function voxaJoinCode() {
  const store = readJson(localDataPath('apps/voxa/data/agent-access.json'));
  return store?.workspace?.code || '';
}

/** Per-map join codes live under the local engine's data directory. */
function mapJoinCode() {
  const candidates = [
    localDataPath('apps/game/data/agent-access.json'),
    localDataPath('apps/local-engine/data/agent-access.json'),
  ];
  for (const candidate of candidates) {
    const store = readJson(candidate);
    // The store is `{ maps: { <projectId>: entry } }` (agent-access.ts).
    const first = store?.maps && Object.values(store.maps)[0];
    if (first?.code) return { file: candidate, code: first.code, projectId: first.projectId };
  }
  return undefined;
}

function tcpProbe(port, timeoutMs = 2_000) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (ok, error) => {
      socket.destroy();
      resolve({ status: ok ? 1 : 0, ok, elapsedMs: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, error.code || error.message));
  });
}

async function probe() {
  const rows = [];
  for (const service of SERVICES) {
    if (service.tcpOnly) {
      const result = await tcpProbe(service.port);
      rows.push({
        name: service.name,
        port: service.port,
        note: service.note,
        editorUrl: '',
        status: result.status,
        ok: result.ok,
        elapsedMs: result.elapsedMs,
        error: result.error,
      });
      continue;
    }
    const result = await request(`${service.base}:${service.port}${service.health}`);
    const expected = service.healthyStatuses || [200];
    rows.push({
      name: service.name,
      port: service.port,
      note: service.note,
      editorUrl: service.editor ? `${service.base}:${service.port}${service.editor}` : '',
      status: result.status,
      ok: expected.includes(result.status),
      elapsedMs: result.elapsedMs,
      error: result.error,
    });
  }
  return rows;
}

function printTable(rows, extra) {
  const width = Math.max(...rows.map((row) => row.name.length), 4);
  console.log('');
  console.log('服务状态');
  for (const row of rows) {
    const mark = row.ok ? 'OK   ' : 'DOWN ';
    const detail = row.ok ? `${row.status} · ${row.elapsedMs} ms` : row.error || `HTTP ${row.status}`;
    console.log(`  ${mark}${row.name.padEnd(width)}  :${String(row.port).padEnd(5)} ${detail.padEnd(16)} ${row.note}`);
  }

  const editors = rows.filter((row) => row.ok && row.editorUrl);
  if (editors.length) {
    console.log('');
    console.log('编辑器入口');
    for (const row of editors) console.log(`  ${row.name.padEnd(width)}  ${row.editorUrl}`);
  }

  console.log('');
  console.log('活体通道（AI 接入方式）');
  console.log(`  地图  在 Creator 打开一张地图 → 右侧 Agent Active → 活体 页签 → 复制 MCP 配置`);
  console.log(`        面板会显示该地图的 MAP-xxxx 识别码与公开地址；把两者发给 AI 即可。`);
  console.log(`  VOXA  打开 ${rows.find((row) => row.name === 'voxa')?.editorUrl || 'http://127.0.0.1:3123'} → 右下 Agent Active → 活体`);
  if (extra.voxaCode) console.log(`        当前 VOX- 识别码：${extra.voxaCode}`);
  else console.log('        识别码在面板里（首次打开 VOXA 时生成）。');
  if (extra.mapCode) {
    console.log(`        地图识别码（${extra.mapCode.projectId}）：${extra.mapCode.code}`);
  }
  console.log('');
  console.log('MCP 客户端注册（任意机器都可，不要求跑在服务器上）');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "box3-agent": {');
  console.log('        "command": "node",');
  console.log('        "args": ["' + path.join(repoRoot, 'tools/box3-agent-mcp/src/index.js').replace(/\\/g, '\\\\') + '"],');
  console.log('        "env": {');
  console.log('          "BOX_MAP_AGENT_BASE_URL": "' + (extra.publicCreatorUrl || `http://127.0.0.1:${port('BOX_DEV_CREATOR_PORT', 3127)}`) + '",');
  console.log('          "BOX_MAP_AGENT_CODE": "<面板里的 MAP- 识别码>",');
  console.log('          "BOX_VOXA_AGENT_BASE_URL": "' + (extra.publicVoxaUrl || 'http://127.0.0.1:3123') + '",');
  console.log('          "BOX_VOXA_AGENT_CODE": "' + (extra.voxaCode || '<VOX- 识别码>') + '",');
  console.log(
    '          "BOX_MAP_PROJECT": "'
      + (extra.mapCode?.projectId || '<可选：join 自动发现>')
      + '"',
  );
  console.log('        }');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('自检：node tools/box3-agent-mcp/src/index.js --doctor');
  console.log('');
}

function startStack() {
  const env = { ...process.env };
  // The dependency build scripts are POSIX shell one-liners (`rm -rf build`),
  // so the Git Bash utilities must be on PATH or the stack cannot boot at all.
  //
  // Windows environment keys are case-insensitive but a plain object is not:
  // writing `env.PATH` next to the inherited `env.Path` creates two keys and
  // the child ends up with a PATH that no longer contains npm.
  const gitUsrBin = 'C:\\Program Files\\Git\\usr\\bin';
  if (process.platform === 'win32' && fs.existsSync(gitUsrBin)) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'Path';
    const existing = env[pathKey] || '';
    if (!existing.split(';').some((entry) => entry.trim().toLowerCase() === gitUsrBin.toLowerCase())) {
      env[pathKey] = `${gitUsrBin};${existing}`;
    }
  }
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'scripts/dev-all.js'), '--creator-only', includeAdmin ? '' : '--no-admin'].filter(
      Boolean,
    ),
    { cwd: repoRoot, env, stdio: 'inherit' },
  );
  child.once('exit', (code) => process.exit(code ?? 0));
  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  return child;
}

async function waitForServices(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await probe();
    if (rows.every((row) => row.ok)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return probe();
}

(async () => {
  const extra = {
    voxaCode: voxaJoinCode(),
    mapCode: mapJoinCode(),
    publicCreatorUrl: process.env.BOX_CREATOR_PUBLIC_URL,
    publicVoxaUrl: process.env.BOX_VOXA_PUBLIC_URL,
  };

  if (statusOnly) {
    const rows = await probe();
    if (asJson) {
      console.log(JSON.stringify({ rows, ...extra }, null, 2));
      process.exit(rows.every((row) => row.ok) ? 0 : 1);
    }
    printTable(rows, extra);
    process.exit(rows.every((row) => row.ok) ? 0 : 1);
  }

  console.log('启动 Agent 栈（Creator + VOXA + Player Service）…');
  startStack();
  const rows = await waitForServices();
  if (asJson) {
    console.log(JSON.stringify({ rows, ...extra }, null, 2));
  } else {
    printTable(rows, extra);
    if (!rows.every((row) => row.ok)) {
      console.log('有服务未就绪，检查 .local-dev-*.log 里的 [creator] / [voxa] 段。');
    }
  }
  // Keep the child in the foreground; this process exits with it.
  await new Promise(() => undefined);
})();

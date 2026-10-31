// One live-agent command against the real creator, using the same MCP client
// an external agent uses. Prints JSON and appends a receipt to the run log.
//
//   RUN_DIR=... node scripts/agent-live-cli.mjs <project> observe '{}'
//   RUN_DIR=... node scripts/agent-live-cli.mjs <project> place '{"at":[1,2,3],"block":"stone"}'
import fs from 'node:fs';
import path from 'node:path';

import { AgentClient } from '../tools/box3-agent-mcp/src/client.js';
import { loadConfig } from '../tools/box3-agent-mcp/src/config.js';

const [project, kind, rawArgs] = process.argv.slice(2);
if (!project || !kind) {
  console.error('usage: agent-live-cli.mjs <project> <kind> [jsonArgs]');
  process.exit(2);
}
const args = rawArgs ? JSON.parse(rawArgs) : {};
const runDir = process.env.RUN_DIR || path.resolve('.local-evidence/agent-live', 'browser-map');
fs.mkdirSync(runDir, { recursive: true });

const store = JSON.parse(
  fs.readFileSync(path.resolve('.local-data/apps/game/data/agent-access.json'), 'utf8'),
);
const entry = store.maps[project];
if (!entry?.code) {
  console.error(`no MAP code for ${project}`);
  process.exit(2);
}

const tokenFile = path.join(runDir, `token-${project}.json`);
const client = new AgentClient(
  loadConfig({
    ...process.env,
    BOX_MAP_AGENT_BASE_URL: process.env.BOX_MAP_AGENT_BASE_URL || 'http://127.0.0.1:3127',
    BOX_MAP_AGENT_CODE: entry.code,
    BOX_MAP_PROJECT: project,
    BOX_AGENT_MIN_ACTION_MS: '0',
    BOX_AGENT_WAIT_MS: String(args.waitMs || 30000),
  }),
);

// Reuse one agent credential across CLI invocations; otherwise every command
// redeems the code and the per-map agent slots fill up (AGENT_LIMIT).
try {
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (saved?.token) client.tokens.map = saved.token;
} catch {
  // first run: join on demand below
}
if (client.tokens.map) fs.writeFileSync(tokenFile, JSON.stringify({ token: client.tokens.map }), { mode: 0o600 });

const startedAt = new Date().toISOString();
let output;
try {
  if (kind === 'status') {
    output = { status: await client.mapStatus() };
  } else if (kind === 'observe') {
    const response = await client.mapObserve({
      includeTerrain: Boolean(args.includeTerrain),
      waitMs: args.waitMs,
    });
    output = {
      operationId: response.operationId,
      snapshot: response.snapshot || response.result,
      elapsedMs: response.elapsedMs,
    };
  } else {
    const response = await client.mapCommand(kind, args, { waitMs: args.waitMs });
    output = {
      operationId: response.operationId,
      result: response.result,
      snapshot: response.snapshot,
      elapsedMs: response.elapsedMs,
    };
  }
  output.ok = true;
} catch (error) {
  output = {
    ok: false,
    code: error.code,
    message: error.message,
    hint: error.hint,
    retryable: error.retryable,
    detail: error.detail,
  };
}
if (client.tokens.map) {
  fs.writeFileSync(tokenFile, JSON.stringify({ token: client.tokens.map }), { mode: 0o600 });
}
const record = { at: startedAt, project, kind, args, output };
fs.appendFileSync(path.join(runDir, 'commands.jsonl'), `${JSON.stringify(record)}\n`);
console.log(JSON.stringify(record, null, 2));
process.exit(output.ok ? 0 : 1);

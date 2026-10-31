// One live-agent command against the real VOXA editor.
//   RUN_DIR=... node scripts/agent-live-voxa-cli.mjs <kind> [jsonArgs]
import fs from 'node:fs';
import path from 'node:path';

import { AgentClient } from '../tools/box3-agent-mcp/src/client.js';
import { loadConfig } from '../tools/box3-agent-mcp/src/config.js';

const [kind, rawArgs] = process.argv.slice(2);
if (!kind) {
  console.error('usage: agent-live-voxa-cli.mjs <kind> [jsonArgs]');
  process.exit(2);
}
const args = rawArgs ? JSON.parse(rawArgs) : {};
const runDir = process.env.RUN_DIR || path.resolve('.local-evidence/agent-live', 'browser-voxa');
fs.mkdirSync(runDir, { recursive: true });

let code = String(process.env.BOX_VOXA_AGENT_CODE || '').trim();
if (!code) {
  const store = JSON.parse(
    fs.readFileSync(path.resolve('.local-data/apps/voxa/data/agent-access.json'), 'utf8'),
  );
  code = store.workspace?.code;
}
if (!code) {
  console.error('no VOX code in agent-access.json');
  process.exit(2);
}

const tokenFile = path.join(runDir, 'token-voxa.json');
const client = new AgentClient(
  loadConfig({
    ...process.env,
    BOX_VOXA_AGENT_BASE_URL: process.env.BOX_VOXA_AGENT_BASE_URL || 'http://127.0.0.1:3123',
    BOX_VOXA_AGENT_CODE: code,
    BOX_AGENT_MIN_ACTION_MS: '0',
    BOX_AGENT_WAIT_MS: String(args.waitMs || 30000),
  }),
);
try {
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (saved?.token) client.tokens.voxa = saved.token;
} catch {
  // first run joins on demand
}
if (client.tokens.voxa) fs.writeFileSync(tokenFile, JSON.stringify({ token: client.tokens.voxa }), { mode: 0o600 });

const startedAt = new Date().toISOString();
let output;
try {
  if (kind === 'status') {
    output = { status: await client.voxaStatus() };
  } else if (kind === 'observe') {
    const response = await client.voxaObserve({ waitMs: args.waitMs });
    output = {
      operationId: response.operationId,
      snapshot: response.snapshot || response.result?.snapshot || response.result,
      elapsedMs: response.elapsedMs,
    };
  } else {
    const response = await client.voxaCommand(kind, args, { waitMs: args.waitMs });
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
if (client.tokens.voxa) fs.writeFileSync(tokenFile, JSON.stringify({ token: client.tokens.voxa }), { mode: 0o600 });
const record = { at: startedAt, kind, args, output };
fs.appendFileSync(path.join(runDir, 'commands.jsonl'), `${JSON.stringify(record)}\n`);
console.log(JSON.stringify(record, null, 2));
process.exit(output.ok ? 0 : 1);

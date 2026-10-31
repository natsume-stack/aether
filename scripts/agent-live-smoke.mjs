// Agent-side smoke test for the live channels, run without a browser.
//
// Usage:
//   node scripts/agent-live-smoke.mjs            map (needs BOX_MAP_AGENT_CODE + BOX_MAP_PROJECT)
//   node scripts/agent-live-smoke.mjs voxa       VOXA (needs BOX_VOXA_AGENT_CODE)
//
// It deliberately uses the same MCP client the AI uses, so a green run proves
// the exact code path an external agent takes — not a hand-written HTTP call.

import { AgentClient } from '../tools/box3-agent-mcp/src/client.js';
import { loadConfig } from '../tools/box3-agent-mcp/src/config.js';

const kind = process.argv[2] === 'voxa' ? 'voxa' : 'map';
const config = loadConfig(process.env);
const client = new AgentClient(config);

const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

try {
  const joined = await client.join(kind);
  out('join', { agentId: joined.agentId, fingerprint: joined.tokenFingerprint });
} catch (error) {
  out('join', { ok: false, code: error.code, message: error.message, hint: error.hint });
  process.exit(1);
}

const status = kind === 'map' ? await client.mapStatus() : await client.voxaStatus();
out('status', {
  attached: status.attached,
  stale: status.stale,
  lastSeq: status.lastSeq,
  lastAction: status.lastAction?.kind,
});

if (!status.attached) {
  console.log('编辑器未接入：这是当前唯一缺少的一环，不是通道故障。');
  process.exit(0);
}

const observe = kind === 'map' ? await client.mapObserve({}) : await client.voxaObserve({});
const snapshot = observe.snapshot || observe.result?.snapshot || {};
out('observe', {
  camera: snapshot.camera,
  bounds: snapshot.bounds || snapshot.terrain,
  cursor: snapshot.cursor,
  occupiedCells: snapshot.occupiedCells,
});

if (kind === 'voxa') {
  const palette = await client.voxaCommand('palette', {});
  out('palette', {
    selectedId: palette.result?.selectedId,
    count: palette.result?.items?.length,
  });
}

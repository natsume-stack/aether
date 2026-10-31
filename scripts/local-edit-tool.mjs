// Direct local authoring call (no browser): forwards one engine tool through
// the Creator loopback route to the edit runtime's /internal/ai-tool.
//
//   node scripts/local-edit-tool.mjs <projectId> <tool> [jsonArgs]
import fs from 'node:fs';
import path from 'node:path';

const [projectId, toolName, rawArgs] = process.argv.slice(2);
if (!projectId || !toolName) {
  console.error('usage: local-edit-tool.mjs <projectId> <tool> [jsonArgs]');
  process.exit(2);
}
const args = rawArgs ? JSON.parse(rawArgs) : {};
const base = process.env.BOX_CREATOR_BASE_URL || 'http://127.0.0.1:3127';
const url = `${base}/api/internal/map-authoring/${encodeURIComponent(projectId)}/tool`;
const startedAt = new Date().toISOString();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tool: toolName, args }),
});
const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text.slice(0, 2_000) };
}
const record = { at: startedAt, projectId, tool: toolName, args, status: response.status, payload };
const logDir = process.env.RUN_DIR || path.resolve('.local-evidence/agent-live', 'local-build');
fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(path.join(logDir, 'tools.jsonl'), `${JSON.stringify(record)}\n`);
console.log(JSON.stringify(record, null, 2));
process.exitCode = response.ok && payload?.result?.success !== false ? 0 : 1;

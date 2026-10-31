// Revert every successful terrainApply recorded in hut-steps.jsonl, newest first.
import fs from 'node:fs';
import path from 'node:path';

const projectId = process.argv[2] || 'project-mvmuax72';
const base = process.env.BOX_CREATOR_BASE_URL || 'http://127.0.0.1:3127';
const url = `${base}/api/internal/map-authoring/${encodeURIComponent(projectId)}/tool`;
const logDir = process.env.RUN_DIR || path.resolve('.local-evidence/agent-live', 'local-build');
const logFile = path.join(logDir, 'hut-steps.jsonl');
const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const applies = lines
  .filter((entry) => entry.tool === 'terrainApply' && entry.payload?.result?.success && entry.payload.result.undoToken)
  .reverse();

async function call(tool, args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  return { status: response.status, ...(await response.json()) };
}

console.log(`reverting ${applies.length} terrainApply transaction(s)`);
for (const entry of applies) {
  const result = entry.payload.result;
  const response = await call('terrainRevert', { undoToken: result.undoToken });
  const reverts = response.result || {};
  console.log(
    `revert ${result.operationId}: ${reverts.success ? 'ok' : 'FAILED'} ${reverts.reverted ?? ''} cells, revision=${reverts.newRevision || reverts.revisionAfter || '?'}`,
  );
  if (!reverts.success) {
    console.log(JSON.stringify(reverts).slice(0, 600));
    process.exitCode = 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const info = await call('terrainInfo', {});
console.log(`final revision=${info.result?.revision}`);

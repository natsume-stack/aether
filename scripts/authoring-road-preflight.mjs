import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';
import { compileLocalTerrain } from '../tools/box3-agent-mcp/src/local-terrain.js';

const project = process.argv[2];
const client = authoringSmokeClient(project, ['terrainInfo', 'terrainRead', 'authoringProposal']);
await client.stopped();
const info = await client.tool('terrainInfo');
assert.equal(
  info.shape[1],
  64,
  'This fixture selects the whole 64-cell PVP height; do not truncate taller maps',
);
const region = { min: [60, 0, 116], max: [83, 63, 139] };
const snapshot = await client.tool('terrainRead', { region, limit: 36864 });
const intent = {
  region,
  kind: 'road',
  block: 5,
  width: 3,
  maxStepHeight: 0,
  path: [
    [65, 119],
    [70, 119],
  ],
  preserve: [{ min: [68, 22, 119], max: [68, 22, 119] }],
};
const plan = compileLocalTerrain(intent, snapshot);
assert.ok(plan.changed > 0);
assert.throws(
  () =>
    compileLocalTerrain(
      {
        ...intent,
        width: 1,
        maxStepHeight: 1,
        path: [
          [65, 125],
          [80, 125],
        ],
      },
      snapshot,
    ),
  { code: 'ROAD_TOO_STEEP' },
);
const proposal = await client.tool('authoringPropose', {
  steps: plan.steps,
  expectedRevision: plan.expectedRevision,
});
const after = await client.tool('terrainRead', { region, limit: 36864 });
assert.equal(after.revision, snapshot.revision);
assert.deepEqual(after.cells, snapshot.cells, 'Preflight must not change map content');
const review = await client.tool('authoringProposal', { proposalId: proposal.proposalId });
await fs.mkdir('.local-evidence', { recursive: true });
await fs.writeFile(
  '.local-evidence/road-real-map-preflight.json',
  JSON.stringify(
    {
      project,
      at: new Date().toISOString(),
      scope:
        'real PVP terrain, read/compile/propose only; no application, save, visual or playability acceptance',
      stage: 'proposed-source-unchanged',
      proposalId: proposal.proposalId,
      intent,
      originalRevision: snapshot.revision,
      changed: plan.changed,
      steps: plan.steps,
      cliffRefused: true,
      review,
      limitations: [
        'block 5 is a compiler/proposal test material, not a chosen road finish',
        'surface semantics and headroom must be visually checked before applying',
        'protected cell deliberately interrupts one road lane; no connected-playability claim',
      ],
    },
    null,
    2,
  ),
);
console.log(
  `Real map road preflight: ${plan.changed} proposed cells; cliff refused; source unchanged; ${proposal.proposalId}`,
);

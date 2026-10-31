'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Build-time only: stage the exact declaration/validator sources used by the
 * checker. Production never executes TypeScript or reaches into the monorepo.
 */
function packageAuthoringResources(
  destination = path.resolve(__dirname, '../dist/authoring-resources'),
) {
  const root = path.resolve(__dirname, '../../..');
  const files = [
    [
      'packages/script-api/dts/server-api-types.dts',
      'packages/script-api/dts/server-api-types.dts',
    ],
    [
      'packages/script-api/dts/client-api-types.dts',
      'packages/script-api/dts/client-api-types.dts',
    ],
    ['apps/game/src/resource/api-declarations.dts', 'apps/game/src/resource/api-declarations.dts'],
    ['tools/box3-map-mcp/src/ui-binding.js', 'ui-binding.mjs'],
  ];
  // Read everything before writing. A missing source must fail the build rather
  // than silently leave a deployment dependent on a developer checkout.
  const staged = files.map(([source, target]) => ({
    source,
    target,
    bytes: fs.readFileSync(path.join(root, source)),
  }));
  const manifest = {
    format: 'box3-authoring-resources/1',
    files: staged.map(({ source, target, bytes }) => ({
      source,
      target,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    })),
  };
  for (const { target, bytes } of staged) {
    const filename = path.join(destination, target);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
  fs.writeFileSync(
    path.join(destination, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}
module.exports = { packageAuthoringResources };
if (require.main === module) {
  const manifest = packageAuthoringResources();
  console.log(`Packaged ${manifest.files.length} authoring declaration/validator resources`);
}

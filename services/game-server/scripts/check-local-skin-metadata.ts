import assert from 'node:assert/strict';
import http from 'node:http';
import { getLocalExtraProject, mergeExtraProjectInfo, validLocalSkinMetadata } from '../src/project/project-extra';
import { ExtraProjectInfoSchema } from '@box/schema/project/hot-schema';
// Exercise the same packaged task runtime uses, without adding external
// TypeScript sources to game-server's rootDir. Build build-system first.
const { migrateSkin } = require('@box/build-system/tasks/migrate-skin');

async function main() {
  const hash = 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n';
  assert.equal(validLocalSkinMetadata({ version: 3, head: hash }), true);
  assert.equal(validLocalSkinMetadata({ version: 1, torso: hash }), true);
  for (const value of [null, [], { version: 7, dataHash: hash },
    { version: 3, head: [hash] }, { version: 3, projectName: 'model' }, { version: 3, 0: hash }])
    assert.equal(validLocalSkinMetadata(value), false);
  const failingBuild: any = { logger: { info() {} },
    async retrieveContentFromS3() { throw new Error('fixture-resource-unavailable'); } };
  let deadline: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(Promise.race([
      migrateSkin(failingBuild, hash, { version: 1, head: hash }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('migration-hung')), 2000); }),
    ]), /fixture-resource-unavailable/);
  } finally { clearTimeout(deadline); }
  assert.equal(await migrateSkin(failingBuild, hash, { version: 3 }), hash,
    'Failed migration must release the shared heavy-build lock');
  const errors: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/api/local/models') {
      res.end(JSON.stringify({ rows: url.searchParams.get('creativeMode') === '2'
        ? [{ modelId: 2, modelName: 'mislabeled bat', modelFileHash: hash }] : [] }));
    } else if (url.pathname === '/api/local/default-skin') res.end('null');
    else res.end(JSON.stringify({ version: 7, dataHash: hash, projectName: 'bat' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const extra = await getLocalExtraProject(`http://127.0.0.1:${address.port}`, 0,
      { info() {}, error(message: string) { errors.push(message); } } as any);
    assert.deepEqual(extra.skinAssets, {}, 'Invalid optional library skin must not poison map baking');
    assert.equal(errors.length, 1);
    const packaged = ExtraProjectInfoSchema.clone(ExtraProjectInfoSchema.identity);
    packaged.skinAssets['mislabeled bat__local_2'] = { hash };
    packaged.skinAssets['valid-packaged-skin'] = { hash };
    const merged = mergeExtraProjectInfo(packaged, extra);
    assert.equal(merged.skinAssets['mislabeled bat__local_2'], undefined,
      'Known invalid live entry must also exclude its previously saved snapshot alias');
    assert.deepEqual(merged.skinAssets['valid-packaged-skin'], { hash });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  console.log('Local skin metadata rejection and optional-library isolation passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

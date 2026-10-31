import assert from 'node:assert/strict';
import test from 'node:test';
import { compileLocalTerrain, buildLocalTerrainTools } from '../src/local-terrain.js';

const region = { min: [1, 1, 1], max: [4, 3, 4] };
function source() {
  const cells = [];
  for (let x = 1; x <= 4; x++)
    for (let y = 1; y <= 3; y++)
      for (let z = 1; z <= 4; z++) cells.push({ x, y, z, b: y < 3 ? 3 : 0 });
  return { revision: 'r0', truncated: false, cells };
}
function expand(plan) {
  const set = new Set();
  for (const step of plan.steps) {
    const r = step.args.region;
    for (let x = r.min[0]; x <= r.max[0]; x++)
      for (let y = r.min[1]; y <= r.max[1]; y++)
        for (let z = r.min[2]; z <= r.max[2]; z++) {
          const key = `${x},${y},${z}`;
          assert.equal(set.has(key), false, 'overlapping compiled boxes');
          set.add(key);
        }
  }
  return set;
}

test('local fill compacts to one box; protected hole never enters any box', () => {
  const all = compileLocalTerrain({ region, kind: 'fill', block: 5 }, source());
  assert.equal(all.steps.length, 1);
  assert.equal(expand(all).size, 48);
  const plan = compileLocalTerrain(
    { region, kind: 'fill', block: 5, preserve: [{ min: [2, 1, 2], max: [3, 3, 3] }] },
    source(),
  );
  const writes = expand(plan);
  assert.equal(writes.size, 36);
  for (let x = 2; x <= 3; x++)
    for (let y = 1; y <= 3; y++)
      for (let z = 2; z <= 3; z++) assert.equal(writes.has(`${x},${y},${z}`), false);
});

test('surface changes only existing top solid cells and replace respects source type', () => {
  const top = expand(compileLocalTerrain({ region, kind: 'surface', block: 5 }, source()));
  assert.equal(top.size, 16);
  assert.ok([...top].every((k) => k.split(',')[1] === '2'));
  const replaced = expand(
    compileLocalTerrain({ region, kind: 'replace', block: 5, sourceBlock: 0 }, source()),
  );
  assert.equal(replaced.size, 16);
  assert.ok([...replaced].every((k) => k.split(',')[1] === '3'));
});

test('truncated or duplicate snapshots cannot produce destructive proposals', () => {
  assert.throws(
    () => compileLocalTerrain({ region, kind: 'fill', block: 5 }, { ...source(), truncated: true }),
    { code: 'INCOMPLETE_SOURCE' },
  );
  const s = source();
  s.cells[0] = s.cells[1];
  assert.throws(() => compileLocalTerrain({ region, kind: 'fill', block: 5 }, s), {
    code: 'INCOMPLETE_SOURCE',
  });
});

test('operator reads source and forwards its revision to proposal creation without applying', async () => {
  const calls = [];
  const tool = buildLocalTerrainTools({
    mapAuthoring: async (name, args) => {
      calls.push({ name, args });
      return name === 'terrainRead' ? source() : { proposalId: 'p1' };
    },
  })[0];
  const result = await tool.handler({ region, kind: 'surface', block: 5 });
  assert.equal(result.data.proposalId, 'p1');
  assert.deepEqual(
    calls.map((c) => c.name),
    ['terrainRead', 'authoringPropose'],
  );
  assert.equal(calls[1].args.expectedRevision, 'r0');
});

test('road follows a four-connected diagonal without changing its surroundings or protected cells', () => {
  const plan = compileLocalTerrain(
    {
      region,
      kind: 'road',
      block: 5,
      width: 1,
      path: [
        [1, 1],
        [4, 4],
      ],
      preserve: [{ min: [2, 2, 2], max: [2, 2, 2] }],
    },
    source(),
  );
  const writes = expand(plan);
  assert.ok(writes.has('1,2,1'));
  assert.ok(writes.has('4,2,4'));
  assert.ok(writes.has('2,2,1'), 'diagonal bridge');
  assert.equal(writes.has('2,2,2'), false);
  assert.ok([...writes].every((k) => k.split(',')[1] === '2'));
  assert.ok(writes.size < 16);
});

test('road refuses cliff, absent ground, clipped width and unsafe snapshot values', () => {
  const intent = {
    region,
    kind: 'road',
    block: 5,
    width: 1,
    path: [
      [1, 1],
      [4, 1],
    ],
    maxStepHeight: 0,
  };
  assert.throws(() => compileLocalTerrain({ ...intent, block: 0 }, source()), {
    code: 'INVALID_ROAD_MATERIAL',
  });
  const slope = source();
  slope.cells.find((c) => c.x === 3 && c.y === 3 && c.z === 1).b = 3;
  assert.throws(() => compileLocalTerrain(intent, slope), { code: 'ROAD_TOO_STEEP' });
  const missing = source();
  for (const c of missing.cells) if (c.x === 3 && c.z === 1) c.b = 0;
  assert.throws(() => compileLocalTerrain(intent, missing), { code: 'ROAD_UNSUPPORTED' });
  assert.throws(() => compileLocalTerrain({ ...intent, width: 3 }, source()), {
    code: 'ROAD_OUTSIDE_REGION',
  });
  assert.throws(
    () =>
      compileLocalTerrain(
        {
          ...intent,
          path: [
            [1, 1],
            [9, 9],
          ],
        },
        source(),
      ),
    { code: 'INVALID_ROAD_PATH' },
  );
  const invalid = source();
  invalid.cells[0].b = -1;
  assert.throws(() => compileLocalTerrain(intent, invalid), { code: 'INVALID_SOURCE' });
});

test('road proposal reads actual terrain and only submits exact surface boxes under its revision', async () => {
  const calls = [];
  const tool = buildLocalTerrainTools({
    mapAuthoring: async (name, args) => {
      calls.push({ name, args });
      return name === 'terrainRead' ? source() : name === 'getBlock'
        ? {success:true,block:{id:5,valid:true,solid:true,collision:true,fluid:false}}
        : { proposalId: 'road1' };
    },
  })[0];
  const result = await tool.handler({
    region,
    kind: 'road',
    block: 5,
    width: 1,
    path: [
      [1, 1],
      [4, 1],
    ],
  });
  assert.equal(result.data.changed, 4);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['terrainRead', 'getBlock', 'authoringPropose'],
  );
  assert.equal(calls[2].args.expectedRevision, 'r0');
  assert.deepEqual(calls[2].args.steps, [
    { tool: 'terrainApply', args: { region: { min: [1, 2, 1], max: [4, 2, 1] }, block: 5 } },
  ]);
});

test('compiler matches engine 14-bit voxel types and keeps rotation bits out of source matching', () => {
  const s = source();
  for (const c of s.cells) if (c.y === 2) c.b = 4096 | (3 << 14);
  const surface = compileLocalTerrain({ region, kind: 'surface', block: 8192 }, s);
  assert.equal(surface.changed, 16, 'type 4096 is solid, not air');
  assert.ok([...expand(surface)].every((k) => k.split(',')[1] === '2'));
  const replace = compileLocalTerrain(
    { region, kind: 'replace', sourceBlock: 4096, block: 8192 },
    s,
  );
  assert.equal(replace.changed, 16, 'rotation is ignored when matching a 14-bit type');
  assert.equal(
    compileLocalTerrain(
      {
        region,
        kind: 'road',
        block: 8192,
        width: 1,
        path: [
          [1, 1],
          [4, 1],
        ],
      },
      s,
    ).changed,
    4,
  );
  assert.throws(() => compileLocalTerrain({ region, kind: 'fill', block: 16384 }, s), {
    code: 'INVALID_BLOCK',
  });
});

test('road material gate refuses fluid/noncollidable blocks before any proposal',async()=>{
  for(const flags of [{solid:true,collision:false,fluid:false},{solid:true,collision:true,fluid:true}]){
    const calls=[];
    const tool=buildLocalTerrainTools({mapAuthoring:async(name)=>{calls.push(name);return name==='terrainRead'?source():{success:true,block:{id:5,valid:true,...flags}};}})[0];
    await assert.rejects(tool.handler({region,kind:'road',block:5,width:1,path:[[1,1],[4,1]]}),{code:'INVALID_ROAD_MATERIAL'});
    assert.deepEqual(calls,['terrainRead','getBlock']);
  }
});

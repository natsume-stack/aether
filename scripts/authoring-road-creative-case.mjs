import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';
import { compileLocalTerrain } from '../tools/box3-agent-mcp/src/local-terrain.js';

const [project, action = 'prepare'] = process.argv.slice(2);
const client = authoringSmokeClient(project,['terrainRead','terrainInfo','getBlock','authoringProposal']);
const file='.local-evidence/road-creative-case.json';
const region={min:[60,0,116],max:[83,63,139]};
await client.stopped();
if(action==='prepare') {
  await fs.access(file).then(()=>{throw new Error('Case exists; inspect it rather than overwriting recovery evidence');},e=>{if(e.code!=='ENOENT')throw e;});
  const materials=await Promise.all([147,149].map(key=>client.tool('getBlock',{key})));
  assert.deepEqual(materials.map(result=>result.block.name),['light_grey_stone_brick','grey_stone_brick']);
  assert.ok(materials.every(result=>result.block.solid && result.block.collision && !result.block.fluid));
  const before=await client.tool('terrainRead',{region,limit:36864});
  const plan=compileLocalTerrain({region,kind:'road',block:147,width:3,maxStepHeight:0,path:[[65,119],[70,119]]},before);
  const top=new Map();
  for(const cell of before.cells) if((cell.b&16383)!==0)top.set(`${cell.x},${cell.z}`,Math.max(top.get(`${cell.x},${cell.z}`)??-1,cell.y));
  const targets=before.cells.filter(cell=>cell.x>=64&&cell.x<=71&&cell.z>=118&&cell.z<=120&&cell.y===top.get(`${cell.x},${cell.z}`));
  assert.equal(targets.length,24);
  assert.ok(targets.every(cell=>cell.y===22),'Require actual flat existing ground, not a roof/cliff');
  const steps=targets.map(cell=>({tool:'terrainApply',args:{region:{min:[cell.x,cell.y,cell.z],max:[cell.x,cell.y,cell.z]},
    block:cell.z===119&&cell.x>64&&cell.x<71?147:149}}));
  assert.ok(plan.changed>0);
  const proposal=await client.tool('authoringPropose',{steps,expectedRevision:before.revision});
  const after=await client.tool('terrainRead',{region,limit:36864});
  assert.deepEqual(after.cells,before.cells);
  const proof={project,proposalId:proposal.proposalId,run:randomUUID(),stage:'prepared-source-unchanged',
    beforeRevision:before.revision,region,materials:materials.map(result=>result.block),targets:targets.map(cell=>({...cell,after:cell.z===119&&cell.x>64&&cell.x<71?147:149})),
    artisticIntent:'原有平地上补一段浅灰石砖中心、深灰收边的短步道，保持原建筑、地形高度和其他区域',
    limitations:'Not yet applied, saved, visually reviewed or play-tested; this case is separate from compiler preflight.'};
  await fs.writeFile(file,JSON.stringify(proof,null,2),{flag:'wx'});
  console.log(JSON.stringify({stage:proof.stage,proposalId:proof.proposalId,targetCells:targets.length,region}));
} else {
  const proof=JSON.parse(await fs.readFile(file));
  assert.equal(proof.project,project);
  if(action==='apply') {
    assert.equal(proof.stage,'prepared-source-unchanged');
    const current=await client.tool('terrainRead',{region,limit:36864});
    assert.equal(current.revision,proof.beforeRevision);
    // A durable in-progress marker prevents ambiguous writes being replayed.
    proof.stage='apply-in-progress-inspect-before-retry';
    await fs.writeFile(file,JSON.stringify(proof,null,2));
    await client.tool('authoringApply',{proposalId:proof.proposalId},`${proof.run}-apply`);
    const after=await client.tool('terrainRead',{region,limit:36864});
    const changes=new Map(proof.targets.map(cell=>[`${cell.x},${cell.y},${cell.z}`,cell]));
    for(let i=0;i<current.cells.length;i++) {
      const cell=current.cells[i], target=changes.get(`${cell.x},${cell.y},${cell.z}`);
      assert.equal(after.cells[i].b,target?.after??cell.b);
    }
    await client.save();
    proof.afterRevision=after.revision; proof.stage='applied-readback-matches-saved';
  } else if(action==='revert') {
    assert.equal(proof.stage,'applied-readback-matches-saved');
    proof.stage='revert-in-progress-inspect-before-retry';
    await fs.writeFile(file,JSON.stringify(proof,null,2));
    await client.tool('authoringRevert',{proposalId:proof.proposalId},`${proof.run}-revert`);
    const restored=await client.tool('terrainInfo');
    assert.equal(restored.revision,proof.beforeRevision);
    await client.save(); proof.stage='original-global-terrain-revision-restored-saved';
  } else throw new Error('Supported stages: prepare, apply, revert');
  await fs.writeFile(file,JSON.stringify(proof,null,2)); console.log(proof.stage);
}

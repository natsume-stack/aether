import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { summarizeAgentModelSource } from '../server/agent-model-context';
async function main() {
  const corpus = path.resolve(__dirname,'../../../../_corpus/model-continuation');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(corpus,'夜翼蝙蝠-局部材质续作.voxaproject')));
  const bytes = await zip.file('project.bin')!.async('uint8array');
  const all = summarizeAgentModelSource(bytes);
  assert.equal(all.totalParts,16);
  assert.equal(all.animations.length,3);
  assert.deepEqual(all.structuralIssues,[]);
  assert.deepEqual(all.palette.find(item=>item.id===24),{id:24,rgb:[255,213,119],emissive:89});
  const pages = [summarizeAgentModelSource(bytes,0,7),summarizeAgentModelSource(bytes,7,7),summarizeAgentModelSource(bytes,14,7)];
  assert.deepEqual(pages.flatMap(page=>page.parts),all.parts);
  assert.equal(pages[2].nextOffset,null);
  assert.ok(!JSON.stringify(all).includes('encodedView'));
  assert.throws(()=>summarizeAgentModelSource(bytes,-1),/INVALID_CONTEXT_PAGE/);
  assert.throws(()=>summarizeAgentModelSource(new Uint8Array(8*1024*1024+1)),/SCOPE_TOO_LARGE/);
  const legacy = await JSZip.loadAsync(fs.readFileSync(path.resolve(__dirname,'../../../../runs/bat/夜翼蝙蝠.voxaproject')));
  const invalid = summarizeAgentModelSource(await legacy.file('project.bin')!.async('uint8array'));
  assert.ok(invalid.structuralIssues.includes('voxel-resource-id-mismatch:eyes'));
  console.log('Persisted model context: native saved source, pagination, bounded payload and legacy defects passed');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});

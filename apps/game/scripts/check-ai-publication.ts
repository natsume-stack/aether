import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {publishAiProject,revertAiPublication,listAiPublications} from '../server/ai-project-publication';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'box-ai-publication-'));
const ids=['main-map','child-map'];
for(const id of ids){fs.mkdirSync(path.join(root,id,'releases'),{recursive:true});fs.writeFileSync(path.join(root,id,'project.json'),JSON.stringify({id,releases:[],name:id}));}
const manager={projectsRoot:root,listMapGroup:(_id:string)=>ids.map(id=>({id})),publishMapGroup:(_id:string,version?:string)=>{
  for(const id of ids){const file=path.join(root,id,'project.json');const value=JSON.parse(fs.readFileSync(file,'utf8'));value.releases.push({version});fs.mkdirSync(path.join(root,id,'releases',version!));fs.writeFileSync(file,JSON.stringify(value));}return {version};
}};
try {
  const before=ids.map(id=>fs.readFileSync(path.join(root,id,'project.json'),'utf8'));
  const published=publishAiProject(manager,'main-map','1','engineering fixture');
  assert.equal(listAiPublications(manager,'main-map','2').length,0);
  assert.throws(()=>revertAiPublication(manager,'main-map','2',published.operationId));
  revertAiPublication(manager,'main-map','1',published.operationId);
  ids.forEach((id,i)=>{assert.equal(fs.readFileSync(path.join(root,id,'project.json'),'utf8'),before[i]);assert.equal(fs.existsSync(path.join(root,id,'releases',published.version)),false);});
  assert.throws(()=>revertAiPublication(manager,'main-map','1',published.operationId));
  const second=publishAiProject(manager,'main-map','1','');fs.appendFileSync(path.join(root,'child-map','project.json'),' ');
  assert.throws(()=>revertAiPublication(manager,'main-map','1',second.operationId),/changed/);
  assert.equal(fs.existsSync(path.join(root,'main-map','releases',second.version)),true);
  assert.throws(()=>publishAiProject(manager,'../outside','1',''));
  const lock=path.join(root,'.ai-publication','operation.lock');fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));assert.throws(()=>publishAiProject(manager,'main-map','1',''),/Another/);fs.unlinkSync(lock);
  console.log(JSON.stringify({ok:true,checks:['map-group-release','publication-rollback','owner-isolation','no-replay','metadata-CAS','path-validation','exclusive-lock']}));
} finally {fs.rmSync(root,{recursive:true,force:true});}

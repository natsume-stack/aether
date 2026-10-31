import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
type Manager={projectsRoot:string;listMapGroup(id:string):Array<{id:string}>;publishMapGroup(id:string,version?:string,notes?:string):unknown};
type Member={id:string;before:string;afterHash:string};
type Operation={id:string;userId:string;projectId:string;version:string;status:'prepared'|'published'|'reverted'|'unknown';createdAt:string;members:Member[]};
function validProject(id:string) {if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('Invalid project ID');}
function digest(value:string) {return createHash('sha256').update(value).digest('hex');}
function paths(manager:Manager) {const root=path.resolve(manager.projectsRoot,'.ai-publication');fs.mkdirSync(root,{recursive:true,mode:0o700});return root;}
function write(file:string,value:unknown) {const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
function withLock<T>(manager:Manager,action:()=>T):T {
  const lock=path.join(paths(manager),'operation.lock');
  const acquire=()=>{const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);};
  try {acquire();} catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
    let stale=false;
    try {const owner=JSON.parse(fs.readFileSync(lock,'utf8'));try {process.kill(owner.pid,0);} catch(e) {stale=(e as NodeJS.ErrnoException).code==='ESRCH';}} catch {throw new Error('Publication lock requires inspection');}
    if(!stale) throw new Error('Another publication is running');
    fs.unlinkSync(lock);acquire();
  }
  try{return action();} finally {fs.unlinkSync(lock);}
}
function recordPath(manager:Manager,id:string) {if(!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid publication operation');return path.join(paths(manager),`${id}.json`);}
export function publishAiProject(manager:Manager,projectId:string,userId:string,notes:string) {
  validProject(projectId);if(typeof notes!=='string' || notes.length>2000) throw new Error('Invalid publication notes');
  return withLock(manager,()=>{
    const members=manager.listMapGroup(projectId);if(!members.length || members.length>8) throw new Error('AI publication supports at most 8 maps');
    const id=randomUUID();const version=`ai-${Date.now()}-${id.slice(0,8)}`;
    const operation:Operation={id,userId,projectId,version,status:'prepared',createdAt:new Date().toISOString(),members:members.map(member=>{validProject(member.id);return {id:member.id,before:fs.readFileSync(path.join(manager.projectsRoot,member.id,'project.json'),'utf8'),afterHash:''};})};
    const file=recordPath(manager,id);write(file,operation);
    try {
      const release=manager.publishMapGroup(projectId,version,notes);
      operation.members.forEach(member=>member.afterHash=digest(fs.readFileSync(path.join(manager.projectsRoot,member.id,'project.json'),'utf8')));
      operation.status='published';write(file,operation);
      return {success:true,operationId:id,version,release};
    } catch(error) {operation.status='unknown';write(file,operation);throw error;}
  });
}
export function revertAiPublication(manager:Manager,projectId:string,userId:string,id:string) {
  validProject(projectId);
  return withLock(manager,()=>{
    const file=recordPath(manager,id);const operation=JSON.parse(fs.readFileSync(file,'utf8')) as Operation;
    if(operation.userId!==userId || operation.projectId!==projectId || operation.status!=='published') throw new Error('Publication cannot be reverted');
    for(const member of operation.members) {
      validProject(member.id);
      if(digest(fs.readFileSync(path.join(manager.projectsRoot,member.id,'project.json'),'utf8'))!==member.afterHash) throw new Error('Project metadata changed after publication; automatic rollback refused');
    }
    // Unpublish only the release created by this operation; preserve all source edits.
    for(const member of operation.members) {
      const root=path.join(manager.projectsRoot,member.id);
      const target=path.resolve(root,'releases',operation.version);
      if(path.dirname(target)!==path.resolve(root,'releases') || !/^ai-[0-9]+-[0-9a-f]{8}$/.test(operation.version)) throw new Error('Invalid publication record');
      fs.writeFileSync(path.join(root,'project.json'),member.before);
      fs.rmSync(target,{recursive:true,force:true});
    }
    operation.status='reverted';write(file,operation);return {success:true,operationId:id};
  });
}
export function listAiPublications(manager:Manager,projectId:string,userId:string) {
  validProject(projectId);
  return fs.readdirSync(paths(manager)).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(paths(manager),name),'utf8')) as Operation).filter(row=>row.projectId===projectId && row.userId===userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30).map(({id,version,status,createdAt})=>({id,version,status,createdAt}));
}

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=fs.mkdtempSync(path.join(root,'.api-build-'));
function run(file,args,env=process.env) {
  const result=spawnSync(process.execPath,[path.join(root,file),...args],{cwd:root,env,stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`API build failed (${result.status})`);
}
function publish(directory,relative='') {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const name=path.join(relative,entry.name);
    const source=path.join(directory,entry.name);
    const target=path.join(root,'dist',name);
    if(entry.isDirectory()) {publish(source,name);continue;}
    fs.mkdirSync(path.dirname(target),{recursive:true});
    // Each entry is a complete file before replacement. Running dev servers
    // never observe an absent package or a partly written JavaScript bundle.
    fs.renameSync(source,target);
  }
}
try {
  run('node_modules/typescript/bin/tsc',['--emitDeclarationOnly','--declarationDir',stage]);
  run('node_modules/rollup/dist/bin/rollup',['--config','rollup.config.mjs'],{...process.env,BOX_API_BUILD_DIR:stage});
  publish(stage);
} finally {fs.rmSync(stage,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {getPool} from '../server/local-player-identity';
import {initializeAiProviderStore,createAiProvider,createAdminAiProvider,getAiProviderSecret,resolveAiProvider,listAiProviders,updateAiProvider,deleteAiProvider,writeAiPreference,deleteAdminAiProvider,assertSafeProviderUrl} from '../server/ai-provider-store';

async function main(){
  const url=new URL(process.env.BOX_DATABASE_URL || '');
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'15432','This engineering check only runs against the documented dev database');
  process.env.AI_PROVIDER_ALLOW_PRIVATE='false';
  await initializeAiProviderStore();
  const db=getPool()!;
  const principals:string[]=[];const users:number[]=[];const providers:string[]=[];let admin='';
  try{
    for(let i=0;i<2;i++){
      const id=randomUUID();principals.push(id);
      await db.query("INSERT INTO box_identity.principals(id,kind) VALUES($1,'user')",[id]);
      const result=await db.query("INSERT INTO box_identity.users(principal_id,username,display_name,password_salt,password_hash) VALUES($1,$2,$2,'engineering','not-a-login-hash') RETURNING id",[id,`ai_check_${id}`]);users.push(Number(result.rows[0].id));
    }
    const own=await createAiProvider(users[0],{name:`isolation-${randomUUID()}`,baseUrl:'https://example.com/v1',apiKey:'engineering-only-key',defaultModel:'check'});providers.push(own.id);
    const denied=(error:any)=>error.code==='AI_PROVIDER_NOT_FOUND';
    await assert.rejects(getAiProviderSecret(users[1],own.id),denied);
    await assert.rejects(resolveAiProvider(users[1],own.id),denied);
    await assert.rejects(updateAiProvider(users[1],own.id,{name:'wrong-owner'}),denied);
    assert.equal(await deleteAiProvider(users[1],own.id),false);
    await assert.rejects(writeAiPreference(users[1],{providerId:own.id}),denied);
    assert.equal((await listAiProviders(users[1])).some(p=>p.id===own.id),false);
    const created=await createAdminAiProvider({name:`private-admin-${randomUUID()}`,baseUrl:'https://example.com/v1',apiKey:'engineering-admin-key',defaultModel:'check'});admin=created.id;
    // Explicitly keep this fixture private without changing an existing default.
    await db.query('UPDATE box_identity.ai_providers SET is_default=false WHERE id=$1',[admin]);
    await assert.rejects(getAiProviderSecret(users[1],admin),denied);
    await assert.rejects(resolveAiProvider(users[1]),(error:any)=>error.code==='AI_PROVIDER_NOT_CONFIGURED');
    await assert.rejects(assertSafeProviderUrl('https://[::ffff:7f00:1]/v1'),/private|私有|本地/i);
    console.log(JSON.stringify({ok:true,checks:['cross-user-read','cross-user-resolve','cross-user-update','cross-user-delete','cross-user-preference','private-admin-fallback','mapped-ipv6']}));
  }finally{
    for(const id of providers) await deleteAiProvider(users[0],id).catch(()=>undefined);
    if(admin) await deleteAdminAiProvider(admin).catch(()=>undefined);
    for(const id of principals) await db.query('DELETE FROM box_identity.principals WHERE id=$1',[id]);
    await db.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

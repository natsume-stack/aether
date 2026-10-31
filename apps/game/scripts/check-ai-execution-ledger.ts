import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getPool} from '../server/local-player-identity';
import {initializeAiProviderStore} from '../server/ai-provider-store';
import {beginAiExecution,recordAiExecution,listAiExecutionRuns} from '../server/ai-execution-ledger';
async function main(){
  const url=new URL(process.env.BOX_DATABASE_URL || '');
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'15432');
  await initializeAiProviderStore();const db=getPool()!;
  const principal=randomUUID();let uid=0;
  try {
    await db.query("INSERT INTO box_identity.principals(id,kind) VALUES($1,'user')",[principal]);
    uid=Number((await db.query("INSERT INTO box_identity.users(principal_id,username,display_name,password_salt,password_hash) VALUES($1,$2,$2,'engineering','not-a-login-hash') RETURNING id",[principal,`ai_ledger_${principal}`])).rows[0].id);
    const results=await Promise.allSettled(Array.from({length:4},()=>beginAiExecution(uid,'ledger-check','autonomous')));
    const allowed=results.flatMap(v=>v.status==='fulfilled'?[v.value]:[]);
    assert.equal(allowed.length,3,'Distributed concurrent lease limit');
    const runId=allowed[0].runId;
    await assert.rejects(recordAiExecution(uid+100000,runId,{phase:'after'}));
    await recordAiExecution(uid,runId,{phase:'after',action:'check',snapshot:'hash',apiKey:'never-store-this'});
    const stored=(await listAiExecutionRuns()).find(v=>v.id===runId)!;
    assert.equal(JSON.stringify(stored.events).includes('never-store-this'),false);
    await db.query('UPDATE box_identity.ai_execution_policy SET blocked_users=blocked_users || $1::jsonb WHERE id=1',[JSON.stringify([String(uid)])]);
    await assert.rejects(recordAiExecution(uid,runId,{phase:'before'}),(e:any)=>e.code==='AI_EXECUTION_DISABLED');
    await db.query('UPDATE box_identity.ai_execution_policy SET blocked_users=blocked_users - $1 WHERE id=1',[String(uid)]);
    await recordAiExecution(uid,runId,{phase:'complete',inputTokens:13,outputTokens:7});
    assert.equal((await listAiExecutionRuns()).find(v=>v.id===runId)?.inputTokens,13);
    await assert.rejects(recordAiExecution(uid,runId,{phase:'after'}));
    const expired=allowed[1].runId;
    await db.query("UPDATE box_identity.ai_execution_runs SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[expired]);
    await assert.rejects(recordAiExecution(uid,expired,{phase:'after'}));
    assert.equal((await listAiExecutionRuns()).find(v=>v.id===expired)?.status,'interrupted');
    console.log(JSON.stringify({ok:true,checks:['distributed-concurrency','owner-isolation','secret-redaction','kill-switch','terminal-no-replay','lease-expiry']}));
  } finally {
    if(uid) await db.query('UPDATE box_identity.ai_execution_policy SET blocked_users=blocked_users - $1 WHERE id=1',[String(uid)]);
    await db.query('DELETE FROM box_identity.principals WHERE id=$1',[principal]);await db.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

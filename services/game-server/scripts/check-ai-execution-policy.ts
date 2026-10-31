import assert from 'node:assert/strict';
import { executionTools } from '../src/edit/ai/execution-policy';

async function main() {
  let writes=0,saves=0,authorizations=0;
  const source:any={terrainRead:{execute:async()=>({success:true})},terrainApply:{execute:async()=>{writes++;return {success:true};}},authoringPropose:{execute:async()=>({success:true,proposalId:'p'})},authoringApply:{execute:async()=>{writes++;return {success:true};}}};
  const policy:any={mode:'review',signal:new AbortController().signal,maxCalls:10,authorizeWrite:async()=>{authorizations++;},save:async()=>`snapshot-${++saves}`,audit:()=>undefined};
  const review=executionTools(source,policy);
  assert.ok(review.terrainRead);assert.ok(review.authoringPropose);assert.equal(review.authoringApply,undefined);assert.equal(review.terrainApply,undefined);
  const auto=executionTools(source,{...policy,mode:'autonomous'});
  assert.equal(auto.terrainApply,undefined,'raw writes bypassing rollback must not be exposed');
  const result:any=await auto.authoringApply.execute!({proposalId:'p'} as never,{toolCallId:'test',messages:[]});
  assert.equal(result.persisted,true);assert.equal(writes,1);assert.equal(saves,2);assert.equal(authorizations,1);
  const blocked=executionTools(source,{...policy,mode:'autonomous',authorizeWrite:async()=>{throw new Error('disabled');}});
  await assert.rejects(()=>blocked.authoringApply.execute!({} as never,{toolCallId:'blocked',messages:[]}) as Promise<any>,/disabled/);
  assert.equal(writes,1);
  const abort=new AbortController();abort.abort();
  const cancelled=executionTools(source,{...policy,mode:'autonomous',signal:abort.signal});
  await assert.rejects(()=>cancelled.authoringApply.execute!({} as never,{toolCallId:'cancelled',messages:[]}) as Promise<any>,/cancelled/);
  let fail=true;
  const uncertain=executionTools(source,{...policy,mode:'autonomous',save:async()=>{if(fail){fail=false;return 'before';}throw new Error('disk full');}});
  await assert.rejects(()=>uncertain.authoringApply.execute!({} as never,{toolCallId:'fail',messages:[]}) as Promise<any>,/save failed/);
  await assert.rejects(()=>uncertain.authoringApply.execute!({} as never,{toolCallId:'retry',messages:[]}) as Promise<any>,/previous failed write/);
  assert.equal(writes,2,'ambiguous writes must not be replayed');
  console.log(JSON.stringify({ok:true,checks:['review-isolation','autonomous-snapshots','kill-switch','cancellation','save-failure-no-replay']}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

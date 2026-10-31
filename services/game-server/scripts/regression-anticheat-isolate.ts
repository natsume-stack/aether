import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import ivm from 'isolated-vm';

async function main() {
  const esbuild = require('../../../apps/player-auth-portal/node_modules/esbuild');
  const bundle = esbuild.buildSync({ entryPoints: [path.resolve(__dirname, '../src/anticheat/anticheat-script.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'AnticheatFixture', platform: 'browser' }).outputFiles[0].text;
  const isolate = new ivm.Isolate({ memoryLimit: 64 });
  let context: ivm.Context | undefined;
  try {
    context = await isolate.createContext();
    await context.eval(bundle);
    const result = await context.eval(`
      'use strict';
      let handlers; const replies=[], masks=[], errors=[]; let initialized=0; let scriptTick=1; const alice={name:'Alice'};
      const api = new AnticheatFixture.AnticheatScript({protocol:()=>({
        configure:value=>handlers=value.message,
        server:{message:{listen:()=>{},listenMessages:mask=>masks.push(mask),initialized:()=>initialized++,
          decision:reply=>replies.push(reply),messageDecision:reply=>replies.push(reply)}}
      })}, id=>id===1?alice:undefined, error=>errors.push(error.message),
        id=>id===1?{position:{x:1,y:2,z:3}}:undefined,()=>scriptTick);
      const world={anticheat:api};
      api.initialize();
      const input=world.anticheat.onInput(({buttons,context})=>{if(buttons.fly)context.reject()});
      const custom=world.anticheat.onCustomEvent(({data})=>{data.nested.value=999});
      api.finishInitialization();
      const emit=(message,data)=>handlers.clientMessage({handle:replies.length,playerId:1,
        payload:JSON.stringify({protocol:'game-net',message,data,unreliable:false,serverTick:1,mode:'play'})});
      emit('input',{tick:1,input:{inputState:128}});
      emit('input',{tick:2,input:{inputState:0}});
      handlers.clientMessage({handle:2,playerId:1,payload:JSON.stringify({protocol:'remote-channel',message:'sendServerEvent',
        data:{tick:2,args:JSON.stringify({nested:{value:1}})},unreliable:false,serverTick:2,mode:'play'})});
      input.cancel(); custom.cancel();
      const action=world.anticheat.onAction(({actions,serverPosition,context})=>{
        if(serverPosition.x!==1) throw new Error('wrong actor position');
        if(actions.length>1) context.reject();
        else actions[0].ray.origin.x=999;
      });
      const click={tick:2,buttonState:1,prevButtonState:0,position:[0,0,0],
        rayOrigin:[0,0,0],rayDirection:[1,0,0],rayHitNormal:[0,1,0],
        rayTime:0,rayHitEntity:2,rayHitVoxelX:0,rayHitVoxelY:0,rayHitVoxelZ:0};
      emit('input',{events:[click,click]});
      emit('input',{events:[click]});
      action.cancel();
      JSON.stringify({allow:replies.map(reply=>reply.allow),masks,errors:errors.length,initialized,active:input.active()});
    `);
    assert.deepEqual(JSON.parse(result as string), { allow: [false, true, false, false, false], masks: [0, 2, 18, 16, 0, 64, 0], errors: 2, initialized: 1, active: false });
    const helperResult = await context.eval(`'use strict'; {
      const owner={};
      const tracker=world.anticheat.createTracker({historySize:2,decayPerTick:1});
      tracker.record(owner,{candidateTick:99999,to:{x:3}});
      tracker.addScore(owner,5);
      tracker.exempt(owner,{ticks:3,reason:'server skill'});
      let immutable=false;
      try{tracker.getHistory(owner)[0].data.to.x=123;}catch(error){immutable=true;}
      const initiallyExempt=tracker.isExempt(owner);
      scriptTick=4;
      const score=tracker.getScore(owner);
      const expired=!tracker.isExempt(owner);
      const historyTick=tracker.getHistory(owner)[0].serverTick;
      api.initialize();
      JSON.stringify({immutable,initiallyExempt,expired,score,historyTick,
        reset:tracker.getHistory(owner).length===0&&tracker.getScore(owner)===0});
    }`);
    assert.deepEqual(JSON.parse(helperResult as string), {
      immutable: true, initiallyExempt: true, expired: true, score: 2, historyTick: 1, reset: true,
    });
    await context.eval(fs.readFileSync(path.resolve(__dirname, './fixtures/anticheat/script-anticheat.js'), 'utf8'));
    const templateResult = await context.eval(`{
      handlers.movement({handle:50,playerId:1,payload:JSON.stringify({playerId:1,
        from:{x:0,y:0,z:0},to:{x:1000,y:0,z:0},elapsedMs:16,
        velocity:{from:{x:0,y:0,z:0},to:{x:100,y:0,z:0}},inputTick:999,serverTick:4,mode:'play'})});
      emit('input',{events:[click,click]});
      const movementAllowed=replies[replies.length-2].allow;
      const actionAllowed=replies[replies.length-1].allow;
      const samples=movementRule.tracker.getHistory(alice).length+actionRule.tracker.getHistory(alice).length;
      const score=movementRule.tracker.getScore(alice)+actionRule.tracker.getScore(alice);
      JSON.stringify({movementAllowed,actionAllowed,samples,score});
    }`);
    assert.deepEqual(JSON.parse(templateResult as string), { movementAllowed: true, actionAllowed: true, samples: 2, score: 0 });
    await context.eval('api.initialize();');
    await context.eval(fs.readFileSync(path.resolve(__dirname, './fixtures/anticheat/anticheat-observe.js'), 'utf8'));
    const observerResult = await context.eval(`{
      handlers.movement({handle:60,playerId:1,payload:JSON.stringify({playerId:1,
        from:{x:0,y:0,z:0},to:{x:1000,y:0,z:0},elapsedMs:16,
        velocity:{from:{x:0,y:0,z:0},to:{x:100,y:0,z:0}},inputTick:999,serverTick:4,mode:'play'})});
      emit('input',{events:[click,click]});
      JSON.stringify({movementAllowed:replies[replies.length-2].allow,
        actionAllowed:replies[replies.length-1].allow,mask:masks[masks.length-1]});
    }`);
    assert.deepEqual(JSON.parse(observerResult as string), { movementAllowed: true, actionAllowed: true, mask: 64 });
    // Exercise the configurable policy in the real script isolation runtime.
    await context.eval(`
      api.initialize();scriptTick=10;
      const joins=[],leaves=[];let reportCallback,remoteReply;
      const demoEntity={id:'alice',player:alice,position:{x:1,y:2,z:3}};
      world.onPlayerJoin=fn=>{joins.push(fn);return {cancel(){}}};
      world.onPlayerLeave=fn=>{leaves.push(fn);return {cancel(){}}};
      world.onPress=()=>({cancel(){}});
      world.raycast=()=>({hit:false,distance:-1});
      class GameVector3 {constructor(x,y,z){this.x=x;this.y=y;this.z=z}}
      const remoteChannel={onServerEvent:fn=>reportCallback=fn,
        sendClientEvent:(entity,value)=>remoteReply=value};
    `);
    await context.eval('(() => {' + fs.readFileSync(path.resolve(__dirname, './fixtures/anticheat/anticheat-policy.js'), 'utf8') + fs.readFileSync(path.resolve(__dirname, './fixtures/anticheat-policy-isolate.js'), 'utf8') + '})();');
    const demoResult = await context.eval(`{
      for(const join of joins)join({entity:demoEntity});
      scriptTick=60;
      handlers.movement({handle:70,playerId:1,payload:JSON.stringify({playerId:1,
        from:{x:1,y:2,z:3},to:{x:1,y:2,z:3},elapsedMs:16,
        velocity:{from:{x:0,y:0,z:0},to:{x:0,y:0.5,z:0}},inputTick:999,serverTick:60,mode:'play'})});
      const movementAllowed=replies.at(-1).allow;
      const normal={...click,position:[1,2,3],rayOrigin:[1,2,3],rayTime:-1,rayHitEntity:0};
      emit('input',{input:{bodies:[]},events:[normal]});
      const firstAllowed=replies.at(-1).allow;
      emit('input',{input:{bodies:[]},events:[normal]});
      const secondAllowed=replies.at(-1).allow;
      reportCallback({entity:demoEntity,args:{kind:'ac-manual-report',nonce:'probe'}});
      JSON.stringify({movementAllowed,firstAllowed,secondAllowed,fixture:remoteReply.fixture,
        ready:remoteReply.ready,score:remoteReply.score,movementRejected:remoteReply.stats.movementRejected,
        actionRejected:remoteReply.stats.actionRejected});
    }`);
    assert.deepEqual(JSON.parse(demoResult as string), {
      movementAllowed: false, firstAllowed: true, secondAllowed: false, fixture: 'box-ac-policy-v1',
      ready: true, score: 2, movementRejected: 1, actionRejected: 1,
    });
    console.log('Hardened standalone demo passed in isolated-vm: velocity rejection, cross-packet cooldown and read-only report');
    console.log('Anticheat isolate passed: real API, category subscriptions, read-only payloads, rejection and initialization');
  } finally { context?.release(); isolate.dispose(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });

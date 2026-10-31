import {getPool} from './local-player-identity';
import {AiProviderError, isAiExecutionUserActive, aiProviderTable, ensureAiProviderStore, readAiExecutionPolicy} from './ai-provider-store';
import {randomUUID} from 'node:crypto';

const runs=aiProviderTable('ai_execution_runs');
const users=aiProviderTable('users');
let ready:Promise<void>|undefined;
function db() {const pool=getPool();if(!pool) throw new AiProviderError('DATABASE_UNAVAILABLE','AI execution database unavailable',503);return pool;}
async function init() {
  await ensureAiProviderStore();
  if(!ready) ready=(async()=>{
    await db().query(`CREATE TABLE IF NOT EXISTS ${runs} (
      id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES ${users}(id) ON DELETE CASCADE,
      scope text NOT NULL,mode text NOT NULL,status text NOT NULL DEFAULT 'running',
      started_at timestamptz NOT NULL DEFAULT NOW(),expires_at timestamptz NOT NULL DEFAULT NOW()+INTERVAL '4 minutes',
      finished_at timestamptz,event_count integer NOT NULL DEFAULT 0,
      events jsonb NOT NULL DEFAULT '[]'::jsonb
    )`);
    await db().query(`CREATE INDEX IF NOT EXISTS ai_execution_runs_user_time ON ${runs}(user_id,started_at DESC)`);
    await db().query(`ALTER TABLE ${runs} ADD COLUMN IF NOT EXISTS provider_id uuid,ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '',ADD COLUMN IF NOT EXISTS input_tokens integer NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0`);
  })().catch(error=>{ready=undefined;throw error;});
  return ready;
}
function user(value:unknown) {if(!/^[1-9][0-9]{0,9}$/.test(String(value))) throw new AiProviderError('INVALID_USER','Invalid user');return Number(value);}
export async function beginAiExecution(value:unknown,scope:unknown,mode:unknown,metadata:Record<string,unknown>={}) {
  await init();const uid=user(value);
  if(!await isAiExecutionUserActive(uid)) throw new AiProviderError('AI_EXECUTION_DISABLED','AI user is not active',403);
  if(typeof scope!=='string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(scope) || !['review','autonomous'].includes(String(mode))) throw new AiProviderError('INVALID_EXECUTION','Invalid execution scope');
  const providerId=typeof metadata.providerId==='string' && /^[0-9a-f-]{36}$/.test(metadata.providerId)?metadata.providerId:null;
  const model=String(metadata.model || '').slice(0,200);
  const client=await db().connect();
  try {
    await client.query(`BEGIN`);
    await client.query(`SELECT pg_advisory_xact_lock($1,$2)`,[109532,uid]);
    await client.query(`DELETE FROM ${runs} WHERE user_id=$1 AND started_at<NOW()-INTERVAL '30 days'`,[uid]);
    const counts=await client.query(`SELECT count(*) FILTER (WHERE started_at>NOW()-INTERVAL '1 minute')::int AS minute,
      count(*) FILTER (WHERE status='running' AND expires_at>NOW())::int AS active,
      count(*)::int AS daily,COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS tokens FROM ${runs} WHERE user_id=$1 AND started_at>NOW()-INTERVAL '24 hours'`,[uid]);
    const count=counts.rows[0];
    if(count.minute>=10 || count.active>=3 || count.daily>=200 || Number(count.tokens)>=1000000) throw new AiProviderError('AI_QUOTA_EXCEEDED','AI request quota exceeded; try again later',429);
    const id=randomUUID();
    await client.query(`INSERT INTO ${runs}(id,user_id,scope,mode,provider_id,model) VALUES($1,$2,$3,$4,$5,$6)`,[id,uid,scope,mode,providerId,model]);
    await client.query(`COMMIT`);return {runId:id};
  } catch(error) {await client.query(`ROLLBACK`);throw error;} finally {client.release();}
}
export async function recordAiExecution(value:unknown,runId:unknown,event:unknown) {
  await init();const uid=user(value);
  if(typeof runId!=='string' || !/^[0-9a-f-]{36}$/.test(runId) || !event || typeof event!=='object') throw new AiProviderError('INVALID_EXECUTION','Invalid execution event');
  const input=event as Record<string,unknown>;
  const phase=String(input.phase || '');
  if(!['before','after','unknown','complete','failed','cancelled'].includes(phase)) throw new AiProviderError('INVALID_EXECUTION','Invalid execution phase');
  const clean={phase,action:String(input.action || '').slice(0,80),snapshot:String(input.snapshot || '').slice(0,256),success:input.success===true,at:new Date().toISOString()};
  if(phase==='before') {
    const run=await db().query(`SELECT scope FROM ${runs} WHERE id=$1 AND user_id=$2`,[runId,uid]);
    const policy=await readAiExecutionPolicy();
    if(!await isAiExecutionUserActive(uid) || !run.rows[0] || !policy.enabled || policy.blockedUsers.includes(String(uid)) || policy.blockedMaps.includes(run.rows[0].scope)) throw new AiProviderError('AI_EXECUTION_DISABLED','AI execution disabled by administrator',403);
  }
  const terminal=['complete','failed','cancelled'].includes(phase);
  const usage=(value:unknown)=>Number.isSafeInteger(value) && Number(value)>=0 && Number(value)<=100000000?Number(value):0;
  const result=await db().query(`UPDATE ${runs} SET events=events || $3::jsonb,event_count=event_count+1,
    status=CASE WHEN $4 THEN $5 ELSE status END,finished_at=CASE WHEN $4 THEN NOW() ELSE finished_at END,
    input_tokens=CASE WHEN $4 THEN $6 ELSE input_tokens END,output_tokens=CASE WHEN $4 THEN $7 ELSE output_tokens END
    WHERE id=$1 AND user_id=$2 AND status='running' AND expires_at>NOW() AND event_count<256 RETURNING id`,[runId,uid,JSON.stringify([clean]),terminal,phase,usage(input.inputTokens),usage(input.outputTokens)]);
  if(!result.rows.length) throw new AiProviderError('AI_EXECUTION_EXPIRED','AI execution expired or event budget exceeded',409);
  return {success:true};
}
export async function listAiExecutionRuns() {
  await init();
  const result=await db().query(`SELECT id,user_id AS "userId",scope,mode,
    CASE WHEN status='running' AND expires_at<=NOW() THEN 'interrupted' ELSE status END AS status,
    started_at AS "startedAt",finished_at AS "finishedAt",provider_id AS "providerId",model,input_tokens AS "inputTokens",output_tokens AS "outputTokens",EXTRACT(EPOCH FROM (COALESCE(finished_at,LEAST(NOW(),expires_at))-started_at))*1000 AS "durationMs",events FROM ${runs} ORDER BY started_at DESC LIMIT 100`);
  return result.rows;
}

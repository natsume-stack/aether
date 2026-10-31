import {getPool} from '../server/local-player-identity';
import {initializeAiProviderStore,aiProviderTable} from '../server/ai-provider-store';
import {aiProviderKeyVersion,encryptAiProviderKey,decryptAiProviderKey} from '../server/ai-provider-secrets';
/** Dry run is the default. Supply --apply only after installing the new active key and the previous-version keyring. */
async function main(){
  await initializeAiProviderStore();const db=getPool()!;const target=aiProviderKeyVersion();const apply=process.argv.includes('--apply');
  const client=await db.connect();let count=0;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('box.ai.key-rotation'))");
    const rows=await client.query(`SELECT id,key_version,api_key_cipher,api_key_iv,api_key_tag FROM ${aiProviderTable('ai_providers')} WHERE key_version<>$1 FOR UPDATE`,[target]);
    for(const row of rows.rows) {
      const encrypted=encryptAiProviderKey(decryptAiProviderKey({key_version:row.key_version,ciphertext:row.api_key_cipher,iv:row.api_key_iv,tag:row.api_key_tag}));
      if(apply) await client.query(`UPDATE ${aiProviderTable('ai_providers')} SET api_key_cipher=$2,api_key_iv=$3,api_key_tag=$4,key_version=$5,updated_at=NOW() WHERE id=$1`,[row.id,encrypted.ciphertext,encrypted.iv,encrypted.tag,encrypted.version]);
      count++;
    }
    await client.query(apply?'COMMIT':'ROLLBACK');console.log(JSON.stringify({ok:true,applied:apply,targetVersion:target,providers:count}));
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();await db.end();}
}
main().catch(()=>{console.error('AI provider key rotation failed; transaction rolled back. Verify keyring configuration.');process.exitCode=1;});

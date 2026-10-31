import type { PoolClient } from 'pg'
import type { AdminActionContext } from './local-player-identity'

/** One audit envelope for owner authorization changes and trusted script calls. */
export async function writeScriptModerationAudit(
  client: PoolClient,
  table: (name: string) => string,
  action: string,
  target: string,
  actor: string,
  details: Record<string, unknown>,
  context?: AdminActionContext,
) {
  await client.query(
    `INSERT INTO ${table('admin_audit_events')}(actor_id,action,target_id,details,ip_address)
     VALUES($1,$2,$3,$4::jsonb,$5)`,
    [actor, action, target, JSON.stringify({
      outcome: 'success',
      ...details,
      actorDisplayName: context?.actorDisplayName || actor,
      actorUserAgent: context?.userAgent || '',
      actorRole: details.source === 'map-script' ? 'map-script' : context?.actorRole,
    }), context?.ip || ''],
  )
}

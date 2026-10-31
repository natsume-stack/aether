import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { listPlayerRevocations } from './local-player-identity';
import { scriptModerationStore } from './script-moderation-store';

type Listener = (table: string) => void;
class PlayerChangeFeed {
  private listeners = new Set<Listener>();
  private client?: Client;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private failures = 0;
  async start() {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async connect() {
    // Initialize the existing stores before installing commit-aware triggers.
    await listPlayerRevocations(0, new Date());
    const { pool, table } = await scriptModerationStore.ready();
    const schema = process.env.BOX_IDENTITY_DATABASE_SCHEMA || 'box_identity';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('身份数据库 schema 无效');
    const channel = 'box_changes_' + createHash('sha256').update(schema).digest('hex').slice(0, 20);
    await pool.query(`CREATE OR REPLACE FUNCTION "${schema}".box_realtime_notify() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_TABLE_NAME='admin_sessions' AND TG_OP<>'DELETE' THEN RETURN NULL; END IF; IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF; PERFORM pg_notify('${channel}', TG_TABLE_NAME); RETURN NULL; END $$`);
    for (const name of ['player_revocations', 'identity_bans', 'script_moderation_bans', 'users', 'admin_audit_events', 'login_events', 'admin_login_events', 'admin_accounts', 'admin_permission_groups', 'admin_sessions', 'script_admin_keys', 'script_admin_bindings', 'script_runtime_metadata']) {
      await pool.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='box_realtime_change' AND tgrelid='${table(name)}'::regclass AND (tgtype & 1)=0) THEN
          DROP TRIGGER box_realtime_change ON ${table(name)};
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='box_realtime_change' AND tgrelid='${table(name)}'::regclass) THEN
          CREATE TRIGGER box_realtime_change AFTER INSERT OR UPDATE OR DELETE ON ${table(name)} FOR EACH ROW EXECUTE FUNCTION "${schema}".box_realtime_notify();
        END IF; END $$`);
    }
    const client = new Client({
      connectionString: process.env.BOX_DATABASE_URL,
      application_name: 'box-realtime-events', connectionTimeoutMillis: 10_000,
      ssl: process.env.BOX_DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.BOX_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
    });
    let lost = false;
    const disconnected = () => {
      if (lost) return; lost = true;
      if (this.client === client) this.client = undefined;
      this.emit('unavailable');
      void client.end().catch(() => undefined);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { void this.start().catch(() => disconnectedRetry()); }, Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)));
      this.retry.unref?.();
    };
    const disconnectedRetry = () => {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { void this.start().catch(disconnectedRetry); }, 30_000); this.retry.unref?.();
    };
    client.on('error', disconnected); client.on('end', disconnected);
    client.on('notification', event => { if (event.channel === channel) this.emit(event.payload || ''); });
    try {
      await client.connect(); await client.query(`LISTEN "${channel}"`);
      this.client = client; this.failures = 0; clearTimeout(this.retry);
      // Every reconnect requires clients to reconcile durable state, not trust missed notifications.
      this.emit('resync');
    } catch (error) { disconnected(); throw error; }
  }
  private emit(table: string) { for (const listener of [...this.listeners]) { try { listener(table); } catch { /* Isolate consumers. */ } } }
  subscribe(listener: Listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
const state = globalThis as typeof globalThis & { __boxPlayerChangeFeed?: PlayerChangeFeed };
export const playerChangeFeed = state.__boxPlayerChangeFeed ||= new PlayerChangeFeed();
export async function ensurePlayerChangeFeed() { await playerChangeFeed.start(); }

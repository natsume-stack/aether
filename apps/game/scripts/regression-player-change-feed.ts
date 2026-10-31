/** Integration regression. Uses a unique schema and never modifies real player records. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from 'pg';
async function main() {
  if (!process.env.BOX_DATABASE_URL) throw new Error('Set BOX_DATABASE_URL to the regression PostgreSQL instance');
  const schema = `ws_regression_${randomBytes(8).toString('hex')}`;
  process.env.BOX_IDENTITY_DATABASE_SCHEMA = schema;
  const db = new Client({ connectionString: process.env.BOX_DATABASE_URL });
  await db.connect();
  let unsubscribe = () => {};
  try {
    const { playerChangeFeed, ensurePlayerChangeFeed } = await import('../server/player-change-feed');
    const { listPlayerRevocations } = await import('../server/local-player-identity');
    const notifications: string[] = [];
    unsubscribe = playerChangeFeed.subscribe(table => notifications.push(table));
    await ensurePlayerChangeFeed();
    const table = `"${schema}".player_revocations`;
    const subject = '11111111-1111-4111-8111-111111111111';
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(check());
    };
    notifications.length = 0;
    await db.query(`UPDATE ${table} SET reason=reason WHERE FALSE`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(notifications.length, 0, 'zero-row maintenance must not create notification loops');
    await db.query('BEGIN');
    await db.query(`INSERT INTO ${table}(subject_id,reason) VALUES($1,'banned')`, [subject]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(notifications.length, 0, 'uncommitted events must not be visible');
    await db.query('ROLLBACK');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(notifications.length, 0, 'rollback must not notify');
    // Commit order differs from sequence allocation order.
    await db.query('BEGIN');
    const lower = (await db.query(`INSERT INTO ${table}(subject_id,reason) VALUES($1,'banned') RETURNING id`, [subject])).rows[0].id;
    const parallel = new Client({ connectionString: process.env.BOX_DATABASE_URL });
    await parallel.connect();
    let upper: string;
    try { upper = (await parallel.query(`INSERT INTO ${table}(subject_id,reason) VALUES($1,'deleted') RETURNING id`, [subject])).rows[0].id; }
    finally { await parallel.end(); }
    await waitFor(() => notifications.includes('player_revocations'));
    assert.deepEqual((await listPlayerRevocations(0, new Date(0))).events.map(e => e.id), [String(upper!)]);
    notifications.length = 0;
    await db.query('COMMIT');
    await waitFor(() => notifications.includes('player_revocations'));
    assert.deepEqual((await listPlayerRevocations(0, new Date(0))).events.map(e => e.id), [String(lower), String(upper!)]);
    notifications.length = 0;
    await db.query(`UPDATE ${table} SET reason=reason`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(notifications.length, 0, 'unchanged rows must not notify');
    // Force only our schema's listener connection to reconnect.
    notifications.length = 0;
    await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='box-realtime-events' AND query LIKE $1`, ['%box_changes_' + createHash('sha256').update(schema).digest('hex').slice(0, 20) + '%']);
    await waitFor(() => notifications.includes('resync'));
    assert.equal((await listPlayerRevocations(0, new Date(0))).events.length, 2);
    console.log('PostgreSQL change-feed regression passed: commit-only notifications, rollback, concurrent commit order, listener reconnect and durable replay');
  } finally {
    unsubscribe(); await db.query('ROLLBACK');
    await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.end();
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'node:crypto';
import { ensureCreatorSceneWebSocketServer } from '../../../server/creator-scene-websocket';
import { issueRealtimeTicket } from '../../../server/realtime-tickets';
import { connectPlayPresence, getPlayPresenceCounts, onPlayPresenceChange } from '../../../server/play-presence';
import { findPlayWorld, getPlayWorlds } from '../../../server/play-worlds';
import { requestPlayerServiceIp, resolvePlayerServiceIdentity } from '../../../server/player-service-client';
import { allowPlayLibraryAdmin } from '../../../server/play-admin-security';
import { getPlaySystemStatus } from '../../../server/play-system-status';
import { subscribeSnapshot } from '../../../server/realtime-snapshots';
import { isInternalIdentityRequest, listPlayerRevocations } from '../../../server/local-player-identity';
import { ensurePlayerChangeFeed, playerChangeFeed } from '../../../server/player-change-feed';
import { allowPlayerAdminRequestOrigin, sendPlayerAdminApiError } from '../../../server/player-admin-authorization';
import { resolvePlayerAdminSession } from '../../../server/player-admin-identity';
import { roleHasPlayerAdminPermission } from '@box/player-policy';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const kind = req.body?.kind;
  const host = req.headers.host || '';
  let browserHost = host;
  if (kind !== 'revocations') {
    try {
      const allowedHosts = new Set([host]);
      for (const value of [process.env.BOX_SERVER_PUBLIC_URL, process.env.BOX_PLAY_PUBLIC_URL, process.env.BOX_PLAYER_SERVICE_PUBLIC_URL]) {
        if (value) { try { allowedHosts.add(new URL(value).host); } catch { /* Ignore invalid configured URLs. */ } }
      }
      browserHost = req.headers.origin ? new URL(req.headers.origin).host : host;
      if (req.headers['sec-fetch-site'] === 'cross-site' || !allowedHosts.has(browserHost)) {
        return res.status(403).json({ message: '实时连接来源无效' });
      }
    } catch { return res.status(403).end(); }
  }
  try {
    let attach: Parameters<typeof issueRealtimeTicket>[1];
    let grantHost = browserHost;
    if (kind === 'presence-watch' && process.env.BOX_DEPLOYMENT_MODE === 'play') {
      const maps: unknown = req.body.maps;
      if (!Array.isArray(maps) || maps.length > 100 || maps.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))) return res.status(400).end();
      const groupByMap = Object.fromEntries(getPlayWorlds().map(world => [world.publicId, world.mapGroupId || world.mainProjectId || world.id]));
      attach = send => {
        let previous = '';
        const update = () => {
          const data = getPlayPresenceCounts(maps, groupByMap);
          const next = JSON.stringify(data);
          if (next !== previous) { previous = next; send({ type: 'presence', maps: data }); }
        };
        const close = onPlayPresenceChange(update); update();
        return { close };
      };
    } else if (kind === 'player-presence' && process.env.BOX_DEPLOYMENT_MODE === 'play') {
      const world = typeof req.body.mapId === 'string' ? findPlayWorld(req.body.mapId) : undefined;
      if (!world) return res.status(404).end();
      const { identity } = await resolvePlayerServiceIdentity(req, res, requestPlayerServiceIp(req));
      attach = () => ({ close: connectPlayPresence(world.publicId, identity.subjectId, randomUUID()) });
    } else if (kind === 'play-status') {
      if (!allowPlayLibraryAdmin(req, res)) return;
      attach = send => ({ close: subscribeSnapshot('play-status', getPlaySystemStatus, send) });
    } else if (kind === 'admin-events') {
      if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
      if (!allowPlayerAdminRequestOrigin(req, res)) return;
      const identity = await resolvePlayerAdminSession(req, { requireCsrf: true });
      const allowed = (capability: 'audit.view' | 'players.view' | 'identity-bans.view') =>
        roleHasPlayerAdminPermission(identity.role, capability, identity.permissions);
      await ensurePlayerChangeFeed();
      attach = send => ({ close: playerChangeFeed.subscribe(table => {
        if (['admin_accounts', 'admin_permission_groups', 'admin_sessions', 'unavailable'].includes(table)) { send({ type: 'reauthenticate' }); return; }
        const topic = ['admin_audit_events', 'login_events', 'admin_login_events'].includes(table) ? 'activity' :
          table === 'identity_bans' ? 'identity-bans' :
          ['users', 'player_revocations'].includes(table) ? 'players' :
          ['script_admin_keys', 'script_admin_bindings', 'script_runtime_metadata', 'script_moderation_bans'].includes(table) ? 'map-authorization' : 'resync';
        const permitted = topic === 'activity' ? allowed('audit.view') : topic === 'identity-bans' ? allowed('identity-bans.view') :
          topic === 'players' ? allowed('players.view') : topic === 'map-authorization' ? identity.role === 'owner' : true;
        // Only invalidations; reads still use live permission checks. Never broadcast user details.
        if (permitted) send({ type: 'change', topic });
      }) });
    } else if (kind === 'revocations') {
      if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
      if (!isInternalIdentityRequest(req)) return res.status(401).end();
      const since = new Date(req.body.since || '');
      const cursor = Number(req.body.after || 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || Number.isNaN(since.getTime())) return res.status(400).end();
      await ensurePlayerChangeFeed(); grantHost = 'internal';
      attach = send => {
        let highWater = cursor; let busy = false; let again = false; let closed = false;
        const seen = new Set<string>();
        const sync = async () => {
          if (busy) { again = true; return; } busy = true;
          try {
            do {
              again = false;
              // Sequence allocation precedes commit: a lower id can commit after a
              // higher id. Rescan the signed-identity window instead of trusting id>cursor.
              const cutoff = since.getTime();
              let pageCursor = 0;
              while (!closed) {
                const data = await listPlayerRevocations(pageCursor, new Date(cutoff));
                if (closed) return;
                const events = data.events.filter(event => !seen.has(event.id));
                for (const event of events) seen.add(event.id);
                highWater = Math.max(highWater, Number(data.cursor));
                if (events.length) send({ type: 'revocations', cursor: String(highWater), events });
                if (data.events.length < 500) break;
                pageCursor = Number(data.cursor);
              }
            } while (again && !closed);
          } catch { if (!closed) send({ type: 'resync-required' }); }
          finally { busy = false; }
        };
        const unsubscribe = playerChangeFeed.subscribe(table => {
          if (table === 'unavailable') { send({ type: 'resync-required' }); return; }
          if (table === 'player_revocations' || table === 'resync') void sync();
          if (['identity_bans', 'script_moderation_bans', 'resync'].includes(table)) send({ type: 'admission-changed' });
        });
        void sync(); send({ type: 'admission-changed' });
        return { close: () => { closed = true; unsubscribe(); } };
      };
    } else return res.status(404).end();
    await ensureCreatorSceneWebSocketServer();
    return res.status(200).json(issueRealtimeTicket(grantHost, attach));
  } catch (error) { return sendPlayerAdminApiError(res, error, 'Realtime bootstrap failed'); }
}

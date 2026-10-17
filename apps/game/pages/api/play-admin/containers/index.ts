import { playerAdminRoute } from '../../../../server/player-admin-route';
import { getContainerCatalog, savePlayMapGroupRuntimeProfile, destroyContainerRuntime, restartContainerRuntime } from '../../../../server/map-container-admin';

export default playerAdminRoute({
  methods: ['GET', 'POST'],
  requirement: (req) => req.method === 'GET' ? 'containers.view' : 'containers.manage',
  errorContext: 'Map container administration failed',
}, async ({ req, res }) => {
  if (req.method === 'GET') {
    const mode = req.query.mode === 'creator' ? 'creator' : 'play';
    return res.status(200).json(await getContainerCatalog(mode));
  }
  if (req.body?.action === 'destroy') {
    await destroyContainerRuntime(req.body.mode === 'creator' ? 'creator' : 'play', String(req.body.projectId || ''), req.body.roomId ? String(req.body.roomId) : undefined);
    return res.status(204).end();
  }
  if (req.body?.action === 'restart') {
    await restartContainerRuntime(req.body.mode === 'creator' ? 'creator' : 'play', String(req.body.projectId || ''));
    return res.status(202).end();
  }
  return res.status(200).json({ profile: await savePlayMapGroupRuntimeProfile(req.body || {}) });
});

import { playerAdminRoute } from '../../../../server/player-admin-route';
import { deletePlayMapGroupRuntimeProfile } from '../../../../server/map-container-admin';

export default playerAdminRoute({
  methods: ['DELETE'],
  requirement: 'containers.manage',
  errorContext: 'Map container profile removal failed',
}, async ({ req, res }) => {
  await deletePlayMapGroupRuntimeProfile(String(req.query.permanentMapId || ''), req.body?.configurationScope === 'map' ? 'map' : 'group');
  return res.status(204).end();
});

import { playerAdminRoute } from '../../../../server/player-admin-route';
import { deleteRuntimeResourceGroup, saveRuntimeResourceGroup } from '../../../../server/map-container-admin';

export default playerAdminRoute({
  methods: ['PATCH', 'DELETE'],
  requirement: 'containers.manage',
  errorContext: 'Container resource group administration failed',
}, async ({ req, res }) => {
  const id = String(req.query.id || '');
  if (req.method === 'DELETE') {
    await deleteRuntimeResourceGroup(id);
    return res.status(204).end();
  }
  return res.status(200).json({ resourceGroup: await saveRuntimeResourceGroup({ ...(req.body || {}), id }) });
});

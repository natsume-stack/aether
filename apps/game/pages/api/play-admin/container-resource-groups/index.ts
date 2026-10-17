import { playerAdminRoute } from '../../../../server/player-admin-route';
import { listRuntimeResourceGroups, saveRuntimeResourceGroup } from '../../../../server/map-container-admin';

export default playerAdminRoute({
  methods: ['GET', 'POST'],
  requirement: (req) => req.method === 'GET' ? 'containers.view' : 'containers.manage',
  errorContext: 'Container resource group administration failed',
}, async ({ req, res }) => {
  if (req.method === 'GET') return res.status(200).json({ resourceGroups: await listRuntimeResourceGroups() });
  return res.status(200).json({ resourceGroup: await saveRuntimeResourceGroup(req.body || {}) });
});

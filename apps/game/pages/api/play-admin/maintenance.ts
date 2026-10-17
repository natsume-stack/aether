import { cleanupExpiredPlayerSessions } from '../../../server/local-player-identity';
import { playerAdminRoute } from '../../../server/player-admin-route';
import { parseMaintenanceAction } from '../../../server/player-admin-validation';

export default playerAdminRoute({
  methods: ['POST'],
  requirement: 'owner',
  parse: (req) => parseMaintenanceAction(req.body),
  errorContext: 'Player admin maintenance failed',
}, async ({ res, actor }) => res.status(200).json(
  await cleanupExpiredPlayerSessions(actor),
));

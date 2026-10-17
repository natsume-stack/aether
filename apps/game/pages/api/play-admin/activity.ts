import { listPlayerAdminActivity } from '../../../server/local-player-identity';
import { playerAdminRoute } from '../../../server/player-admin-route';
import { parsePlayerActivityQuery } from '../../../server/player-admin-validation';

export default playerAdminRoute({
  methods: ['GET'],
  requirement: 'audit.view',
  parse: (req) => parsePlayerActivityQuery(req.query),
  errorContext: 'Player admin activity query failed',
}, async ({ res, input }) => res.status(200).json(
  await listPlayerAdminActivity(input),
));

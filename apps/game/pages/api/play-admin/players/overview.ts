import { getPlayerAdminOverview } from '../../../../server/local-player-identity';
import { playerAdminRoute } from '../../../../server/player-admin-route';

export default playerAdminRoute({
  methods: ['GET'],
  requirement: 'players.view',
  errorContext: 'Player admin overview failed',
}, async ({ res }) => res.status(200).json(await getPlayerAdminOverview()));

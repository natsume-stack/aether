import { logoutPlayerAdmin } from '../../../server/player-admin-identity';
import { playerAdminRoute } from '../../../server/player-admin-route';

export default playerAdminRoute({
  methods: ['POST'],
  requirement: 'players.view',
  errorContext: 'Player admin logout failed',
}, async ({ req, res }) => {
  await logoutPlayerAdmin(req, res);
  return res.status(200).json({ loggedOut: true });
});

import { playerAdminIdentity } from '../../../server/player-admin-authorization';
import {
  changeOwnPlayerAdminPassword,
  clearPlayerAdminSession,
} from '../../../server/player-admin-identity';
import { playerAdminRoute } from '../../../server/player-admin-route';
import { parseChangeOwnAdminPassword } from '../../../server/player-admin-validation';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

export default playerAdminRoute({
  methods: ['POST'],
  requirement: 'players.view',
  parse: (req) => parseChangeOwnAdminPassword(req.body),
  errorContext: 'Player admin self password update failed',
}, async ({ req, res, actor, input }) => {
  await changeOwnPlayerAdminPassword(playerAdminIdentity(actor), input, req);
  clearPlayerAdminSession(req, res);
  return res.status(200).json({ changed: true });
});

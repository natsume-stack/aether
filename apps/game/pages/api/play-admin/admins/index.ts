import { playerAdminIdentity } from '../../../../server/player-admin-authorization';
import {
  createPlayerAdminAccount,
  listPlayerAdminAccounts,
} from '../../../../server/player-admin-identity';
import { playerAdminRoute } from '../../../../server/player-admin-route';
import { parseCreateAdminAccount } from '../../../../server/player-admin-validation';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

export default playerAdminRoute({
  methods: ['GET', 'POST'],
  requirement: 'owner',
  parse: (req) => req.method === 'POST'
    ? { kind: 'create' as const, values: parseCreateAdminAccount(req.body) }
    : { kind: 'list' as const },
  errorContext: 'Player admin account operation failed',
}, async ({ req, res, actor, input: operation }) => {
  const identity = playerAdminIdentity(actor);
  if (operation.kind === 'list') {
    return res.status(200).json({ admins: await listPlayerAdminAccounts(identity) });
  }
  return res.status(201).json({
    admin: await createPlayerAdminAccount(operation.values, identity, req),
  });
});

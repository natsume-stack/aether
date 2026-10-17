import { exportManagedPlayersCsv } from '../../../../server/local-player-identity';
import { playerAdminRoute } from '../../../../server/player-admin-route';
import { parsePlayerExportQuery } from '../../../../server/player-admin-validation';

export default playerAdminRoute({
  methods: ['GET'],
  requirement: 'players.export',
  parse: (req) => parsePlayerExportQuery(req.query),
  errorContext: 'Player export failed',
}, async ({ res, input }) => {
  const result = await exportManagedPlayersCsv(input);
  const suffix = result.truncated ? '-first-10000' : '';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="players${suffix}.csv"`);
  res.setHeader('X-BOX-Exported-Rows', String(result.exported));
  res.setHeader('X-BOX-Total-Rows', String(result.total));
  return res.status(200).send(result.csv);
});

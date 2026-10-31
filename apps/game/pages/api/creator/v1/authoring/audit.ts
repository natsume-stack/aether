import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeCreatorCliApi } from '../../../../../server/creator-api-security';
import {
  CREATOR_AUTHORING_SCOPE,
  authoringBearer,
  readAuthoringAudit,
  tokenFingerprint,
} from '../../../../../server/creator-authoring-bridge';

/**
 * GET /api/creator/v1/authoring/audit?projectId=&limit=
 *
 * The accountability half of `authoring.apply`: the caller sees its own writes
 * only. Rows are matched on both the token subject and the token fingerprint,
 * so a second `bxc_*` token of the same account cannot read this trail, and no
 * scope grants cross-token surveillance. `limit` is clamped to 1..500.
 *
 * The trail itself is one JSON line per write on stdout (always) plus
 * `BOX_CREATOR_AUTHORING_AUDIT_PATH` when the operator configures it; without
 * that variable this endpoint reports `sink:"stdout-only"` instead of pretending
 * to have a file.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const identity = await authorizeCreatorCliApi(req, res, CREATOR_AUTHORING_SCOPE);
  if (!identity) return;

  const requestedProject = Array.isArray(req.query.projectId)
    ? req.query.projectId[0]
    : req.query.projectId;
  const requestedLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const projectId = String(requestedProject || '').trim();
  if (projectId && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
    return res.status(400).json({ code: 'INVALID_PROJECT_ID', message: '永久地图 ID 无效' });
  }

  const result = readAuthoringAudit({
    tokenSubject: identity.subjectId,
    tokenFingerprint: tokenFingerprint(authoringBearer(req)),
    projectId: projectId || undefined,
    limit: Number(requestedLimit) || undefined,
  });
  return res.status(200).json({
    scope: CREATOR_AUTHORING_SCOPE,
    projectId: projectId || null,
    sink: result.sink,
    total: result.total,
    rows: result.rows,
    fields: ['at', 'tokenSubject', 'tokenFingerprint', 'projectId', 'tool',
      'revisionBefore', 'revisionAfter', 'result', 'statusCode', 'code', 'action', 'detail'],
  });
}

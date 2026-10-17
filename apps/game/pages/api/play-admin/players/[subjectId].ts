import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createIdentityBan,
  createCreatorCliToken,
  deleteManagedPlayer,
  getManagedPlayerDetails,
  resetManagedPlayerPassword,
  revokeManagedPlayerSessions,
  revokeManagedPlayerSession,
  revokeIdentityBan,
  revokeCreatorCliToken,
  updateCreatorCliToken,
  updateManagedPlayer,
} from '../../../../server/local-player-identity';
import {
  authorizePlayerAdmin,
} from '../../../../server/player-admin-authorization';
import { playerAdminRequestError } from '../../../../server/player-admin-errors';
import {
  parsePlayerItemOperation,
  playerItemRequirement,
} from '../../../../server/player-admin-validation';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!['GET', 'PATCH', 'POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, PATCH, POST, DELETE');
    return res.status(405).end();
  }

  const requirement = playerItemRequirement(req.method, req.body);
  const context = await authorizePlayerAdmin(req, res, requirement);
  if (!context) return;

  const subjectIdValue = Array.isArray(req.query.subjectId)
    ? req.query.subjectId[0]
    : req.query.subjectId || '';
  try {
    const operation = parsePlayerItemOperation(
      req.method,
      subjectIdValue,
      req.body,
    );
    if (operation.kind === 'get') {
      return res.status(200).json(await getManagedPlayerDetails(operation.subjectId));
    }
    if (operation.kind === 'patch') {
      return res.status(200).json({
        player: await updateManagedPlayer(
          operation.subjectId,
          operation.changes,
          context,
        ),
      });
    }
    if (operation.kind === 'command') {
      const { command, subjectId } = operation;
      if (command.action === 'revoke-sessions') {
        return res.status(200).json(await revokeManagedPlayerSessions(subjectId, context));
      }
      if (command.action === 'revoke-session') {
        return res.status(200).json(await revokeManagedPlayerSession(subjectId, command.sessionId, context));
      }
      if (command.action === 'reset-password') {
        return res.status(200).json(await resetManagedPlayerPassword(subjectId, command.password, context));
      }
      if (command.action === 'create-cli-token') {
        return res.status(201).json(await createCreatorCliToken(subjectId, command, context));
      }
      if (command.action === 'update-cli-token') {
        return res.status(200).json(await updateCreatorCliToken(subjectId, command.tokenId, command.scopes, context));
      }
      if (command.action === 'revoke-cli-token') {
        return res.status(200).json(await revokeCreatorCliToken(subjectId, command.tokenId, context));
      }
      if (command.action === 'ban-ip' || command.action === 'ban-device') {
        return res.status(200).json(await createIdentityBan(subjectId, {
          kind: command.action === 'ban-ip' ? 'ip' : 'device',
          value: command.value,
          reason: command.reason,
          bannedUntil: command.bannedUntil,
        }, context));
      }
      if (command.action === 'unban-source') {
        return res.status(200).json(
          await revokeIdentityBan(subjectId, command.banId, context),
        );
      }
    }
    if (operation.kind === 'delete') {
      await deleteManagedPlayer(operation.subjectId, context);
      return res.status(200).json({ deleted: true });
    }
  } catch (error) {
    const requestError = playerAdminRequestError(error);
    return res.status(requestError?.status || 400).json({
      message: requestError?.message || (error as Error).message,
    });
  }
}

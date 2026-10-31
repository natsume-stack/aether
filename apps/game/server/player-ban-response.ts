import { PlayerBannedError } from './local-player-identity';

/** Login, registration and session checks expose the same punishment details. */
export function playerBanResponse(error: unknown) {
  if (!(error instanceof PlayerBannedError)) return null;
  const messages = {
    account: '该玩家已被封禁',
    ip: '当前 IP 地址已被封禁',
    device: '当前设备已被封禁',
  };
  return {
    code: error.message,
    message: messages[error.kind],
    banKind: error.kind,
    banReason: error.reason,
    bannedUntil: error.bannedUntil,
  };
}

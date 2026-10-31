export type PlayerAdminErrorCode =
  | 'ADMIN_REQUEST_INVALID'
  | 'ADMIN_AUTH_REQUIRED'
  | 'ADMIN_SESSION_MISMATCH'
  | 'ADMIN_CSRF_INVALID'
  | 'ADMIN_RATE_LIMITED'
  | 'SCRIPT_RATE_LIMITED'
  | 'OWNER_SESSION_REQUIRED';

export class PlayerAdminRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400,
    readonly code: PlayerAdminErrorCode = 'ADMIN_REQUEST_INVALID',
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PlayerAdminRequestError';
  }
}

const sessionErrors = {
  ADMIN_AUTH_REQUIRED: {
    status: 401,
    message: '请登录独立的玩家管理账号',
  },
  ADMIN_SESSION_MISMATCH: {
    status: 401,
    message: '管理会话环境已变化，请重新登录',
  },
  ADMIN_CSRF_INVALID: {
    status: 403,
    message: '管理会话安全校验失败，请刷新后重试',
  },
} as const;

export function playerAdminSessionError(code: keyof typeof sessionErrors) {
  const definition = sessionErrors[code];
  return new PlayerAdminRequestError(
    definition.message,
    definition.status,
    code,
  );
}

export function playerAdminRequestError(error: unknown) {
  return error instanceof PlayerAdminRequestError ? error : null;
}

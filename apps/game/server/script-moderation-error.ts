import type { ModerationErrorStatus } from '@box/schema/api/js/moderation'
import { PlayerAdminRequestError } from './player-admin-errors'

export class ScriptModerationRequestError extends PlayerAdminRequestError {
  constructor(message: string, readonly moderationStatus: ModerationErrorStatus,
    status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400, retryAfterSeconds?: number) {
    super(message, status, status === 429 ? 'SCRIPT_RATE_LIMITED' : 'ADMIN_REQUEST_INVALID', retryAfterSeconds)
  }
}

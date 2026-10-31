import { createApiClient } from '@box/apis';

/** Shared generated-contract request seam for every player-admin module. */
export const playerAdminApi = createApiClient({
    csrfCookie: 'box_local_admin_csrf',
    csrfHeader: 'X-Box-Admin-Csrf',
    defaultErrorMessage: '请求失败，请稍后重试',
});

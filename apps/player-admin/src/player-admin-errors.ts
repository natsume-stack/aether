import { message } from 'antd';

/** Ant Design already renders field validation errors beside the relevant input. */
export function reportAdminError(error:unknown) {
    if (error && typeof error === 'object' && 'errorFields' in error) {
        return;
    }
    message.error(error instanceof Error && error.message ? error.message : '请求失败，请稍后重试');
}

import { Modal } from 'antd';

import { reportAdminError } from '../player-admin-errors';

import type { ModalFuncProps } from 'antd';

/** Uncaught failures keep the confirmation open; every page gets the same error handling. */
export function confirmAdminAction({ onOk, ...options }:ModalFuncProps) {
    return Modal.confirm({
        okText: '确认',
        cancelText: '取消',
        ...options,
        onOk: onOk
            ? async () => {
                  try {
                      return await onOk();
                  } catch (error) {
                      reportAdminError(error);
                      throw error;
                  }
              }
            : undefined,
    });
}

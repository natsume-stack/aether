import { ClientConfig } from '../../config/client';

export interface AvatarEditorClientConfig extends Pick<ClientConfig, 'appEnv'> {
  avatarCDNPath: string;
  modelCDNPath: string;
}

function getConfig() {
  if (typeof window === 'undefined') {
    return {};
  }

  return window['CLIENT_CONFIG'];
}
// 默认的配置
const DEFAULT_CLIENT_CONFIG = {
  appEnv: 'production',
};

export const clientConfig: AvatarEditorClientConfig = Object.assign(
  DEFAULT_CLIENT_CONFIG,
  getConfig(),
);

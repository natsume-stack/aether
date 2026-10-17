import { clientConfig } from '../config/client';

/**
 * clientConfig.appEnv === 'production'
 */
export function isAppEnvProduction() {
  return clientConfig.appEnv === 'production';
}

import { ClientConfig } from '../../config/client';

export type PlayerClientRuntimeConfig = Pick<
  ClientConfig,
  'appEdition' | 'appEnv' | 'backendServerUrl' | 'cdnPath'
>;

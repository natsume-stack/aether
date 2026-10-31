import { ClientConfig } from '../../config/client';

export type AvatarClientRuntimeConfig = Pick<
  ClientConfig,
  'appEdition' | 'appEnv' | 'backendServerUrl' | 'cdnPath'
>;

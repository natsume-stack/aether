// 供其他开发者直接复用的服务端类；不要从浏览器导入。
export { PortalConfig, type PortalOptions } from './config';
export { PortalServer } from './portal';
export { AuthProxy, AuthOperation, AuthPolicy, PlayerServiceClient } from './auth';

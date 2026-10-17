import { PortalConfig, PortalServer } from './index';

const config = PortalConfig.fromEnvironment();
const portal = new PortalServer(config);
portal
    .listen()
    .then(() => console.log(`BOX player login portal: http://${config.host}:${config.port}`))
    .catch((error) => {
        console.error(error instanceof Error ? error.message : 'Cannot start portal');
        process.exitCode = 1;
    });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void portal.close().then(() => process.exit(0));
    });
}

const { packagingContext } = require('../../../scripts/packaging-context');
const manifest = require('../package.json');
const { channel, version } = packagingContext(
    process.env,
    manifest.version,
    'PLAYER_BUILD_CHANNEL',
);

module.exports = {
    ...manifest.build,
    extraMetadata: { version },
    appId: `${manifest.build.appId}${channel === 'production' ? '' : `.${channel}`}`,
    artifactName: 'BOX3-Player-Launcher-${version}-${os}-${arch}.${ext}',
    ...(channel === 'dev' && process.platform === 'darwin' && !process.env.CSC_LINK?.trim()
        ? {
              mac: {
                  ...manifest.build.mac,
                  identity: '-',
                  hardenedRuntime: false,
                  notarize: false,
              },
          }
        : {}),
};

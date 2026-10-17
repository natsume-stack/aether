'use strict';

function productionVersion(ref, product = 'engine') {
    const prefix = { engine: 'release', player: 'player-release' }[product];
    const match =
        prefix &&
        new RegExp(
            `^refs/heads/${prefix}/v((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))$`,
        ).exec(ref || '');
    if (!match) {
        throw new Error(
            `Production ${product} builds require a ${prefix || 'valid'}/v<version> branch`,
        );
    }
    return match[1];
}

function versionForChannel(version, channel) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('Invalid packaging version');
    }
    if (channel === 'production') {
        if (/(?:-|\.)(dev|staging)$/.test(version)) {
            throw new Error('Development and staging versions cannot enter production');
        }
        return version;
    }
    const base = version.replace(/(?:-|\.)(dev|staging)$/, '');
    return `${base}${base.includes('-') ? '.' : '-'}${channel}`;
}

/** Local packaging always uses dev, independently of the checked-out branch. */
function packagingContext(env, packageVersion, channelVariable = 'BOX_BUILD_CHANNEL') {
    const channel =
        env.GITHUB_ACTIONS === 'true'
            ? env[channelVariable] ||
              (env.GITHUB_REF === 'refs/heads/staging' ? 'staging' : 'production')
            : 'dev';
    if (!['dev', 'staging', 'production'].includes(channel)) {
        throw new Error('Unknown packaging channel');
    }
    const version =
        channel === 'production' &&
        /^refs\/heads\/(?:release|player-release)\//.test(env.GITHUB_REF || '')
            ? productionVersion(
                  env.GITHUB_REF,
                  channelVariable === 'PLAYER_BUILD_CHANNEL' ? 'player' : 'engine',
              )
            : versionForChannel(packageVersion, channel);
    return { channel, version };
}

module.exports = { packagingContext, versionForChannel, productionVersion };

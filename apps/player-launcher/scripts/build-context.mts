import { createRequire } from 'node:module';

import { releaseInfo } from './release-contract.mts';

const { productionVersion } = createRequire(import.meta.url)(
    '../../../scripts/packaging-context.js',
);

/** Staging identities and upload scopes never reuse a production tag directory. */
export function playerBuildContext(env:NodeJS.ProcessEnv, packageVersion:string) {
    const channel = env.PLAYER_BUILD_CHANNEL || 'production';
    const commit = env.PLAYER_RELEASE_COMMIT || env.GITHUB_SHA || '';
    if (channel === 'production') {
        const version = productionVersion(env.GITHUB_REF, 'player');
        const info = releaseInfo(env.PLAYER_RELEASE_TAG || `player-v${version}`, commit, version);
        return { channel, info, prefix: `box-player-launcher/${info.tag}` };
    }
    if (channel !== 'staging') {
        throw new Error('Unknown player build channel');
    }
    if (env.GITHUB_REF !== 'refs/heads/staging') {
        throw new Error('Player staging builds require the staging branch');
    }
    const base = releaseInfo(`player-v${packageVersion}`, commit, packageVersion);
    const version = /(?:-|\.)staging$/.test(packageVersion)
        ? packageVersion
        : `${packageVersion}${packageVersion.includes('-') ? '.' : '-'}staging`;
    const info = { ...base, tag: `player-v${version}`, version, prerelease: true };
    return { channel, info, prefix: `box-player-launcher-staging/${info.tag}/${commit}` };
}

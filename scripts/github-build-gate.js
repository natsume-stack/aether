'use strict';

const fs = require('node:fs');
const { productionVersion } = require('./packaging-context');

function githubContext(env = process.env) {
    if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ||
        !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ||
        !env.GH_TOKEN
    ) {
        throw new Error('GitHub build gate requires a repository, full commit SHA and token');
    }
    return {
        repository: env.GITHUB_REPOSITORY,
        commit: env.GITHUB_SHA,
        token: env.GH_TOKEN,
        ref: env.GITHUB_REF,
    };
}

async function githubGet(context, endpoint, request = fetch) {
    const response = await request(
        `https://api.github.com/repos/${context.repository}/${endpoint}`,
        {
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${context.token}`,
                'X-GitHub-Api-Version': '2026-03-10',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
        },
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`GitHub build gate request failed (${response.status})`);
    }
    return response.json();
}

function releaseIdentity(kind, version) {
    if (
        !['engine', 'player'].includes(kind) ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
            version,
        )
    ) {
        throw new Error('Invalid release kind or version');
    }
    const tag = `${kind === 'player' ? 'player-v' : 'v'}${version}`;
    return {
        version,
        tag,
        prefix: kind === 'player' ? `box-player-launcher/${tag}` : `local-engine/${tag}`,
    };
}

/** Reruns may reuse their own tag, but never artifacts belonging to another commit. */
async function checkRelease(context, identity, get = (endpoint) => githubGet(context, endpoint)) {
    const product = identity.tag.startsWith('player-v') ? 'player' : 'engine';
    if (productionVersion(context.ref, product) !== identity.version) {
        throw new Error('Release version does not match the versioned branch');
    }
    const reference = await get(`git/ref/tags/${encodeURIComponent(identity.tag)}`);
    if (!reference) {
        return identity;
    }
    let object = reference.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
        const annotated = await get(`git/tags/${object.sha}`);
        object = annotated?.object;
    }
    if (object?.type !== 'commit' || object.sha !== context.commit) {
        throw new Error(
            `Version ${identity.tag} already belongs to another commit; create a new versioned release branch`,
        );
    }
    return identity;
}

async function createTag(context, identity, request = fetch) {
    const response = await request(`https://api.github.com/repos/${context.repository}/git/refs`, {
        method: 'POST',
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${context.token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2026-03-10',
        },
        body: JSON.stringify({ ref: `refs/tags/${identity.tag}`, sha: context.commit }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 422) {
        return false;
    }
    if (!response.ok) {
        throw new Error(`GitHub version reservation failed (${response.status})`);
    }
    return true;
}

/** Reserve before cache reads so a failed build cannot donate artifacts to a different commit. */
async function reserveRelease(
    context,
    identity,
    get = (endpoint) => githubGet(context, endpoint),
    create = () => createTag(context, identity),
) {
    const endpoint = `git/ref/tags/${encodeURIComponent(identity.tag)}`;
    let reference = await get(endpoint);
    await checkRelease(context, identity, (value) => (value === endpoint ? reference : get(value)));
    if (!reference && !(await create())) {
        reference = await get(endpoint);
        if (!reference) {
            throw new Error('GitHub version reservation was not confirmed');
        }
        await checkRelease(context, identity, (value) =>
            value === endpoint ? reference : get(value),
        );
    }
    return identity;
}

async function main() {
    const [command, value] = process.argv.slice(2);
    const context = githubContext();
    let outputs;
    if (command === 'release') {
        const version = productionVersion(context.ref, value);
        outputs = await reserveRelease(context, releaseIdentity(value, version));
    } else {
        throw new Error('Usage: github-build-gate.js release <engine|player>');
    }
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            Object.entries(outputs)
                .map(([key, result]) => `${key}=${result}\n`)
                .join(''),
        );
    }
    console.log(`Build gate ${command}: ${JSON.stringify(outputs)}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
module.exports = {
    githubContext,
    githubGet,
    releaseIdentity,
    checkRelease,
    createTag,
    reserveRelease,
};

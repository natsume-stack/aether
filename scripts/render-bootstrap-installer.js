'use strict';

const fs = require('node:fs');
const path = require('node:path');

function renderBootstrapInstaller(source, channel) {
    if (!['production', 'staging'].includes(channel)) {
        throw new Error('Invalid bootstrap channel');
    }
    return channel === 'production'
        ? source
        : source
              .replace(
                  'https://assets.box3.fun/local-engine}',
                  'https://assets.box3.fun/local-engine-staging}',
              )
              .replace('/opt/box3-engine}', '/opt/box3-engine-staging}');
}

if (require.main === module) {
    const source = fs.readFileSync(
        path.join(__dirname, '../distribution/server/bootstrap.sh'),
        'utf8',
    );
    fs.writeFileSync(
        process.argv[2],
        renderBootstrapInstaller(source, process.env.BOX_BUILD_CHANNEL || 'production'),
        { mode: 0o755 },
    );
}

module.exports = { renderBootstrapInstaller };

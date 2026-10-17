'use strict';

const path = require('node:path');

const extensions = 'js,cjs,mjs,ts,tsx,mts,cts,css,less';
const directories = [
    'apps/deployment-manager',
    'apps/player-admin',
    'apps/player-launcher',
    'apps/player-auth-portal/src',
    'apps/player-auth-portal/server',
    'apps/player-auth-portal/scripts',
    'apps/player-auth-portal/test',
    'apps/local-engine/src',
    'apps/local-engine/scripts',
    'packages/deployment-routing',
    'packages/player-policy',
    'packages/realtime-client',
    'scripts',
    'tools/repo-tooling',
    'services/game-server/scripts/fixtures/anticheat',
];
const configurationFiles = ['.prettierrc.cjs', '.eslintrc.cjs'];
const documentationFiles = [
    'README.md',
    'CONTRIBUTING.md',
    'apps/voxa/README.md',
    'apps/server-manager-rust/README.md',
    'apps/manager-core/README.md',
    'internals/apis/README.md',
];
const documentationDirectories = [
    'docs',
    'apps/deployment-manager',
    'apps/player-admin',
    'apps/player-launcher',
    'apps/player-auth-portal',
    'apps/local-engine',
    'packages/deployment-routing',
    'packages/player-policy',
    'packages/realtime-client',
];
const patterns = [
    ...directories.map((directory) => `${directory}/**/*.{${extensions}}`),
    ...configurationFiles,
    'docs/**/*.md',
    'apps/{deployment-manager,player-admin,player-launcher,player-auth-portal,local-engine}/**/*.md',
    ...documentationFiles,
];
const manifests = [
    'package.json',
    'apps/deployment-manager/package.json',
    'apps/player-admin/package.json',
    'apps/player-launcher/package.json',
    'apps/player-auth-portal/package.json',
    'apps/local-engine/package.json',
    'tools/repo-tooling/package.json',
    'packages/deployment-routing/package.json',
    'packages/player-policy/package.json',
    'packages/realtime-client/package.json',
];
const options = {
    tabWidth: 4,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 100,
    plugins: [path.join(__dirname, 'client-format-plugin.cjs')],
};

module.exports = {
    directories,
    configurationFiles,
    documentationFiles,
    documentationDirectories,
    patterns,
    manifests,
    options,
};

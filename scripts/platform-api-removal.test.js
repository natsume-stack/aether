const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceFiles = [
    'internals/apis/dist/index.js',
    'internals/schema/api/js/api.ts',
    'services/game-server/src/script/script-shell.ts',
    'services/game-server/src/script/script-host.ts',
    'services/game-server/src/script/bindings/world-synchronizer.ts',
    'services/game-server/src/script/bindings/entity-synchronizer.ts',
];
const forbiddenScriptApis = [
    'getMiaoShells',
    'querySocial',
    'querySocialStatistic',
    'createTempChat',
    'destroyTempChat',
    'addTempChatPlayer',
    'removeTempChatPlayer',
    'getTempChats',
    'getTempChatUsers',
    'openMarketplace',
    'openUserProfileDialog',
    'containerTeleport',
    'getSocialRelationUsingGet',
    'getSocialRelationInfoUsingGet',
    'createTempChatUsingPost',
    'deleteTempChatUsingDelete',
    'addTempChatUserUsingPost',
    'tempChatIdsUsingGet',
    'removeTempChatUserUsingPost',
    'getTempChatUsersUsingGet',
    'SocialType',
    'SocialStatisticType',
    'onPlayerPurchaseSuccess',
    'nextPlayerPurchaseSuccess',
    'GamePurchaseSuccessEvent',
];

for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const api of forbiddenScriptApis) {
        assert.equal(source.includes(api), false, `${file} still exposes ${api}`);
    }
}

for (const removed of [
    'internals/apis/src/ai',
    'internals/apis/src/content',
    'internals/apis/src/createra',
    'internals/apis/src/model',
    'internals/apis/src/data-contracts.ts',
    'internals/apis/src/http-client.ts',
    'internals/apis/src/interface.ts',
    'internals/apis/dist/ai',
    'internals/apis/dist/content',
    'internals/apis/dist/createra',
    'internals/apis/dist/model',
    'internals/apis/dist/data-contracts.d.ts',
    'internals/apis/dist/http-client.d.ts',
    'internals/apis/dist/interface.d.ts',
    'internals/apis/src/java',
    'internals/apis/src/maas',
    'internals/apis/src/group',
    'internals/apis/src/signature',
    'internals/apis/src/ai/vobi.ts',
    'apps/game/src/apis/api-java',
    'apps/game/src/assets/maas_logo_white.svg',
    'apps/game/src/assets/maas_default_cover.png',
    'packages/analytics/build/client.js',
    'packages/analytics/build/http.js',
    'packages/analytics/build/protocol.js',
    'services/game-server/src/apis/index.ts',
    'services/game-server/src/storage/java-storage-api.ts',
    'internals/schema/events/market-event-schema.ts',
    'packages/utils/src/whitelist.ts',
    'packages/utils/build/whitelist.js',
]) {
    assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} still exists`);
}

for (const legacyClientName of [
    'JavaAuth',
    'JavaUser',
    'MaasAuth',
    'CodemaoLoginUsingPost',
    'FirebaseLoginUsingPost',
    'FlashLoginUsingPost',
]) {
    assert.equal(
        fs
            .readFileSync(path.join(root, 'internals/apis/dist/index.js'), 'utf8')
            .includes(legacyClientName),
        false,
        `@box/apis still bundles ${legacyClientName}`,
    );
}

for (const [file, legacyIdentifier] of [
    ['apps/game/assets/icons.svg', 'icon-logo-maas'],
    ['apps/game/configs/server.ts', 'MOCK_JAVA_BACKEND'],
    ['apps/game/src/utils/appEdition.ts', 'isMaas'],
    ['packages/utils/src/createra-permissions.ts', 'JavaPermissionsMap'],
]) {
    assert.equal(
        fs.readFileSync(path.join(root, file), 'utf8').includes(legacyIdentifier),
        false,
        `${file} still exposes ${legacyIdentifier}`,
    );
}

const localConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'apps/local-engine/config/local.config.json'), 'utf8'),
);
assert.equal('DOMAIN_WHITELIST' in localConfig.common, false);
assert.equal('SCRIPT_WHITELIST' in localConfig.common, false);

for (const file of [
    'internals/env/src/schemas/common.ts',
    'apps/game/configs/client.ts',
    'services/game-server/src/script/script-protocol.ts',
    'services/game-server/src/script/script-host.ts',
]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(
        source.includes('DOMAIN_WHITELIST'),
        false,
        `${file} still exposes DOMAIN_WHITELIST`,
    );
    assert.equal(
        source.includes('SCRIPT_WHITELIST'),
        false,
        `${file} still exposes SCRIPT_WHITELIST`,
    );
    assert.equal(
        source.includes('scriptWhiteList'),
        false,
        `${file} still exposes scriptWhiteList`,
    );
}

// These modules are the local-engine HTTP boundary. Keep generated @box/apis
// calls as the default so endpoint paths, payloads and error handling cannot
// silently drift away from OpenAPI.
const generatedApiConsumers = [
    'apps/game/pages/index.tsx',
    'apps/game/pages/play-system.tsx',
    'apps/game/src/apis/local-api/index.ts',
    'apps/game/server/player-service-client.ts',
    'apps/game/server/map-container-admin.ts',
    'apps/voxa/src/apis/index.ts',
    'services/game-server/src/createServer.ts',
    'apps/deployment-manager/src/infrastructure/transport.js',
    'apps/local-engine/src/runtime-container-client.js',
];

for (const file of generatedApiConsumers) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /@box\/apis/, `${file} must consume @box/apis`);
    assert.doesNotMatch(source, /\baxios\b/i, `${file} must not use axios directly`);

    const directFetches = source.match(/(?:globalThis\.)?\bfetch\s*\(/g) || [];
    const allowedFetches = file === 'apps/voxa/src/apis/index.ts' ? ['globalThis.fetch('] : [];
    assert.deepEqual(directFetches, allowedFetches, `${file} must not bypass ApiClient`);

    if (file !== 'apps/game/pages/index.tsx') {
        assert.equal(
            source.includes('XMLHttpRequest'),
            false,
            `${file} must not use XMLHttpRequest`,
        );
    }
}

// The revocation WebSocket transport has one authenticated HTTP bootstrap;
// it does not use the former generated HTTP polling operation.
const revocationStream = fs.readFileSync(
    path.join(root, 'services/game-server/src/player/player-revocation-poller.ts'),
    'utf8',
);
assert.equal((revocationStream.match(/\bfetch\s*\(/g) || []).length, 1);
assert.match(revocationStream, /fetch\(`\$\{serviceURL\}\/api\/realtime\/session`/);
assert.match(revocationStream, /Authorization: `Bearer \$\{secret\}`/);
assert.match(revocationStream, /url\.origin !== new URL\(serviceURL\)\.origin/);
assert.match(revocationStream, /new WebSocket\(url\.href/);
assert.doesNotMatch(revocationStream, /setInterval\s*\(|\baxios\b/i);

const playHome = fs.readFileSync(path.join(root, 'apps/game/pages/index.tsx'), 'utf8');
assert.equal((playHome.match(/XMLHttpRequest/g) || []).length, 1);
assert.match(playHome, /apiOperations\.postApiPlayAdminImport\.path/);

console.log('platform API and analytics removal checks passed');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const client = read('apps/game/src/engine/game-client.ts');
const playClient = read('apps/game/src/client/play/play-client.ts');
const sharedClient = read('apps/game/src/client/index.ts');
const teleportClient = read('apps/game/src/engine/teleport/teleport-client.ts');
const server = read('services/game-server/src/script/script-host.ts');
const createServer = read('services/game-server/src/createServer.ts');
const teleportServer = read('services/game-server/src/teleport/teleport-server.ts');
const launcher = read('apps/local-engine/src/launcher.js');

const orderedTokens = (source, tokens, label) => {
    let cursor = -1;
    for (const token of tokens) {
        const next = source.indexOf(token, cursor + 1);
        assert.notEqual(next, -1, `${label} is missing ${token}`);
        assert.ok(next > cursor, `${label} registers ${token} out of order`);
        cursor = next;
    }
};

// MuDB assigns numeric protocol IDs by registration order. Even disabled local
// features need matching transport slots on both sides of the engine socket.
orderedTokens(
    client,
    [
        'this.gui = new GUIClient',
        'this.market = new MarketClient',
        'this.teleport = new TeleportClient',
        'this.remoteChannel = new RemoteChannelClient',
    ],
    'GameClient',
);

orderedTokens(
    server,
    [
        'this.gui = new GUIServer',
        'spec.netServer.protocol(MarketProtocol)',
        'this.teleport = new TeleportServer',
        'this.remoteChannel = new RemoteChannelServer',
    ],
    'ScriptHost network server',
);

assert.ok(
    teleportServer.includes('server.protocol(TeleportProtocol)'),
    'TeleportServer is missing its engine network protocol registration',
);
assert.ok(
    teleportServer.includes(
        'process.env.BOX_WORLD_PERMANENT_MAP_ID || state.settings.containerName',
    ),
    'TeleportServer must identify the source map by its permanent map ID',
);
assert.ok(
    launcher.includes('BOX_WORLD_PERMANENT_MAP_ID: world.manifest.permanentMapId'),
    'Play runtimes must receive their permanent map ID',
);
assert.ok(
    server.includes('initPacket.config.serverId = serverId'),
    'world.serverId must preserve the runtime server ID supplied by the launcher',
);
assert.equal(
    server.includes('getHashFromContainerName(containerName)'),
    false,
    'world.serverId must not use the mutable access/container ID in edit mode',
);
assert.ok(
    teleportClient.includes('clientConfig.isLocalGameServer') &&
        teleportClient.includes('url: resolvePublicUrl(`/e/${encodeURIComponent(editHash)}`)') &&
        teleportClient.includes('messenger.jumpTo'),
    'a successful local edit teleport must navigate directly to the target map',
);

// MuClient/MuServer's third constructor argument means "skip protocol
// validation". Boxes skips it for production cloud sockets, but a production
// local runtime deliberately validates both sides. If only the client skips,
// its first protocol packet is parsed as validation JSON and the socket closes.
const localClientValidationRule =
    "process.env.NODE_ENV !== 'development' && !clientConfig.isLocalGameServer";
const localServerValidationRule =
    "process.env.NODE_ENV !== 'development' && serverConfig.method !== 'local'";

for (const [label, source] of [
    ['PlayClient', playClient],
    ['shared game client', sharedClient],
]) {
    assert.ok(
        source.includes(localClientValidationRule),
        `${label} must validate the MuDB handshake for production local runtimes`,
    );
    assert.equal(
        source.includes(
            "process.env.NODE_ENV !== 'development' || !clientConfig.isLocalGameServer",
        ),
        false,
        `${label} unexpectedly restored the cloud-only MuDB validation rule`,
    );
}

assert.ok(
    createServer.includes(localServerValidationRule),
    'game-server must validate the MuDB handshake for local runtimes',
);

for (const forbidden of ["from '../apis'", 'containerTeleport', 'getContainerHashById']) {
    assert.equal(
        `${server}\n${teleportServer}`.includes(forbidden),
        false,
        `local teleport unexpectedly uses platform API: ${forbidden}`,
    );
}

console.log('engine wire protocol order checks passed');

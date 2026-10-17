const assert = require('node:assert/strict');
const test = require('node:test');

const { createTeleportRoomManager } = require('../apps/local-engine/src/teleport-room-manager');

function fixture() {
    const maps = [
        {
            id: 'main-map',
            publicId: 'town',
            permanentMapId: '11111111111111111111',
            mapGroupId: 'group-a',
        },
        {
            id: 'sub-map',
            publicId: 'dungeon',
            permanentMapId: '22222222222222222222',
            mapGroupId: 'group-a',
        },
        {
            id: 'other-map',
            publicId: 'other',
            permanentMapId: '33333333333333333333',
            mapGroupId: 'group-b',
        },
    ];
    const starts = [];
    const stops = [];
    let now = 1_000;
    const manager = createTeleportRoomManager({
        resolveMap: (reference) =>
            maps.find(
                (map) =>
                    map.id === reference ||
                    map.publicId === reference ||
                    map.permanentMapId === reference,
            ) || null,
        ensureRuntime: async (map, roomId) => starts.push([map.id, roomId]),
        stopRuntime: async (roomId) => stops.push(roomId),
        isRoomActive: () => false,
        randomRoomId: () => 'private-room-123456',
        now: () => now,
        roomIdleTimeoutMs: 500,
        maxRooms: 4,
    });
    return {
        manager,
        starts,
        stops,
        advance: (milliseconds) => {
            now += milliseconds;
        },
    };
}

test('teleport allocates an unlisted private room inside the same map group', async () => {
    const { manager, starts } = fixture();
    const result = await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '22222222222222222222',
        subjectIds: ['player-a'],
    });

    assert.deepEqual(result, {
        playHash: 'sub-map',
        serverId: 'private-room-123456',
    });
    assert.deepEqual(starts, [['sub-map', 'private-room-123456']]);
    assert.equal(
        manager.authorize({
            targetMapId: '22222222222222222222',
            serverId: result.serverId,
            subjectId: 'player-a',
        }).id,
        result.serverId,
    );
    assert.throws(
        () =>
            manager.authorize({
                targetMapId: '22222222222222222222',
                serverId: result.serverId,
                subjectId: 'player-b',
            }),
        (error) => error.code === 'ROOM_ACCESS_DENIED' && error.statusCode === 403,
    );
    assert.equal(manager.listPublicRooms, undefined);
});

test('private-room authorization accepts the local play route returned after teleport', async () => {
    const { manager } = fixture();
    const result = await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '22222222222222222222',
        subjectIds: ['player-a'],
    });

    assert.equal(result.playHash, 'sub-map');
    assert.equal(
        manager.authorize({
            targetMapReference: result.playHash,
            serverId: result.serverId,
            subjectId: 'player-a',
        }).id,
        result.serverId,
    );
    assert.throws(
        () =>
            manager.authorize({
                targetMapReference: 'other-map',
                serverId: result.serverId,
                subjectId: 'player-a',
            }),
        (error) => error.code === 'ROOM_TARGET_MISMATCH' && error.statusCode === 403,
    );
});

test('teleport rejects mutable access IDs and local project keys', async () => {
    const { manager } = fixture();
    for (const targetMapId of ['dungeon', 'sub-map']) {
        await assert.rejects(
            manager.allocate({
                sourceMapId: '11111111111111111111',
                targetMapId,
                subjectIds: ['player-a'],
            }),
            (error) => error.code === 'MAP_ID_REQUIRED',
        );
    }
});

test('an existing room can admit newly teleported players but not another group', async () => {
    const { manager } = fixture();
    const first = await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '22222222222222222222',
        subjectIds: ['player-a'],
    });
    const reused = await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '22222222222222222222',
        subjectIds: ['player-b'],
        serverId: first.serverId,
    });

    assert.deepEqual(reused, first);
    assert.equal(
        manager.authorize({
            targetMapId: '22222222222222222222',
            serverId: first.serverId,
            subjectId: 'player-b',
        }).id,
        first.serverId,
    );
    await assert.rejects(
        manager.allocate({
            sourceMapId: '11111111111111111111',
            targetMapId: '33333333333333333333',
            subjectIds: ['player-a'],
        }),
        (error) => error.code === 'MAP_GROUP_MISMATCH',
    );
});

test('edit and public teleports do not allocate a private room', async () => {
    const { manager, starts } = fixture();
    assert.deepEqual(
        await manager.allocate({
            sourceMapId: '11111111111111111111',
            targetMapId: '22222222222222222222',
            subjectIds: ['player-a'],
            mode: 'edit',
        }),
        {
            playHash: 'sub-map',
            serverId: '22222222222222222222',
        },
    );
    assert.deepEqual(
        await manager.allocate({
            sourceMapId: '11111111111111111111',
            targetMapId: '22222222222222222222',
            subjectIds: ['player-a'],
            serverId: 'public',
        }),
        {
            playHash: 'sub-map',
            serverId: '22222222222222222222',
        },
    );
    assert.deepEqual(
        await manager.allocate({
            sourceMapId: '11111111111111111111',
            targetMapId: '22222222222222222222',
            subjectIds: ['player-a'],
            serverId: '22222222222222222222',
        }),
        {
            playHash: 'sub-map',
            serverId: '22222222222222222222',
        },
    );
    assert.deepEqual(starts, []);
});

test('idle private rooms are removed and their runtimes are stopped', async () => {
    const { manager, stops, advance } = fixture();
    const room = await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '22222222222222222222',
        subjectIds: ['player-a'],
    });
    advance(501);

    assert.deepEqual(await manager.collectIdle(), [room.serverId]);
    assert.deepEqual(stops, [room.serverId]);
    assert.throws(
        () =>
            manager.authorize({
                targetMapId: '22222222222222222222',
                serverId: room.serverId,
                subjectId: 'player-a',
            }),
        (error) => error.code === 'ROOM_NOT_FOUND',
    );
});

test('room limits and idle collection can be scoped to the target map', async () => {
    const maps = [
        { id: 'main-map', permanentMapId: '11111111111111111111', mapGroupId: 'group-a' },
        { id: 'sub-map', permanentMapId: '22222222222222222222', mapGroupId: 'group-a' },
        { id: 'other-map', permanentMapId: '33333333333333333333', mapGroupId: 'group-a' },
    ];
    let now = 1_000;
    let serial = 0;
    const stops = [];
    const manager = createTeleportRoomManager({
        resolveMap: (reference) =>
            maps.find((map) => map.id === reference || map.permanentMapId === reference),
        ensureRuntime: async () => undefined,
        stopRuntime: async (roomId) => stops.push(roomId),
        isRoomActive: () => false,
        randomRoomId: () => `private-room-${String(++serial).padStart(12, '0')}`,
        now: () => now,
        maxRoomsForMap: (mapId) => (mapId === '22222222222222222222' ? 1 : 2),
        roomIdleTimeoutForMap: (mapId) => (mapId === '22222222222222222222' ? 100 : 500),
    });
    const first = await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '22222222222222222222',
        subjectIds: ['player-a'],
    });
    await assert.rejects(
        manager.allocate({
            sourceMapId: '11111111111111111111',
            targetMapId: '22222222222222222222',
            subjectIds: ['player-b'],
        }),
        (error) => error.code === 'ROOM_CAPACITY_REACHED' && error.message.includes('1'),
    );
    await manager.allocate({
        sourceMapId: '11111111111111111111',
        targetMapId: '33333333333333333333',
        subjectIds: ['player-c'],
    });
    now += 101;
    assert.deepEqual(await manager.collectIdle(), [first.serverId]);
    assert.deepEqual(stops, [first.serverId]);
});

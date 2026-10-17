import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';

import { createApiTransport } from '../electron/network/api-transport';
import { createPublicImageTransport } from '../electron/network/public-image-transport';
import { validateDescriptor } from '../electron/security/package-descriptor';
import { createSignedPackageFixture } from '../electron/testing/signed-package-fixture';
import { makeGameUrl } from '../electron/runtime/game-window-manager';
import { createPlayerApi } from '../src/api/player-api';
import { prepareMapLaunch } from '../src/features/maps/launch-flow';

test('connects, signs in, loads covers and prepares a signed map through separate service prefixes', async (context) => {
    const { descriptor, trustedKey } = createSignedPackageFixture(Buffer.from('map resource'));
    const paths:string[] = [];
    let origin = '';
    const server = http.createServer(async (request, response) => {
        const route = request.url || '';
        paths.push(route);
        response.setHeader('content-type', 'application/json');
        const json = (value:unknown, status = 200) => {
            response.statusCode = status;
            response.end(JSON.stringify(value));
        };
        if (route === '/abc/api/health-check') {
            return json({ status: 'ok', runtime: 'ready' });
        }
        if (route === '/abc/api/player-launcher/bootstrap') {
            return json({
                protocolVersion: 1,
                serverName: 'Fixture',
                loginRequired: true,
                loginApiUrl: `${origin}/lsjixs/api/auth/login`,
                signingKey: trustedKey,
            });
        }
        if (route === '/lsjixs/api/auth/login' && request.method === 'POST') {
            let body = '';
            for await (const chunk of request) {
                body += chunk;
            }
            if (JSON.parse(body).username !== 'fixture') {
                return json({ message: 'Invalid login' }, 401);
            }
            response.setHeader(
                'set-cookie',
                'box_local_player_session=fixture; Path=/lsjixs; HttpOnly',
            );
            return json({ player: { username: 'fixture' } });
        }
        if (route === '/lsjixs/api/auth/logout') {
            response.setHeader('set-cookie', 'box_local_player_session=; Max-Age=0; Path=/lsjixs');
            return json({});
        }
        if (route === '/abc/runtime/play/town/block/QmCover.png') {
            response.setHeader('content-type', 'image/png');
            return response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
        if (!request.headers.cookie?.includes('box_local_player_session=fixture')) {
            return json({ message: 'AUTH_REQUIRED' }, 401);
        }
        if (route === '/lsjixs/api/auth/session') {
            return json({ player: { username: 'fixture' } });
        }
        if (route === '/abc/api/player-launcher/maps') {
            return json({
                worlds: [
                    {
                        publicId: 'town',
                        permanentMapId: 'map-one',
                        name: 'Town',
                        cover: 'QmCover.png',
                    },
                ],
            });
        }
        if (route === '/abc/api/play-library') {
            return json({ entries: [] });
        }
        if (route === '/abc/api/player-launcher/maps/town/descriptor') {
            return json(descriptor);
        }
        if (route === '/abc/api/player-launcher/maps/town/download-plan') {
            return json({ ticket: 'fixture.signature', manifestDigest: descriptor.manifestDigest });
        }
        return json({ message: 'Not found' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => {
        server.closeAllConnections();
        server.close();
    });
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const endpoint = `${origin}/abc`;
    const transport = createApiTransport();
    const images = createPublicImageTransport();
    const api = createPlayerApi({
        isNative: () => true,
        invoke: async (command, payload) => {
            if (command === 'api_request') {
                return transport.request(payload.request);
            }
            if (command === 'fetch_public_image') {
                return images.fetch(payload.endpoint, payload.url);
            }
            if (command === 'verify_map_descriptor') {
                return validateDescriptor(payload.descriptor, payload.trustedSigningKey);
            }
            if (command === 'remember_maps') {
                return;
            }
            throw new Error(`Unexpected command ${command}`);
        },
    });
    await api.verifyServer(endpoint);
    const bootstrap = await api.readBootstrap(endpoint);
    assert.equal((await api.readSession(endpoint, bootstrap)).response.status, 401);
    assert.equal((await api.login(endpoint, bootstrap, 'fixture', 'fixture')).response.status, 200);
    assert.equal((await api.readSession(endpoint, bootstrap)).response.status, 200);
    assert.equal(
        (await api.getMaps(endpoint)).data.worlds[0].cover,
        'data:image/png;base64,iVBORw==',
    );
    assert.equal(
        (await api.updateLibrary(endpoint, 'town', { favorite: true })).response.status,
        200,
    );
    const record = { id: 'fixture', name: 'Fixture', endpoint };
    const launch = await prepareMapLaunch({
        server: record,
        mapId: 'town',
        bootstrap,
        remoteApi: api,
    });
    assert.equal(
        makeGameUrl(record, launch.descriptor, launch.launchTicket).pathname,
        '/abc/p/town',
    );
    await api.logout(endpoint, bootstrap);
    assert.equal((await api.readSession(endpoint, bootstrap)).response.status, 401);
    assert.ok(paths.every((value) => value.startsWith('/abc/') || value.startsWith('/lsjixs/')));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPublicImageTransport, validatePublicImageUrl } from './public-image-transport';

test('loads only public cover paths and converts image bytes for the file-based launcher', async () => {
    let requestedUrl = '';
    const transport = createPublicImageTransport({
        fetchImpl: async (input, init) => {
            requestedUrl = String(input);
            assert.equal(init?.method, 'GET');
            assert.equal(new Headers(init?.headers).has('cookie'), false);
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
                status: 200,
                headers: {
                    'content-type': 'image/png',
                    'cross-origin-resource-policy': 'same-origin',
                },
            });
        },
    });

    const cover = await transport.fetch(
        'http://127.0.0.1:3121',
        'http://127.0.0.1:3121/map-templates/blank-template.png',
    );
    assert.equal(requestedUrl, 'http://127.0.0.1:3121/map-templates/blank-template.png');
    assert.equal(cover, 'data:image/png;base64,iVBORw==');
});

test('allows map block images but rejects arbitrary server paths and other origins', async () => {
    let fetchCount = 0;
    const transport = createPublicImageTransport({
        fetchImpl: async () => {
            fetchCount += 1;
            return new Response(new Uint8Array([1]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
            });
        },
    });

    await assert.doesNotReject(() =>
        transport.fetch(
            'http://127.0.0.1:3121',
            'http://127.0.0.1:3121/runtime/play/map-one/block/QmCover.webp',
        ),
    );
    await assert.rejects(
        () => transport.fetch('http://127.0.0.1:3121', 'http://127.0.0.1:3121/api/admin/secrets'),
        /不在允许范围内/,
    );
    await assert.rejects(
        () =>
            transport.fetch(
                'http://127.0.0.1:3121',
                'http://127.0.0.2:3121/map-templates/blank-template.png',
            ),
        /不在允许范围内/,
    );
    assert.equal(fetchCount, 1);
});

test('rejects non-image responses instead of embedding server error pages', async () => {
    const transport = createPublicImageTransport({
        fetchImpl: async () =>
            new Response('<html>not an image</html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            }),
    });

    await assert.rejects(
        () =>
            transport.fetch(
                'http://127.0.0.1:3121',
                'http://127.0.0.1:3121/map-templates/blank-template.png',
            ),
        /格式不受支持/,
    );
});

test('cover requests stay within the exact configured service prefix', () => {
    const endpoint = new URL('http://engine.test/abc');
    assert.equal(
        validatePublicImageUrl(endpoint, 'http://engine.test/abc/map-templates/blank-template.png')
            .pathname,
        '/abc/map-templates/blank-template.png',
    );
    for (const prefix of ['/xyz', '/abcdef', '']) {
        assert.throws(
            () =>
                validatePublicImageUrl(
                    endpoint,
                    `http://engine.test${prefix}/map-templates/blank-template.png`,
                ),
            /不在允许范围内/,
        );
    }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_ASSET_BYTES, validateDescriptor, verifyHashBytes } from './package-descriptor';
import { createSignedPackageFixture } from '../testing/signed-package-fixture';

function signedFixture() {
    return createSignedPackageFixture(Buffer.from('asset'), {
        mapId: 'map_01',
        releaseVersion: '1.0.0',
        contentType: 'image/png',
    });
}

test('verifies canonical descriptor digest and ES256 signature', () => {
    const fixture = signedFixture();
    assert.equal(validateDescriptor(fixture.descriptor, fixture.trustedKey).accessId, 'town');
    assert.equal(
        verifyHashBytes(fixture.descriptor.required[0].hash, Buffer.from('asset'), 5),
        true,
    );
    assert.equal(
        verifyHashBytes(fixture.descriptor.required[0].hash, Buffer.from('altered'), 5),
        false,
    );
});

test('rejects tampered fields, untrusted keys and duplicate content hashes', () => {
    const tampered = signedFixture();
    tampered.descriptor.releaseVersion = '2.0.0';
    assert.throws(
        () => validateDescriptor(tampered.descriptor, tampered.trustedKey),
        /摘要校验失败/,
    );

    const untrusted = signedFixture();
    untrusted.trustedKey.keyId = 'other-key';
    assert.throws(() => validateDescriptor(untrusted.descriptor, untrusted.trustedKey), /不匹配/);

    const duplicate = signedFixture();
    duplicate.descriptor.optional.push({ ...duplicate.descriptor.required[0] });
    assert.throws(() => validateDescriptor(duplicate.descriptor, duplicate.trustedKey), /重复资源/);
});

test('accepts a signed empty static resource and verifies its exact bytes', () => {
    const fixture = createSignedPackageFixture(Buffer.alloc(0));
    assert.equal(validateDescriptor(fixture.descriptor, fixture.trustedKey).required[0].size, 0);
    assert.equal(verifyHashBytes(fixture.descriptor.required[0].hash, Buffer.alloc(0), 0), true);
    assert.equal(verifyHashBytes(fixture.descriptor.required[0].hash, Buffer.from('x'), 0), false);
});

test('still rejects invalid sizes, unsupported kinds and malformed MIME types', () => {
    for (const size of [-1, 0.5, NaN, Infinity, MAX_ASSET_BYTES + 1]) {
        const fixture = signedFixture();
        fixture.descriptor.required[0].size = size;
        assert.throws(
            () => validateDescriptor(fixture.descriptor, fixture.trustedKey),
            /无效或不受支持的资源/,
        );
    }
    const invalidKind = signedFixture();
    Object.assign(invalidKind.descriptor.required[0], { kind: 'script' });
    assert.throws(
        () => validateDescriptor(invalidKind.descriptor, invalidKind.trustedKey),
        /无效或不受支持的资源/,
    );

    const invalidMime = signedFixture();
    invalidMime.descriptor.required[0].contentType = 'image/png\r\nX-Injected: true';
    assert.throws(
        () => validateDescriptor(invalidMime.descriptor, invalidMime.trustedKey),
        /无效或不受支持的资源/,
    );

    const invalidSignature = createSignedPackageFixture(Buffer.alloc(0));
    invalidSignature.descriptor.signature.value = Buffer.alloc(64).toString('base64url');
    assert.throws(
        () => validateDescriptor(invalidSignature.descriptor, invalidSignature.trustedKey),
        /签名校验失败/,
    );
});

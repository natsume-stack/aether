import * as crypto from 'node:crypto';

import type { PackageDescriptor, TrustedSigningKey } from '../types';

export interface SignedPackageFixture {
    descriptor:PackageDescriptor;
    trustedKey:TrustedSigningKey;
}

export function createSignedPackageFixture(
    content:Buffer,
    options:{
        mapId?:string;
        accessId?:string;
        releaseVersion?:string;
        contentType?:string;
    } = {},
):SignedPackageFixture {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });
    const publicKeyJwk = publicKey.export({
        format: 'jwk',
    }) as PackageDescriptor['signature']['publicKey'];
    const payload = {
        formatVersion: 1 as const,
        permanentMapId: options.mapId || 'map-one',
        accessId: options.accessId || 'town',
        releaseVersion: options.releaseVersion || 'v1',
        required: [
            {
                hash: crypto.createHash('sha256').update(content).digest('base64url'),
                size: content.byteLength,
                kind: 'static' as const,
                contentType: options.contentType || 'application/octet-stream',
            },
        ],
        optional: [],
    };
    const manifestDigest = crypto
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('base64url');
    const signedPayload = { ...payload, manifestDigest };
    const value = crypto
        .sign('sha256', Buffer.from(JSON.stringify(signedPayload)), {
            key: privateKey,
            dsaEncoding: 'ieee-p1363',
        })
        .toString('base64url');
    const descriptor:PackageDescriptor = {
        ...signedPayload,
        signature: { algorithm: 'ES256', keyId: 'fixture-key', publicKey: publicKeyJwk, value },
    };
    return {
        descriptor,
        trustedKey: { keyId: 'fixture-key', publicKey: publicKeyJwk },
    };
}

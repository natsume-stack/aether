const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
    issueModerationRuntimeToken,
    verifyModerationRuntimeToken,
} = require('../packages/utils/build/moderation-runtime-auth');
const { createModerationCredential } = require('../apps/local-engine/src/moderation-credential');
const secret = 'test-only-moderation-signing-secret';
const identity = { mapId: 'test-map', runtimeId: 'test-map-room', mode: 'play' };
test('runtime tokens are purpose-bound, signed and expire after five minutes', () => {
    const now = Date.now(),
        token = issueModerationRuntimeToken(identity, secret, now);
    assert.deepEqual(verifyModerationRuntimeToken(token, secret, now), {
        ...identity,
        issuedAt: now,
        expiresAt: now + 300000,
    });
    assert.equal(verifyModerationRuntimeToken(token, secret, now + 300001), null);
    assert.equal(verifyModerationRuntimeToken(token, secret + 'other'), null);
    const parts = token.split('.'),
        body = JSON.parse(Buffer.from(parts[0], 'base64').toString());
    body.mapId = 'other-map';
    assert.equal(
        verifyModerationRuntimeToken(
            Buffer.from(JSON.stringify(body)).toString('base64') + '.' + parts[1],
            secret,
        ),
        null,
    );
});
test('game children receive a private credential file, never the signing secret', () => {
    const grant = createModerationCredential(
        {
            BOX_WORLD_PERMANENT_MAP_ID: 'test-map',
            SERVER_ID: 'test-map-room',
            MODE: 'play',
            BOX_MODERATION_SIGNING_SECRET: secret,
        },
        secret,
    );
    const file = grant.env.BOX_MODERATION_CREDENTIAL_PATH;
    try {
        assert.equal(grant.env.BOX_MODERATION_SIGNING_SECRET, undefined);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(
            verifyModerationRuntimeToken(fs.readFileSync(file, 'utf8'), secret).mapId,
            'test-map',
        );
    } finally {
        grant.close();
    }
    assert.equal(fs.existsSync(file), false);
});

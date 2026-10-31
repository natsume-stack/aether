const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createPlayerUserKey,
    signRuntimePlayerIdentity,
    verifyRuntimePlayerIdentity,
} = require('../packages/utils/build/local-player-identity');

const secret = 'test-only-player-identity-secret';
const account = {
    subjectId: '0123456789abcdef0123456789abcdef',
    userId: '42',
    username: 'local_player',
    boxId: 'legacy_box_player',
    displayName: '本地玩家',
    avatar: '',
    avatarSkinId: 'explorer',
    userKey: '',
    creatorAccess: false,
    creatorPermissions: [],
    creatorCliPermissions: [],
    role: 'player',
    status: 'active',
};

test('runtime identity assertion round-trips registered account fields', () => {
    const now = Date.now();
    const assertion = signRuntimePlayerIdentity(account, secret, 60_000);
    const identity = verifyRuntimePlayerIdentity(assertion, secret, now);

    assert.ok(identity);
    assert.deepEqual({ ...identity, expiresAt: 0 }, { ...account, expiresAt: 0 });
    assert.ok(identity.expiresAt > now);
});

test('tampered and expired assertions are rejected', () => {
    const assertion = signRuntimePlayerIdentity(account, secret, 5_000);
    const [payload, signature] = assertion.split('.');

    assert.equal(verifyRuntimePlayerIdentity(`${payload}x.${signature}`, secret), null);
    assert.equal(verifyRuntimePlayerIdentity(assertion, secret, Date.now() + 6_000), null);
    assert.equal(verifyRuntimePlayerIdentity(assertion, 'different-secret'), null);
});

test('userKey is stable for a registered account subject', () => {
    const first = createPlayerUserKey(account.subjectId, secret);
    const second = createPlayerUserKey(account.subjectId, secret);

    assert.equal(first, second);
    // BOX project scripts commonly use 16 characters as the authenticated
    // player discriminator. Keep the local stable key compatible with that
    // runtime contract so a registered local player is not mistaken for guest.
    assert.equal(first.length, 16);
    assert.notEqual(first, createPlayerUserKey('fedcba9876543210fedcba9876543210', secret));
});

test('anonymous runtime identities are rejected', () => {
    assert.throws(
        () =>
            signRuntimePlayerIdentity(
                {
                    ...account,
                    userId: '',
                    username: '',
                },
                secret,
            ),
        /invalid runtime player identity/,
    );
});

test('an unbound legacy Box ID is represented by an empty string', () => {
    const assertion = signRuntimePlayerIdentity({ ...account, boxId: '' }, secret, 60_000);
    const identity = verifyRuntimePlayerIdentity(assertion, secret);

    assert.ok(identity);
    assert.equal(identity.boxId, '');
});

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { scrypt } = require('node:crypto');
const ts = require('../apps/game/node_modules/typescript');
const root = path.resolve(__dirname, '../apps/game/server');
const derivePassword = promisify(scrypt);

function loader(overrides = {}) {
    const cache = new Map();
    function load(file) {
        if (cache.has(file)) {
            return cache.get(file).exports;
        }
        const module = { exports: {} };
        cache.set(file, module);
        const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            fileName: file,
        });
        const requireModule = (specifier) => {
            if (overrides[specifier]) {
                return overrides[specifier];
            }
            if (specifier.startsWith('.')) {
                return load(path.resolve(path.dirname(file), specifier + '.ts'));
            }
            return require(specifier);
        };
        new Function('require', 'module', 'exports', outputText)(
            requireModule,
            module,
            module.exports,
        );
        return module.exports;
    }
    return (name) => load(path.join(root, name + '.ts'));
}

const password = loader()('player-self-password');
async function passwordFixture({ active = true, hasSession = true, revokeFails = false } = {}) {
    const hash = await derivePassword('old-password-123', 'old-salt', 64);
    let account = {
        password_salt: 'old-salt',
        password_hash: hash.toString('base64url'),
        status: active ? 'active' : 'banned',
    };
    let sessions = 2,
        snapshot;
    const calls = [],
        revocations = [];
    let released = false;
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === 'BEGIN') {
                snapshot = { account: { ...account }, sessions };
            }
            if (sql === 'ROLLBACK') {
                account = snapshot.account;
                sessions = snapshot.sessions;
            }
            if (/SELECT password_salt/.test(sql)) {
                return { rows: [{ ...account }] };
            }
            if (/SELECT 1 FROM sessions/.test(sql)) {
                return { rows: hasSession ? [{}] : [] };
            }
            if (/UPDATE users SET password_salt/.test(sql)) {
                account.password_salt = params[1];
                account.password_hash = params[2];
            }
            if (/DELETE FROM sessions/.test(sql)) {
                const count = sessions;
                sessions = 0;
                return { rowCount: count };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            released = true;
        },
    };
    return {
        calls,
        revocations,
        context: {
            database: { connect: async () => client },
            usersTable: 'users',
            sessionsTable: 'sessions',
            subjectId: 'current-player',
            sessionHash: 'current-session-hash',
            absoluteSessionDays: 30,
            derivePassword: (value, salt) => derivePassword(value, salt, 64),
            publishRevocation: async (transaction, count) => {
                assert.equal(transaction, client);
                if (revokeFails) {
                    throw new Error('audit failed');
                }
                revocations.push(count);
            },
        },
        get account() {
            return account;
        },
        get sessions() {
            return sessions;
        },
        get released() {
            return released;
        },
    };
}

test('password changes verify the old credential under account/session locks and revoke all sessions atomically', async () => {
    const fixture = await passwordFixture();
    const result = await password.changeSelfPassword(fixture.context, {
        currentPassword: 'old-password-123',
        newPassword: 'new-password-456',
    });
    assert.deepEqual(result, { changed: true, reloginRequired: true });
    const expected = await derivePassword('new-password-456', fixture.account.password_salt, 64);
    assert.equal(fixture.account.password_hash, expected.toString('base64url'));
    assert.notEqual(fixture.account.password_salt, 'old-salt');
    assert.equal(fixture.sessions, 0);
    assert.deepEqual(fixture.revocations, [2]);
    const selects = fixture.calls.filter((call) => /SELECT/.test(call.sql));
    assert.ok(selects.every((call) => /FOR UPDATE/.test(call.sql)));
    assert.deepEqual(selects[1].params, ['current-session-hash', 'current-player']);
    assert.equal(fixture.calls.at(-1).sql, 'COMMIT');
    assert.equal(fixture.released, true);
});

test('wrong passwords, revoked sessions, bans and revocation failures cannot commit a password update', async () => {
    for (const [options, currentPassword, error] of [
        [{}, 'wrong-password', /原密码不正确/],
        [{ hasSession: false }, 'old-password-123', /登录状态已失效/],
        [{ active: false }, 'old-password-123', /账号当前不可用/],
        [{ revokeFails: true }, 'old-password-123', /audit failed/],
    ]) {
        const fixture = await passwordFixture(options);
        const oldHash = fixture.account.password_hash;
        await assert.rejects(
            password.changeSelfPassword(fixture.context, {
                currentPassword,
                newPassword: 'new-password-456',
            }),
            error,
        );
        assert.equal(fixture.account.password_hash, oldHash);
        assert.equal(fixture.sessions, 2);
        assert.equal(fixture.calls.at(-1).sql, 'ROLLBACK');
        assert.equal(fixture.released, true);
    }
});

test('a login verified before a concurrent password change must recheck the newly locked credential', async () => {
    const fixture = await passwordFixture();
    const previouslyVerified = { ...fixture.account };
    await password.changeSelfPassword(fixture.context, {
        currentPassword: 'old-password-123',
        newPassword: 'new-password-456',
    });
    const derive = (value, salt) => derivePassword(value, salt, 64);
    assert.equal(
        await password.verifyLockedLoginPassword(
            fixture.account,
            previouslyVerified,
            'old-password-123',
            derive,
        ),
        false,
    );
    assert.equal(
        await password.verifyLockedLoginPassword(
            fixture.account,
            previouslyVerified,
            'new-password-456',
            derive,
        ),
        true,
    );
});

function response() {
    return {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        end() {
            return this;
        },
    };
}

test('self-service HTTP handlers require service credentials and a current player session, reject avatar/identity fields and limit password attempts', async () => {
    const saved = { ...process.env };
    process.env.BOX_DEPLOYMENT_MODE = 'player-service';
    process.env.BOX_PLAYER_AUTH_API_KEY = 'fixture-service-key-12345';
    process.env.BOX_PLAYER_AUTH_ALLOWED_ORIGINS = 'http://auth.example.test';
    let missingSession = false,
        banned = false,
        limited = false,
        updates = 0;
    const identity = {
        // The mocked module must expose the constructor used by punishment response checks.
        PlayerBannedError: class extends Error {},
        resolvePlayerIdentity: async () => {
            if (missingSession) {
                throw new Error('AUTH_REQUIRED');
            }
            return { subjectId: 'current-player', status: banned ? 'banned' : 'active' };
        },
        consumePersistentAuthRateLimit: async () => ({ allowed: !limited, retryAfterSeconds: 60 }),
        updateCurrentPlayerProfile: async (req, res, values) => {
            updates++;
            assert.deepEqual(values, { displayName: '新昵称' });
            return {
                subjectId: 'current-player',
                userId: '42',
                username: 'tester',
                displayName: values.displayName,
                avatarSkinId: 'ignored',
                adminPermissions: ['ignored'],
            };
        },
        changeCurrentPlayerPassword: async () => ({ changed: true, reloginRequired: true }),
    };
    const api = loader({ './local-player-identity': identity })('player-self-service-handler');
    const request = (body, method = 'PATCH') => ({
        body,
        method,
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
            'origin': 'http://auth.example.test',
            'x-box-player-auth-key': 'fixture-service-key-12345',
        },
    });
    try {
        for (const extra of [
            { avatar: 'value' },
            { avatarSkinId: 'pilot' },
            { subjectId: 'other-player' },
            { role: 'admin' },
        ]) {
            const res = response();
            await api.handlePlayerSelfService(
                request({ displayName: '新昵称', ...extra }),
                res,
                'profile',
            );
            assert.equal(res.statusCode, 400);
        }
        assert.equal(updates, 0);
        const invalidKey = request({ displayName: '新昵称' });
        invalidKey.headers['x-box-player-auth-key'] = 'wrong';
        const denied = response();
        await api.handlePlayerSelfService(invalidKey, denied, 'profile');
        assert.equal(denied.statusCode, 401);
        const crossOrigin = request({ displayName: '新昵称' });
        crossOrigin.headers.origin = 'http://attacker.test';
        const forbidden = response();
        await api.handlePlayerSelfService(crossOrigin, forbidden, 'profile');
        assert.equal(forbidden.statusCode, 403);
        missingSession = true;
        const unauthenticated = response();
        await api.handlePlayerSelfService(
            request({ displayName: '新昵称' }),
            unauthenticated,
            'profile',
        );
        assert.equal(unauthenticated.statusCode, 401);
        missingSession = false;
        banned = true;
        const blocked = response();
        await api.handlePlayerSelfService(request({ displayName: '新昵称' }), blocked, 'profile');
        assert.equal(blocked.statusCode, 403);
        banned = false;
        const updated = response();
        await api.handlePlayerSelfService(
            request({ displayName: '  新昵称  ' }),
            updated,
            'profile',
        );
        assert.deepEqual(updated.body, {
            player: {
                subjectId: 'current-player',
                userId: '42',
                username: 'tester',
                displayName: '新昵称',
            },
        });
        limited = true;
        const throttled = response();
        await api.handlePlayerSelfService(
            request(
                { currentPassword: 'old-password-123', newPassword: 'new-password-456' },
                'POST',
            ),
            throttled,
            'password',
        );
        assert.equal(throttled.statusCode, 429);
        assert.equal(throttled.headers['Retry-After'], '60');
        const preflight = response();
        await api.handlePlayerSelfService(request(undefined, 'OPTIONS'), preflight, 'profile');
        assert.equal(preflight.statusCode, 204);
        assert.match(preflight.headers['Access-Control-Allow-Methods'], /PATCH/);
    } finally {
        for (const key of Object.keys(process.env)) {
            if (!(key in saved)) {
                delete process.env[key];
            }
        }
        Object.assign(process.env, saved);
    }
});

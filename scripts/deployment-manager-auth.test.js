'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixture } = require('./lib/deployment-manager-ui-fixture');

function loginEvent() {
    return {
        preventDefault() {},
        currentTarget: { values: [['token', 'fixture-manager-token']] },
    };
}

test('valid Web manager login opens the overview before slow metadata requests finish', async () => {
    const app = await createFixture({ webManager: true });
    let releaseAbout;
    app.results.get_about_info = () =>
        new Promise((resolve) => {
            releaseAbout = resolve;
        });
    const login = app.api.submitWebManagerToken(loginEvent());
    await new Promise((resolve) => setImmediate(resolve));
    try {
        assert.equal(app.api.state.page, 'overview');
        assert.ok(
            !app.html.includes('web-login-form'),
            'validated login must not remain on the login screen while loading metadata',
        );
        assert.match(app.html, /服务总览/);
        assert.equal(app.api.state.status.dockerReady, true);
    } finally {
        releaseAbout({});
        await login;
    }
});

test('invalid Web manager token stays at the login gate', async () => {
    const app = await createFixture({ webManager: true });
    app.results.get_system_status = () => {
        throw new Error('管理密钥无效');
    };
    await app.api.submitWebManagerToken(loginEvent());
    assert.equal(app.api.state.page, 'web-login');
    assert.equal(app.context.managerToken, '');
    assert.match(app.html, /web-login-form/);
    assert.equal(app.document.querySelector('#web-login-error').textContent, '管理密钥无效');
});

test('a saved valid token renders the overview while startup metadata is still loading', async () => {
    let releaseAbout;
    const app = await createFixture({
        webManager: true,
        token: 'fixture-manager-token',
        responses: {
            get_about_info: () =>
                new Promise((resolve) => {
                    releaseAbout = resolve;
                }),
        },
    });
    try {
        assert.equal(app.api.state.page, 'overview');
        assert.match(app.html, /服务总览/);
        assert.equal(app.api.state.status.dockerReady, true);
    } finally {
        releaseAbout({});
        await new Promise((resolve) => setImmediate(resolve));
    }
});

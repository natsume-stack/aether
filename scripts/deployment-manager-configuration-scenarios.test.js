'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFixture } = require('./lib/deployment-manager-ui-fixture');

for (const webManager of [false, true]) {
    const platform = webManager ? 'Web' : 'desktop';
    const fixture = () => createFixture({ webManager, token: 'fixture-token' });
    test(`${platform}: local fallback is not blocked by unfinished public drafts`, async () => {
        const app = await fixture();
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'network';
        app.api.state.sslLoaded = true;
        app.api.state.config.playNetworkMode = 'local';
        app.api.state.config.creatorNetworkMode = 'local';
        app.api.state.config.playPublicAddressOverride = 'https://';
        app.api.state.config.sharedPublicAddress = 'https://';
        app.api.render();
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        assert.equal(app.api.state.error, '');
        assert.equal(
            app.calls.find((call) => call.command === 'save_configuration_command').payload.config
                .playNetworkMode,
            'local',
        );
    });
    test(`${platform}: raw environment save does not apply an unsaved Nginx selection`, async () => {
        const app = await fixture();
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'environment';
        app.api.state.sslLoaded = true;
        app.api.state.sslDraft = { mode: 'managed' };
        app.api.state.nginxSelectionDirty = true;
        app.results.apply_ssl_config = { running: true };
        app.api.render();
        app.document.querySelector('#raw-environment').value = 'BOX_PLAY_NETWORK_MODE=local\n';
        await app.api.saveRawEnvironment();
        assert.equal(app.api.state.error, '');
        assert.ok(app.calls.some((call) => call.command === 'save_raw_environment'));
        assert.ok(!app.calls.some((call) => call.command === 'apply_ssl_config'));
    });
    test(`${platform}: switching certificate source keeps the section open and uses full width fields`, async () => {
        const app = await fixture();
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'network';
        app.api.state.sslLoaded = true;
        app.api.state.sslDisclosureOpen = { play: true };
        app.api.render();
        app.api.chooseCertificateInput('play', 'path');
        assert.match(app.html, /<details[^>]*data-disclosure="ssl-play"[^>]*open/);
        assert.match(app.html, /class="field no-hint"[^>]*><span>证书文件路径/);
        assert.ok(!app.html.includes('每 5 秒检查文件内容'));
        app.api.setCertificatePath('play', 'certificatePath', '/certs/my cert.pem');
        app.api.chooseCertificateInput('play', 'upload');
        app.api.chooseCertificateInput('play', 'path');
        assert.match(app.html, /value="\/certs\/my cert.pem"/);
    });
}

for (const webManager of [false, true]) {
    test(`${webManager ? 'Web' : 'desktop'}: external quick configuration and generated Nginx matrix`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'network';
        app.api.state.sslLoaded = true;
        app.api.state.sslDraft = { mode: 'external' };
        for (const mode of ['shared', 'independent']) {
            for (const protocol of ['http', 'https']) {
                app.api.state.accessMode =
                    mode === 'shared' ? 'public-shared' : 'public-independent';
                app.api.state.externalGuideProtocol = protocol;
                const config = app.api.state.config;
                config.playNetworkMode = config.creatorNetworkMode = 'public';
                config.publicAddressMode = mode;
                config.playPort = 4121;
                config.sharedPublicAddress = `${protocol}://example.test`;
                config.publicServicePaths = {
                    'play': '/play',
                    'creator': '/arena',
                    'voxa': '/voxa',
                    'player-service': '/admin',
                    'player-auth-portal': '/accounts',
                };
                for (const [field, host] of [
                    ['playPublicAddressOverride', 'play'],
                    ['creatorPublicAddressOverride', 'arena'],
                    ['voxaPublicAddressOverride', 'voxa'],
                    ['playerServicePublicAddressOverride', 'admin'],
                    ['authPortalPublicAddressOverride', 'accounts'],
                ]) {
                    config[field] = `${protocol}://${host}.example.test`;
                }
                app.api.render();
                const { content, error } = app.api.externalNginxConfiguration(config);
                assert.equal(error, '');
                assert.match(content, /proxy_pass http:\/\/127\.0\.0\.1:4121/);
                assert.equal((content.match(/server \{/g) || []).length, mode === 'shared' ? 1 : 5);
                assert.equal(content.includes('ssl_certificate'), protocol === 'https');
                assert.equal(content.includes('rewrite ^/play'), mode === 'shared');
                await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
                assert.equal(app.api.state.error, '');
                const saved = app.calls
                    .filter((call) => call.command === 'save_configuration_command')
                    .at(-1).payload.config;
                assert.equal(saved.externalNginxManual, false);
                assert.equal(saved.playPort, 4121);
                assert.equal(saved.publicAddressMode, mode);
                assert.ok(!app.calls.some((call) => call.command === 'apply_ssl_config'));
                assert.doesNotMatch(app.html, /配置步骤与排查手册/);
            }
        }
    });
    test(`${webManager ? 'Web' : 'desktop'}: saving another section preserves independent creator range`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'capacity';
        app.api.state.sslLoaded = true;
        app.api.state.config.creatorNetworkMode = 'local';
        app.api.render();
        app.api.chooseCertificateInput('play', 'path');
        assert.equal(app.api.state.config.creatorNetworkMode, 'local');
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        const config = app.calls.find((call) => call.command === 'save_configuration_command')
            .payload.config;
        assert.equal(config.creatorNetworkMode, 'local');
    });
}

for (const webManager of [false, true]) {
    test(`${webManager ? 'Web' : 'desktop'}: external Nginx retains local/LAN quick configuration`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'network';
        app.api.state.sslLoaded = true;
        app.api.state.sslDraft = { mode: 'external' };
        for (const mode of ['local', 'lan', 'public-independent', 'local']) {
            app.api.state.accessMode = mode;
            app.api.state.config.playNetworkMode = app.api.state.config.creatorNetworkMode =
                mode.startsWith('public') ? 'public' : mode;
            app.api.render();
            assert.ok(app.html.includes('name="playPort"'));
            await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
            assert.equal(app.api.state.error, '');
            const config = app.calls
                .filter((call) => call.command === 'save_configuration_command')
                .at(-1).payload.config;
            assert.equal(config.playNetworkMode, mode.startsWith('public') ? 'public' : mode);
            assert.equal(config.externalNginxManual, false);
        }
        assert.ok(
            !app.calls.some(
                (call) => call.command === 'apply_ssl_config' || call.command === 'stop_ssl_proxy',
            ),
        );
    });
}

test('local Creator links always use HTTP when Play is public HTTPS', async () => {
    const app = await createFixture();
    app.api.state.config.publicAddress = 'https://play.example.test';
    app.api.state.config.playNetworkMode = 'public';
    app.api.state.config.creatorNetworkMode = 'local';
    assert.equal(app.api.getServiceUrl('creator'), 'http://127.0.0.1:3127/');
});

test('switching to shared addresses retains a custom public port', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.config.sharedPublicAddress = '';
    app.api.state.config.playPublicAddressOverride = 'https://play.example.test:8443/worlds';
    app.api.render();
    await app.clickMode('public-shared');
    assert.equal(app.api.state.config.sharedPublicAddress, 'https://play.example.test:8443');
});

for (const webManager of [false, true]) {
    test(`${webManager ? 'Web' : 'desktop'}: local Creator drafts do not block public Play configuration`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        Object.assign(app.api.state, {
            page: 'setup',
            setupSection: 'network',
            sslLoaded: true,
            sslDraft: { mode: 'external' },
        });
        Object.assign(app.api.state.config, {
            playNetworkMode: 'public',
            creatorNetworkMode: 'local',
            publicAddressMode: 'independent',
            playPublicAddressOverride: 'https://play.example.test',
            creatorPublicAddressOverride: 'https://',
            voxaPublicAddressOverride: 'https://',
        });
        const generated = app.api.externalNginxConfiguration(app.api.state.config);
        assert.equal(generated.error, '');
        assert.match(generated.content, /server_name play.example.test/);
        assert.ok(!generated.content.includes('127.0.0.1:3127'));
        app.api.render();
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        assert.equal(app.api.state.error, '');
        const saved = app.calls.find((call) => call.command === 'save_configuration_command')
            .payload.config;
        assert.equal(saved.creatorNetworkMode, 'local');
        assert.equal(saved.creatorPublicAddressOverride, 'https://');
    });
}

for (const webManager of [false, true]) {
    const platform = webManager ? 'Web' : 'desktop';
    const externalDialogFixture = async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        Object.assign(app.api.state, {
            page: 'setup',
            setupSection: 'network',
            sslLoaded: true,
            sslDraft: { mode: 'external' },
        });
        app.api.render();
        return app;
    };
    test(`${platform}: external Nginx text opens after saving and can be reopened without a permanent card`, async () => {
        const app = await externalDialogFixture();
        assert.ok(!app.html.includes('id="external-example-nginx"'));
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        assert.ok(app.api.state.externalNginxDialog);
        assert.match(
            app.html,
            /role="dialog" aria-modal="true" aria-labelledby="external-nginx-title"/,
        );
        assert.match(app.html, /proxy_pass http:\/\/127\.0\.0\.1:3121/);
        app.api.closeExternalNginxDialog();
        assert.equal(app.api.state.externalNginxDialog, null);
        assert.ok(!app.html.includes('id="external-example-nginx"'));
        app.api.openExternalNginxDialog();
        assert.match(app.html, /复制配置/);
    });
    test(`${platform}: saved external configuration opens its text alongside an application error`, async () => {
        const app = await externalDialogFixture();
        app.api.state.nginxSelectionDirty = true;
        app.results.set_nginx_provider = () => {
            throw new Error('无法切换 Nginx');
        };
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        assert.match(app.api.state.error, /配置已保存，但后续应用失败/);
        assert.match(app.api.state.externalNginxDialog.message, /无法切换 Nginx/);
        assert.match(app.api.state.externalNginxDialog.content, /server_name play.example.test/);
    });
    test(`${platform}: rejected external settings do not suggest applying an unsaved configuration`, async () => {
        const app = await externalDialogFixture();
        app.results.save_configuration_command = () => {
            throw new Error('保存失败');
        };
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        assert.equal(app.api.state.externalNginxDialog, null);
        assert.ok(!app.html.includes('id="external-example-nginx"'));
    });
}

test('invalid advanced configuration expands its disclosure before focusing the field', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'capacity';
    app.api.state.config.databaseMode = 'external';
    app.api.render();
    const disclosure = { open: false, parentElement: null };
    let focused = false;
    const target = {
        closest: () => disclosure,
        focus: () => {
            assert.equal(disclosure.open, true);
            focused = true;
        },
        reportValidity() {},
    };
    const originalQuery = app.document.querySelector.bind(app.document);
    app.document.querySelector = (selector) =>
        selector === '#setup-form [name="databasePoolSize"]' ? target : originalQuery(selector);
    const invalid = {
        name: 'databasePoolSize',
        min: '1',
        max: '100',
        validity: { valueMissing: false },
        closest: (selector) =>
            selector === '[data-setup-panel]'
                ? { dataset: { setupPanel: 'data' } }
                : { querySelector: () => ({ textContent: '每运行时连接池' }) },
    };
    assert.equal(app.api.revealInvalidSetupField({ querySelector: () => invalid }), true);
    assert.equal(app.api.state.setupSection, 'data');
    assert.equal(focused, true);
});

for (const webManager of [false, true]) {
    test(`${webManager ? 'Web' : 'desktop'}: collapsed advanced fields remain part of saved configuration`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        app.api.state.page = 'setup';
        app.api.state.setupSection = 'data';
        app.api.state.sslLoaded = true;
        Object.assign(app.api.state.config, {
            databaseMode: 'external',
            databaseHost: 'db.example.test',
            databaseName: 'box',
            databaseUser: 'box',
            databasePoolSize: 16,
            redisMode: 'external',
            redisHost: 'cache.example.test',
            redisDb: 3,
            storageCacheRedisDb: 4,
            storageCacheRedisTtl: 180,
            playNetworkMode: 'local',
            creatorNetworkMode: 'local',
        });
        app.api.render();
        assert.match(app.html, /data-disclosure="database-advanced"><summary>/);
        await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
        assert.equal(app.api.state.error, '');
        const saved = app.calls.find((call) => call.command === 'save_configuration_command')
            .payload.config;
        assert.equal(saved.databasePoolSize, 16);
        assert.equal(saved.redisDb, 3);
        assert.equal(saved.storageCacheRedisDb, 4);
        assert.equal(saved.storageCacheRedisTtl, 180);
    });
}

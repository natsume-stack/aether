'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFixture } = require('./lib/deployment-manager-ui-fixture');

test('desktop renders its shell while Docker status is pending', async () => {
    const app = await createFixture({
        responses: { get_system_status: () => new Promise(() => {}) },
    });
    assert.ok(app.html.includes('class="shell'), 'startup must render before waiting for Docker');
});

test('overview hides owner credentials until a game environment is running', async () => {
    const app = await createFixture();
    app.api.state.config.hasPlayAdminToken = true;
    for (const status of [
        null,
        { dockerReady: false, configured: false },
        { dockerReady: true, configured: true, services: [] },
        {
            dockerReady: true,
            configured: true,
            services: [{ name: 'managed-postgres', running: true }],
        },
    ]) {
        app.api.state.status = status;
        app.api.render();
        assert.ok(!app.html.includes('aria-label="服主密钥"'));
        if (!status?.dockerReady) {
            assert.ok(!app.html.includes('尚未配置'));
        }
    }
    app.api.state.status = {
        dockerReady: true,
        configured: true,
        services: [{ name: 'play', running: true }],
    };
    app.api.render();
    assert.ok(app.html.includes('aria-label="服主密钥"'));
    app.api.state.config.hasPlayAdminToken = false;
    app.api.state.ownerSecrets = {};
    app.api.render();
    assert.ok(!app.html.includes('aria-label="服主密钥"'));
});

test('SSL settings render expiry and escaped domains without exposing private keys', async () => {
    const app = await createFixture();
    app.api.state.sslFiles = {
        privateKey: 'SECRET_PRIVATE_KEY_FIXTURE',
        certificateName: 'chain.pem',
        keyName: 'private.key',
    };
    app.api.state.sslStatus = {
        running: true,
        config: { certificateExpiries: { play: '2020-01-01T00:00:00Z' } },
    };
    app.api.state.sslDraft = {
        mode: 'managed',
        httpsPort: 443,
        routes: [{ service: 'play', domain: '<script>fixture</script>' }],
    };
    app.api.state.config.playPublicAddressOverride = 'https://play.example.test';
    const html = app.api.setup();
    assert.ok(html.includes('已过期'));
    assert.ok(html.includes('已有外部 Nginx'));
    assert.ok(!html.includes('ssl-domain-play'));
    assert.ok(!html.includes('SECRET_PRIVATE_KEY_FIXTURE'));
    assert.ok(!html.includes('<script>fixture'));
});

test('about page keeps independent section spacing for its four cards', async () => {
    const css = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../apps/deployment-manager/src/styles/about.css'),
        'utf8',
    );
    const layout = css.match(/\.about-page\s*\{([^}]+)\}/)?.[1] || '';
    assert.match(layout, /display:\s*grid\s*;/);
    assert.match(layout, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    assert.match(layout, /gap:\s*16px\s*;/);
    const app = await createFixture();
    app.api.state.page = 'about';
    app.api.render();
    assert.equal((app.html.match(/<article class="about-/g) || []).length, 4);
});

test('about page lists the latest engine release first without player launcher notes', async () => {
    const app = await createFixture();
    app.api.state.page = 'about';
    app.api.render();
    const notes = app.html.slice(app.html.indexOf('about-changelog-list'));
    const version = require('../package.json').version;
    assert.ok(notes.includes(`v${version}`));
    const versions = require('../distribution/release-notes.json').map(
        (release) => release.version,
    );
    assert.equal(new Set(versions).size, versions.length);
    let previous = -1;
    for (const releaseVersion of versions) {
        const position = notes.indexOf(`<strong>v${releaseVersion}</strong>`);
        assert.ok(position > previous, `missing or unordered release: ${releaseVersion}`);
        previous = position;
    }
    for (const feature of ['玩家与地图', '反作弊', '登录页面', '速度缩放', '实时同步与体验']) {
        assert.ok(notes.includes(feature), `missing release note: ${feature}`);
    }
    assert.ok(!notes.includes('玩家启动器'));
    assert.equal(
        require('../apps/deployment-manager/package.json').version,
        require('../package.json').version,
    );
});

test('native bootstrap loads the console; unauthenticated Web bootstrap shows the login gate', async () => {
    const native = await createFixture();
    assert.equal(native.api.state.page, 'overview');
    assert.match(native.html, /服务总览/);
    assert.ok(native.calls.some((call) => call.command === 'get_install_config'));
    assert.ok(native.context.progressListeners.has('install-progress'));
    const web = await createFixture({ webManager: true });
    assert.equal(web.api.state.page, 'web-login');
    assert.match(web.html, /web-login-form/);
    assert.equal(web.calls.length, 0);
});

test('all pages render through the module renderer and preserve scroll on same-page updates', async () => {
    const app = await createFixture();
    app.api.state.performance = { services: [] };
    app.api.state.projectRuntimesLoaded = true;
    for (const [page, marker] of [
        ['overview', '服务总览'],
        ['setup', 'setup-form'],
        ['backups', '立即备份'],
        ['runtimes', '地图容器管理'],
        ['performance', '性能监控'],
        ['about', 'about-page'],
        ['web-login', 'web-login-form'],
    ]) {
        app.api.state.page = page;
        app.api.render();
        assert.ok(app.html.includes(marker), `page ${page} did not render`);
    }
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.render();
    app.document.querySelector('main').scrollTop = 120;
    app.document.querySelector('.setup-panels').scrollTop = 250;
    app.api.render();
    assert.equal(app.document.querySelector('main').scrollTop, 120);
    assert.equal(app.document.querySelector('.setup-panels').scrollTop, 250);
});

test('public address edits and service overrides survive local/LAN/public event transitions', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.render();
    app.api.state.config.publicAddress = 'https://changed.example.test';
    app.form.setValue('playPublicAddressOverride', 'http://play.example.test:4121');
    await app.clickMode('local');
    assert.equal(app.api.state.config.publicAddress, 'https://changed.example.test');
    assert.equal(app.api.getServiceUrl('play'), 'http://127.0.0.1:3121/');
    assert.equal(app.form.values.get('publicAddress'), undefined);
    await app.clickMode('lan');
    assert.equal(app.api.getServiceUrl('play'), 'http://192.168.1.20:3121/');
    await app.clickMode('public');
    assert.equal(app.form.values.get('publicAddress'), undefined);
    assert.equal(app.form.values.get('playPublicAddressOverride'), 'http://play.example.test:4121');
    assert.equal(app.api.getServiceUrl('play'), 'http://play.example.test:4121/');
    assert.equal(app.api.state.config.authPortalPublicAddressOverride, 'https://auth.example.test');
});

test('configuration submission keeps public URLs and converts numeric fields without starting services', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.render();
    app.form.setValue('playPort', '4201');
    const form = app.form;
    await app.api.saveConfiguration({ currentTarget: form, preventDefault() {} });
    const saved = app.calls.find((call) => call.command === 'save_configuration_command');
    assert.ok(saved);
    assert.equal(saved.payload.config.publicAddress, 'https://play.example.test');
    assert.equal(saved.payload.config.playPort, 4201);
    assert.equal(saved.payload.config.databasePort, '5432');
    assert.equal(saved.payload.config.playPublicAddressOverride, 'https://play.example.test');
    assert.ok(!app.calls.some((call) => call.command === 'start_services'));
    assert.equal(app.api.state.busy, false);
});

test('owner credential stays masked before and after clipboard copying', async () => {
    const app = await createFixture();
    app.api.render();
    assert.ok(!app.html.includes('private-owner-fixture'));
    await app.api.copyOwnerSecret('playAdminToken');
    assert.deepEqual(app.copied, ['private-owner-fixture']);
    assert.equal(app.api.state.ownerSecretCopied, 'playAdminToken');
    assert.ok(!app.html.includes('private-owner-fixture'));
});

test('restoring backups retains successful results and optional cleanup warnings', async () => {
    for (const warning of [null, '旧数据目录清理失败，请手动清理。']) {
        const app = await createFixture({ responses: { restore_backup: warning } });
        app.api.state.page = 'backups';
        app.api.state.backupDialog = { action: 'restore', archive: 'old.zip' };
        await app.api.confirmBackupAction();
        assert.equal(
            app.api.state.backupMessage,
            '恢复完成，请在服务总览检查并按需启动服务。' + (warning ? ` 清理提示：${warning}` : ''),
        );
        assert.equal(app.api.state.error, '');
        assert.equal(app.api.state.busy, false);
        assert.ok(
            app.calls.some(
                (call) => call.command === 'restore_backup' && call.payload.archive === 'old.zip',
            ),
        );
    }
});

test('restore offers to bring back the launcher .env only when the backup has one', async () => {
    const app = await createFixture({
        responses: {
            inspect_backup: { directories: [], files: 5, dataBytes: 20, hasEnv: true },
        },
    });
    app.api.state.page = 'backups';
    await app.api.openBackupDialog('restore', 'env-backup.tar.gz', 'env-backup.tar.gz');
    assert.match(app.html, /id="restore-backup-env"/);
    assert.match(app.html, /保留当前 \.env/);
    assert.equal(app.api.state.backupDialog.includeEnv, false);
    app.api.state.backupDialog.includeEnv = true;
    await app.api.confirmBackupAction();
    const restore = app.calls.filter((call) => call.command === 'restore_backup').at(-1);
    assert.equal(restore.payload.archive, 'env-backup.tar.gz');
    assert.equal(restore.payload.includeEnv, true);
});

test('restore dialog keeps the current .env when the backup has none', async () => {
    const app = await createFixture();
    app.api.state.page = 'backups';
    await app.api.openBackupDialog('restore', 'data.tar.gz', 'data.tar.gz');
    assert.doesNotMatch(app.html, /restore-backup-env/);
    await app.api.confirmBackupAction();
    const restore = app.calls.filter((call) => call.command === 'restore_backup').at(-1);
    assert.equal(restore.payload.includeEnv, false);
});

test('page and visibility transitions retain one appropriate polling timer', async () => {
    const app = await createFixture();
    app.api.render();
    assert.equal(app.intervals.size, 1);
    assert.equal([...app.intervals.values()][0].delay, 10000);
    app.document.hidden = true;
    await app.emitDocument('visibilitychange');
    assert.equal(app.intervals.size, 1);
    assert.equal([...app.intervals.values()][0].delay, 60000);
    app.document.hidden = false;
    app.api.state.performance = { services: [] };
    app.api.state.page = 'performance';
    app.api.render();
    assert.equal(app.intervals.size, 1);
    assert.equal([...app.intervals.values()][0].delay, 5000);
    app.api.state.page = 'setup';
    app.api.render();
    assert.equal(app.intervals.size, 0);
});

test('backup metadata is escaped at the view interface', async () => {
    const app = await createFixture();
    app.api.state.page = 'backups';
    app.api.state.backups = [
        { name: '<img src=x onerror=alert(1)>', path: 'fixture.tar', size: 1 },
    ];
    app.api.render();
    assert.ok(app.html.includes('&lt;img'));
    assert.ok(!app.html.includes('<img src=x'));
});

test('saving a changed login image refreshes only the running login container and supports restoring default', async () => {
    const app = await createFixture();
    app.api.state.status.services.push({ name: 'player-auth-portal', running: true });
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.render();
    app.results.save_configuration_command = ({ config }) => {
        app.results.get_install_config = { ...config };
    };
    app.form.setValue('authPortalImage', 'ghcr.io/owner/login:1.0');
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.config.authPortalImage, 'ghcr.io/owner/login:1.0');
    const starts = app.calls.filter((call) => call.command === 'control_service');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].payload.service, 'player-auth-portal');
    assert.equal(starts[0].payload.action, 'start');
    await app.document.querySelector('#restore-default-login-image').click();
    assert.equal(
        app.form.values.get('authPortalImage'),
        `box-local-engine-player-auth-portal:${require('../package.json').version}`,
    );
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.config.authPortalImage, '');
    assert.equal(app.calls.filter((call) => call.command === 'control_service').length, 2);
});

test('login image has its own access-settings card with the current official image and an upgrade-following default', async () => {
    const image = 'box-local-engine-player-auth-portal:v0.2.0-linux-arm64';
    const app = await createFixture({
        responses: { get_about_info: { imageTag: 'v0.2.0-linux-arm64' } },
    });
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    for (const mode of ['local', 'lan', 'public']) {
        app.api.state.accessMode = mode;
        app.api.render();
        assert.ok(app.html.includes('class="network-service-card login-image-card"'));
        assert.equal(app.form.values.get('authPortalImage'), image);
        assert.equal([...app.html.matchAll(/name="authPortalImage"/g)].length, 1);
        const accountCard = app.html.indexOf('class="network-service-card player-service-card"');
        const accountEnd = app.html.indexOf('</section>', accountCard);
        assert.ok(app.html.indexOf('class="network-service-card login-image-card"') > accountEnd);
    }
    app.api.state.status.services.push({ name: 'player-auth-portal', running: true });
    app.results.save_configuration_command = ({ config }) => {
        app.results.get_install_config = { ...config };
    };
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.config.authPortalImage, '');
    assert.ok(!app.calls.some((call) => call.command === 'control_service'));
    app.results.get_about_info = { imageTag: 'v0.3.0-linux-arm64' };
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    app.api.render();
    assert.equal(
        app.form.values.get('authPortalImage'),
        'box-local-engine-player-auth-portal:v0.3.0-linux-arm64',
    );
});

test('legacy version-only default login images are not pinned as custom Docker images', async () => {
    const version = require('../package.json').version;
    const app = await createFixture({
        responses: { get_about_info: { imageTag: `v${version}-linux-amd64` } },
    });
    app.api.state.page = 'setup';
    app.api.state.status.services.push({ name: 'player-auth-portal', running: true });
    app.api.state.setupSection = 'network';
    app.api.render();
    app.form.setValue('authPortalImage', `box-local-engine-player-auth-portal:${version}`);
    app.results.save_configuration_command = ({ config }) => {
        app.results.get_install_config = { ...config };
    };
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.config.authPortalImage, '');
    assert.ok(!app.calls.some((call) => call.command === 'control_service'));
});

test('custom login image stays editable across access-mode changes and is escaped in its standalone card', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.render();
    app.form.setValue('authPortalImage', 'my-login:1.0');
    await app.clickMode('public');
    assert.equal(app.form.values.get('authPortalImage'), 'my-login:1.0');
    await app.clickMode('local');
    assert.equal(app.form.values.get('authPortalImage'), 'my-login:1.0');
    app.results.save_configuration_command = ({ config }) => {
        app.results.get_install_config = { ...config };
    };
    app.results.get_about_info = { imageTag: 'v0.3.0-linux-arm64' };
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.config.authPortalImage, 'my-login:1.0');
    assert.equal(app.form.values.get('authPortalImage'), 'my-login:1.0');
    app.api.state.config.authPortalImage = '"/><img src=x onerror=alert(1)>';
    app.api.render();
    assert.ok(app.html.includes('&quot;/&gt;&lt;img'));
    assert.ok(!app.html.includes('<img src=x'));
});

test('login image changes remain saved when applying fails and do not start a stopped portal', async () => {
    const stopped = await createFixture();
    stopped.api.state.page = 'setup';
    stopped.api.render();
    stopped.results.save_configuration_command = ({ config }) => {
        stopped.results.get_install_config = { ...config };
    };
    stopped.form.setValue('authPortalImage', 'ghcr.io/owner/login:1.0');
    await stopped.api.saveConfiguration({ currentTarget: stopped.form, preventDefault() {} });
    assert.ok(!stopped.calls.some((call) => call.command === 'control_service'));
    assert.match(stopped.api.state.notice, /下次启动/);
    const failed = await createFixture();
    failed.api.state.status.services.push({ name: 'player-auth-portal', running: true });
    failed.api.state.page = 'setup';
    failed.api.render();
    failed.results.save_configuration_command = ({ config }) => {
        failed.results.get_install_config = { ...config };
    };
    failed.results.control_service = () => {
        throw new Error('download failed');
    };
    failed.form.setValue('authPortalImage', 'ghcr.io/owner/login:2.0');
    await failed.api.saveConfiguration({ currentTarget: failed.form, preventDefault() {} });
    assert.equal(failed.api.state.config.authPortalImage, 'ghcr.io/owner/login:2.0');
    assert.match(failed.api.state.error, /配置已保存，但后续应用失败/);
    assert.equal(failed.api.state.busy, false);
});

test('console works without activation while Web administration still requires authentication', async () => {
    const native = await createFixture();
    assert.match(native.html, /服务总览/);
    assert.ok(!native.html.includes('许可证管理'));
    assert.ok(!native.calls.some((call) => /license/.test(call.command)));
    const web = await createFixture({ webManager: true });
    web.api.state.page = 'setup';
    web.api.render();
    assert.equal(web.api.state.page, 'web-login');
    assert.match(web.html, /web-login-form/);
});

test('Nginx belongs to data services and certificates follow existing public addresses', async () => {
    const app = await createFixture();
    app.api.state.sslDraft = { mode: 'managed' };
    const html = app.api.setup();
    assert.ok(html.indexOf('<h2>Nginx</h2>') < html.indexOf('data-setup-panel="network"'));
    assert.match(html, /data-nginx-mode="external" aria-pressed="false"/);
    assert.ok(!html.includes('HTTPS 与证书管理'));
    assert.ok(!html.includes('ssl-domain-play'));
    const address = html.indexOf('name="playPublicAddressOverride"');
    assert.ok(html.indexOf('data-ssl-service="play"', address) > address);
    app.api.state.accessMode = 'local';
    assert.ok(!app.api.setup().includes('data-ssl-service="play"'));
});

test('SSL routes reuse public address precedence and ports without another domain form', async () => {
    const app = await createFixture();
    const routes = app.api.sslRoutes({
        publicAddress: 'https://shared.example.test',
        playPort: 4121,
        playPublicAddressOverride: 'https://play.example.test',
    });
    assert.equal(routes.find((route) => route.service === 'play').domain, 'play.example.test');
    assert.equal(routes.find((route) => route.service === 'play').port, 443);
    assert.equal(
        routes.find((route) => route.service === 'creator'),
        undefined,
    );
    const prefixed = app.api.sslRoutes({
        playPublicAddressOverride: 'https://host.example.test/path',
    });
    assert.equal(prefixed[0].path, '/path');
    assert.equal(prefixed[0].port, 443);
    assert.throws(
        () => app.api.sslRoutes({ playPublicAddressOverride: 'https://host.example.test/api' }),
        /保留路径/,
    );
});

test('Nginx defaults to managed and uses the Redis download/start layout', async () => {
    const app = await createFixture();
    app.api.state.sslLoaded = true;
    let html = app.api.setup();
    assert.match(html, /class="active" data-nginx-mode="managed"/);
    app.api.state.sslStatus = { provider: 'disabled' };
    html = app.api.setup();
    assert.match(html, /class="active" data-nginx-mode="managed"/);
    assert.ok(!html.includes('data-nginx-mode="disabled"'));
    assert.ok(!html.includes('id="ssl-refresh"'));
    app.api.state.sslDraft = { mode: 'managed' };
    html = app.api.setup();
    assert.match(html, /尚未安装 Nginx 最新稳定版/);
    assert.match(html, /id="nginx-download"[^>]*>立即下载/);
    app.api.state.sslStatus = { imageAvailable: true, imageVersion: '1.30.2' };
    html = app.api.setup();
    assert.match(html, /内置 Nginx 1.30.2 已下载/);
    assert.match(html, /id="nginx-enable"[^>]*>启用并启动/);
    for (const removed of ['使用本地镜像', '启动已配置入口', '停止入口', '本地已有 Nginx 镜像']) {
        assert.ok(!html.includes(removed));
    }
});

test('Nginx selection updates immediately and external selection only reads status', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslStatus = { provider: 'external', imageAvailable: false };
    app.api.state.sslBusy = true;
    const before = app.calls.length;
    app.api.chooseNginx('managed');
    assert.equal(app.api.state.sslDraft.mode, 'managed');
    assert.match(app.html, /class="active" data-nginx-mode="managed"/);
    assert.ok(!/data-nginx-mode="[^"]+"[^>]*disabled/.test(app.html));
    app.results.get_ssl_status = { provider: 'external', externalNginx: { installed: false } };
    await app.api.chooseNginx('external');
    assert.match(app.html, /class="active" data-nginx-mode="external"/);
    assert.equal(app.calls.length, before + 1);
    assert.equal(app.calls.at(-1).command, 'get_ssl_status');
    app.api.state.sslBusy = false;
    app.api.chooseNginx('managed');
    app.results.get_ssl_status = { provider: 'managed', imageAvailable: false };
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(
        app.calls.find((call) => call.command === 'set_nginx_provider').payload.mode,
        'managed',
    );
    assert.equal(app.api.state.nginxSelectionDirty, false);
});

test('public certificate sections are available for every service and default to collapsed', async () => {
    const app = await createFixture();
    app.api.state.config.publicAddress = '';
    for (const key of [
        'playPublicAddressOverride',
        'creatorPublicAddressOverride',
        'voxaPublicAddressOverride',
        'playerServicePublicAddressOverride',
        'authPortalPublicAddressOverride',
    ]) {
        app.api.state.config[key] = '';
    }
    assert.equal((app.api.setup().match(/ssl-address-certificate/g) || []).length, 5);
    app.api.state.config.playPublicAddressOverride = 'https://play.example.test';
    const html = app.api.setup();
    assert.equal((html.match(/ssl-address-certificate/g) || []).length, 5);
    assert.equal(
        (html.match(/<details class="setup-explainer ssl-address-certificate"[^>]*>/g) || [])
            .length,
        5,
    );
    assert.ok(!/<details[^>]*\bopen\b[^>]*ssl-address-certificate/.test(html));
    assert.match(html, /证书文件（.pem \/ .crt \/ .cer）/);
    assert.match(html, /证书密钥文件（.key \/ .pem）/);
    for (const removed of ['未选择文件', '不选择则保留', '使用上方 HTTPS', '启用证书时请']) {
        assert.ok(!html.includes(removed));
    }
});

test('file import rejects incorrect extensions, malformed certificates and encrypted keys without replacing valid selections', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    const file = (name, text) => ({ name, size: text.length, text: async () => text });
    const cert = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----';
    assert.equal(await app.api.selectSslFile('certificate', file('chain.pem', cert), 'play'), true);
    for (const [name, text] of [
        ['chain.txt', cert],
        ['chain.pem', 'bad'],
        ['chain.crt', `${cert}\n<script>`],
    ]) {
        assert.equal(await app.api.selectSslFile('certificate', file(name, text), 'play'), false);
        assert.equal(app.api.state.sslFiles.play.certificateName, 'chain.pem');
    }
    assert.equal(
        await app.api.selectSslFile(
            'privateKey',
            file(
                'private.key',
                '-----BEGIN ENCRYPTED PRIVATE KEY-----\nYWJj\n-----END ENCRYPTED PRIVATE KEY-----',
            ),
            'play',
        ),
        false,
    );
    assert.equal(
        await app.api.selectSslFile(
            'privateKey',
            file('private.key', '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----'),
            'play',
        ),
        true,
    );
});

test('enable Nginx opens certificate setup on first use and starts a saved configuration', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslStatus = { imageAvailable: true };
    app.api.render();
    await app.api.enableNginx();
    assert.equal(app.api.state.setupSection, 'network');
    assert.equal(app.api.state.accessMode, 'public-independent');
    assert.ok(!app.calls.some((call) => call.command === 'apply_ssl_config'));
    app.api.state.sslStatus = {
        config: {
            settings: {
                mode: 'external',
                routes: [{ service: 'play', domain: 'play.example.test', port: 443 }],
            },
        },
    };
    app.results.apply_ssl_config = { provider: 'managed', running: true };
    app.api.render();
    await app.api.enableNginx();
    const applied = app.calls.find((call) => call.command === 'apply_ssl_config');
    assert.equal(applied.payload.config.settings.mode, 'managed');
    assert.equal(applied.payload.config.settings.routes[0].domain, 'play.example.test');
});

test('saving public configuration applies separate certificates without persisting keys in install config', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslLoaded = true;
    app.api.state.sslFiles = {
        'player-auth-portal': { certificate: 'AUTH_CERTIFICATE', privateKey: 'AUTH_KEY' },
        'play': { certificate: 'PLAY_CERTIFICATE', privateKey: 'PLAY_KEY' },
    };
    app.results.apply_ssl_config = ({ config }) => ({
        provider: 'managed',
        config: { settings: config.settings },
    });
    app.results.get_ssl_status = { provider: 'managed' };
    app.api.render();
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    const applied = app.calls.find((call) => call.command === 'apply_ssl_config');
    assert.equal(applied.payload.config.externalLocal, false);
    assert.equal(applied.payload.config.certificates.play.privateKey, 'PLAY_KEY');
    assert.equal(applied.payload.config.certificates['player-auth-portal'].privateKey, 'AUTH_KEY');
    const saved = app.calls.find((call) => call.command === 'save_configuration_command');
    assert.ok(!JSON.stringify(saved.payload).includes('PLAY_KEY'));
    assert.equal(Object.keys(app.api.state.sslFiles).length, 0);
});

test('updating one service certificate leaves another saved certificate untouched', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslLoaded = true;
    app.api.state.sslStatus = { config: { certificateSources: { play: 'independent' } } };
    app.api.state.sslFiles = {
        'player-auth-portal': { certificate: 'NEW_AUTH_CERT', privateKey: 'NEW_AUTH_KEY' },
    };
    app.results.apply_ssl_config = () => ({ provider: 'managed' });
    app.api.render();
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    const config = app.calls.find((call) => call.command === 'apply_ssl_config').payload.config;
    assert.equal(config.certificates.play, undefined);
    assert.equal(config.certificates['player-auth-portal'].privateKey, 'NEW_AUTH_KEY');
});

test('Nginx start shows the shared processing dialog until completion and reports success', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslStatus = {
        config: {
            settings: {
                mode: 'managed',
                routes: [{ service: 'play', domain: 'play.example.test', port: 443 }],
            },
        },
    };
    let finish;
    app.results.apply_ssl_config = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    app.results.get_ssl_status = { provider: 'managed', running: true };
    app.api.render();
    const pending = app.api.enableNginx();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(app.html, /class="progress-backdrop" role="alertdialog"/);
    assert.match(app.html, /这可能需要几分钟/);
    await app.api.enableNginx();
    assert.equal(app.calls.filter((call) => call.command === 'apply_ssl_config').length, 1);
    finish({ running: true });
    await pending;
    assert.ok(!app.html.includes('class="progress-backdrop"'));
    assert.match(app.html, /内置 Nginx 已启用并启动/);
});

test('Nginx start failure closes the processing dialog and displays the error', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslStatus = { config: { settings: { mode: 'managed', routes: [] } } };
    app.results.apply_ssl_config = () => {
        throw new Error('fixture nginx failed');
    };
    app.api.render();
    await app.api.enableNginx();
    assert.ok(!app.html.includes('class="progress-backdrop"'));
    assert.match(app.html, /fixture nginx failed/);
    assert.equal(app.api.state.sslBusy, false);
});

test('saving public addresses updates managed Nginx with saved certificates and removes the export panel', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslStatus = {
        config: {
            settings: {
                mode: 'managed',
                routes: [{ service: 'play', domain: 'old.example.test', port: 443 }],
            },
        },
    };
    app.results.apply_ssl_config = { running: true };
    app.results.get_ssl_status = { running: true, provider: 'managed' };
    app.api.render();
    assert.ok(!app.html.includes('id="ssl-export"'));
    assert.ok(!app.html.includes('<h2>证书配置</h2>'));
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    const applied = app.calls.find((call) => call.command === 'apply_ssl_config');
    assert.equal(applied.payload.config.settings.mode, 'managed');
    assert.equal(applied.payload.config.externalLocal, false);
    assert.equal(applied.payload.config.settings.routes[0].domain, 'play.example.test');
    assert.equal(Object.keys(applied.payload.config.certificates).length, 0);
    assert.match(app.html, /公网配置已应用，Nginx 入口和已运行服务的访问设置已更新/);
});

test('Nginx download uses the shared processing dialog and reports a reusable image', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    let finish;
    app.results.install_nginx_image = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    app.results.get_ssl_status = {
        provider: 'managed',
        imageAvailable: true,
        imageVersion: 'fixture',
    };
    app.api.render();
    const pending = app.api.downloadNginx();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(app.html, /class="progress-backdrop" role="alertdialog"/);
    finish();
    await pending;
    assert.ok(!app.html.includes('class="progress-backdrop"'));
    assert.match(app.html, /内置 Nginx 已下载/);
    assert.match(app.html, /id="nginx-enable"/);
});

test('image downloads show the service, byte progress and accessible progress bar', async () => {
    const app = await createFixture();
    app.api.state.page = 'overview';
    app.api.state.busy = true;
    app.api.state.progress = {
        stage: 'image-download',
        message: 'box-local-engine-creator · 128 / 256 MB',
        percent: 50,
    };
    app.api.render();
    assert.match(app.html, /正在下载服务镜像/);
    assert.match(app.html, /box-local-engine-creator · 128 \/ 256 MB/);
    assert.match(app.html, /class="image-download-progress" role="progressbar"/);
    assert.match(app.html, /aria-valuenow="50"/);
    assert.match(app.html, /class="image-download-percent">50%/);
    assert.match(app.html, /<progress[^>]*value="50"/);
    assert.doesNotMatch(app.html, /style="width:/);
});

test('parallel image downloads retain completed rows and independent byte progress', async () => {
    const app = await createFixture();
    app.api.state.busy = true;
    app.api.state.progress = {
        stage: 'image-download',
        message: '2 个镜像并行下载 · 已完成 1/2（模拟）',
        downloads: [
            {
                image: 'box-local-engine-creator',
                bytes: 256 * 1_048_576,
                total: 256 * 1_048_576,
                percent: 100,
            },
            {
                image: 'box-local-engine-voxa',
                bytes: 64 * 1_048_576,
                total: 128 * 1_048_576,
                percent: 50,
            },
        ],
    };
    app.api.render();
    assert.equal((app.html.match(/role="progressbar"/g) || []).length, 2);
    assert.match(app.html, /box-local-engine-creator 下载进度"[^>]*aria-valuenow="100"/);
    assert.match(app.html, /box-local-engine-voxa 下载进度"[^>]*aria-valuenow="50"/);
    assert.match(app.html, /已完成/);
    assert.match(app.html, /256 \/ 256 MB/);
    assert.match(app.html, /64 \/ 128 MB/);
});

test('service download ticks keep the spinner and page mounted', async () => {
    const app = await createFixture();
    app.api.state.busy = true;
    app.api.render();
    const renders = app.renderCount;
    for (let percent = 1; percent <= 100; percent++) {
        app.context.progressListeners.get('install-progress')({
            payload: {
                stage: 'image-download',
                message: `镜像下载 ${percent}%`,
                percent,
            },
        });
        for (const [id, timer] of app.timeouts) {
            if (timer.delay === 50) {
                app.timeouts.delete(id);
                timer.handler();
            }
        }
    }
    assert.equal(app.renderCount, renders, 'download ticks must not replace the animated spinner');
    assert.match(app.html, /aria-valuenow="100"/);
    // A status refresh during acquisition must preserve the same overlay too.
    app.api.render();
    assert.equal(app.renderCount, renders);
    app.api.state.progress = { stage: 'image-import', message: '正在导入 Docker' };
    app.api.render();
    assert.equal(app.renderCount, renders);
    assert.match(app.html, /正在导入服务镜像/);
    assert.doesNotMatch(app.html, /image-download-dialog/);
    app.api.state.busy = false;
    app.api.render();
    assert.doesNotMatch(app.html, /class="progress-backdrop"/);
});

test('authenticated Web console renders streamed service downloads and keeps dependency downloads indeterminate', async () => {
    const app = await createFixture({ webManager: true, token: 'local-web-test-token' });
    app.api.state.busy = true;
    app.context.progressListeners.get('install-progress')({
        payload: {
            stage: 'image-download',
            message: '正在下载 Play',
            percent: 25,
            downloads: [
                { image: 'play', bytes: 25 * 1_048_576, total: 100 * 1_048_576, percent: 25 },
            ],
        },
    });
    app.api.render();
    assert.match(app.html, /play 下载进度"[^>]*aria-valuenow="25"/);
    assert.match(app.html, /25 \/ 100 MB/);
    app.context.progressListeners.get('install-progress')({
        payload: {
            stage: 'dependency-image-download',
            message: '正在下载 PostgreSQL 镜像，可能需要几分钟，请耐心等待…',
            percent: 1,
        },
    });
    app.api.render();
    assert.match(app.html, /可能需要几分钟/);
    assert.doesNotMatch(app.html, /role="progressbar"/);
});

test('external Nginx saves unrelated settings without applying or replacing manual networking', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'external' };
    app.api.state.sslFiles = { play: { certificate: 'CERT', privateKey: 'KEY' } };
    app.api.state.config.playPublicAddressOverride = 'https://bad.example.test/api';
    app.api.render();
    assert.match(app.html, /查看 Nginx 配置/);
    assert.ok(app.html.includes('name="playPublicAddressOverride"'));
    assert.ok(!app.html.includes('data-ssl-service="play"'));
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.error, '');
    assert.ok(!app.calls.some((call) => call.command === 'apply_ssl_config'));
    assert.equal(
        app.calls.find((call) => call.command === 'set_nginx_provider').payload.mode,
        'external-manual',
    );
    const config = app.calls.find((call) => call.command === 'save_configuration_command').payload
        .config;
    assert.equal(config.externalNginxManual, true);
    for (const key of [
        'playPublicAddressOverride',
        'playPort',
        'publicServicePaths',
        'publicAddress',
    ]) {
        assert.equal(config[key], undefined);
    }
});

test('external Nginx instructions work without a local Nginx installation', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.results.get_ssl_status = { externalNginx: { installed: false } };
    await app.api.chooseNginx('external');
    assert.match(app.html, /外部 Nginx 由你维护/);
    assert.ok(!app.html.includes('未检测到本机 Nginx'));
    assert.ok(!app.html.includes('nginx-reload'));
});

test('a stale external Nginx detection response cannot overwrite the latest result', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'external' };
    const finishes = [];
    app.results.get_ssl_status = () =>
        new Promise((resolve) => {
            finishes.push(resolve);
        });
    const older = app.api.chooseNginx('external');
    const newer = app.api.chooseNginx('external');
    finishes[1]({
        externalNginx: {
            installed: true,
            version: 'new',
            executablePath: '/new/nginx',
            configPath: '/new/nginx.conf',
        },
    });
    await newer;
    finishes[0]({ externalNginx: { installed: false } });
    await older;
    assert.equal(app.api.state.sslStatus.externalNginx.version, 'new');
    assert.ok(!app.html.includes('未检测到本机 Nginx'));
    app.results.get_ssl_status = () => {
        throw new Error('fixture transport unavailable');
    };
    await app.api.chooseNginx('external');
    assert.match(app.api.state.sslDetectionError, /fixture transport unavailable/);
});

test('duplicate public endpoints are explained before saving or applying configuration', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.config.publicAddress = 'https://user.box3lab.com';
    app.api.state.config.playPublicAddressOverride = 'https://user.box3lab.com';
    app.api.state.config.authPortalPublicAddressOverride = 'https://user.box3lab.com';
    app.api.state.sslFiles = { play: { certificate: 'CERT', privateKey: 'KEY' } };
    app.api.render();
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.match(app.api.state.error, /同一个地址、端口和路径不能分配给多个服务/);
    assert.ok(
        !app.calls.some((call) =>
            ['save_configuration_command', 'apply_ssl_config'].includes(call.command),
        ),
    );
    assert.equal(app.api.state.sslFiles.play.privateKey, 'KEY');
    assert.equal(app.api.state.config.playPublicAddressOverride, 'https://user.box3lab.com');
});

test('independent HTTPS domains use 443 without changing engine ports', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.config.publicAddress = 'https://shared.example.test';
    for (const [field, host] of [
        ['playPublicAddressOverride', 'play'],
        ['creatorPublicAddressOverride', 'arena'],
        ['voxaPublicAddressOverride', 'voxa'],
        ['playerServicePublicAddressOverride', 'admin'],
        ['authPortalPublicAddressOverride', 'auth'],
    ]) {
        app.api.state.config[field] = `https://${host}.example.test`;
    }
    const routes = app.api.sslRoutes();
    assert.ok(routes.every((route) => route.port === 443));
    assert.equal(new Set(routes.map((route) => route.domain)).size, 5);
    assert.equal(app.api.getServiceUrl('play'), 'https://play.example.test/');
    assert.ok(!app.api.setup().includes('共用公网地址'));
    assert.ok(!app.api.setup().includes('13121'));
    app.api.state.sslFiles = { play: { certificate: 'CERT', privateKey: 'KEY' } };
    app.results.apply_ssl_config = { running: true };
    app.api.render();
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.error, '');
    const applied = app.calls.find((call) => call.command === 'apply_ssl_config');
    assert.ok(applied.payload.config.settings.routes.every((route) => route.port === 443));
    const saved = app.calls.find((call) => call.command === 'save_configuration_command');
    assert.equal(saved.payload.config.playPort, 3121);
    assert.equal(
        app.api.sslRoutes({ playPublicAddressOverride: 'https://play.example.test:8443' })[0].port,
        8443,
    );
});

test('public configuration has only service addresses and independent certificate inputs', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.config.publicAddress = 'https://legacy-shared.example.test';
    const html = app.api.setup();
    assert.ok(!html.includes('name="publicAddress"'));
    assert.ok(!html.includes('共用公网地址'));
    assert.ok(!html.includes('SSL 证书（共用）'));
    assert.ok(!html.includes('data-ssl-service="shared"'));
    assert.ok(html.includes('data-ssl-service="play"'));
    app.api.state.config.playPublicAddressOverride = '';
    assert.equal(app.api.getServiceUrl('play'), '');
    assert.ok(!app.api.sslRoutes().some((route) => route.service === 'play'));
});

test('SSL expiry distinguishes impending and expired certificates and provides a deletion control', async () => {
    const app = await createFixture();
    app.api.state.sslStatus = {
        config: {
            certificateExpiries: { play: new Date(Date.now() + 10 * 86400000).toISOString() },
        },
    };
    assert.match(app.api.setup(), /ssl-expiry-card expiring/);
    assert.match(app.api.setup(), /即将到期，请更换/);
    assert.match(app.api.setup(), /ssl-title-status expiring">（已配置 · 即将到期）/);
    assert.match(app.api.setup(), /data-delete-ssl="play"/);
    app.api.state.sslStatus.config.certificateExpiries.play = new Date(
        Date.now() - 86400000,
    ).toISOString();
    assert.match(app.api.setup(), /ssl-expiry-card expired/);
    assert.match(app.api.setup(), /已过期，请更换/);
    assert.match(app.api.setup(), /ssl-title-status expired">（已配置 · 已过期）/);
    assert.ok(!app.api.setup().includes('即将到期或已过期'));
    app.api.state.sslStatus.config.certificateExpiries.play = new Date(
        Date.now() + 90 * 86400000,
    ).toISOString();
    assert.match(app.api.setup(), /ssl-title-status ">（已配置）/);
    delete app.api.state.sslStatus.config.certificateExpiries.play;
    assert.ok(!app.api.setup().includes('ssl-title-status'));
});

test('deleting a service certificate removes its expiry and draft while keeping other services', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.sslStatus = {
        config: { certificateExpiries: { play: '2099-01-01', creator: '2099-01-01' } },
    };
    app.api.state.sslFiles = { play: { certificate: 'PLAY' }, creator: { certificate: 'CREATOR' } };
    app.results.delete_ssl_certificate = {
        config: { certificateExpiries: { creator: '2099-01-01' } },
    };
    await app.api.deleteSslCertificate('play');
    assert.equal(
        app.calls.find((call) => call.command === 'delete_ssl_certificate').payload.service,
        'play',
    );
    assert.equal(app.api.state.sslFiles.play, undefined);
    assert.equal(app.api.state.sslFiles.creator.certificate, 'CREATOR');
    assert.ok(!app.html.includes('data-delete-ssl="play"'));
    assert.match(app.html, /data-delete-ssl="creator"/);
});

test('shared public mode shows one certificate picker and applies that certificate to every service', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.accessMode = 'public-shared';
    app.api.state.config.publicAddressMode = 'shared';
    app.api.state.config.sharedPublicAddress = 'shared.example.test';
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslFiles = {
        shared: { certificate: 'SHARED_CERT', privateKey: 'SHARED_KEY' },
        play: { certificate: 'OLD_DRAFT', privateKey: 'OLD_DRAFT_KEY' },
    };
    app.results.apply_ssl_config = { running: true };
    app.api.render();
    assert.match(app.html, /data-ssl-service="shared"/);
    for (const service of ['play', 'creator', 'voxa', 'player-service', 'player-auth-portal']) {
        assert.ok(!app.html.includes(`data-ssl-service="${service}"`));
    }
    assert.match(app.html, /配置说明：访问地址、路径与 SSL/);
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.error, '');
    const applied = app.calls.find((call) => call.command === 'apply_ssl_config');
    const certificates = Object.values(applied.payload.config.certificates);
    assert.equal(certificates.length, 5);
    for (const certificate of certificates) {
        assert.equal(certificate.source, 'shared');
        assert.equal(certificate.certificate, 'SHARED_CERT');
        assert.equal(certificate.privateKey, 'SHARED_KEY');
    }
    const saved = app.calls.find((call) => call.command === 'save_configuration_command');
    assert.ok(!JSON.stringify(saved.payload).includes('SHARED_KEY'));
});

test('independent addresses hide path controls and ignore retained shared path drafts', async () => {
    const app = await createFixture();
    app.api.state.config.publicAddressMode = 'independent';
    app.api.state.config.playPublicAddressOverride = 'https://play.example.test';
    app.api.state.config.publicServicePaths = { play: '/play' };
    app.api.state.accessMode = 'public-independent';
    const html = app.api.setup();
    assert.match(html, /name="publicPath-play" type="hidden" value="\/play"/);
    assert.equal(app.api.sslRoutes()[0].path, '');
    assert.equal(app.api.getServiceUrl('play'), 'https://play.example.test/');
});

test('public path length agrees with the backend before applying routes', async () => {
    const app = await createFixture();
    const config = {
        publicAddressMode: 'shared',
        sharedPublicAddress: 'example.test',
        publicServicePaths: { play: '/' + 'a'.repeat(128) },
    };
    assert.equal(app.api.sslRoutes(config)[0].path.length, 129);
    config.publicServicePaths.play += 'a';
    assert.throws(() => app.api.sslRoutes(config), /128/);
});

test('bare domains infer protocol from certificates while explicit schemes and ports win', async () => {
    const app = await createFixture();
    app.api.state.config.playPublicAddressOverride = 'play.example.test';
    assert.equal(app.api.getServiceUrl('play'), 'http://play.example.test/');
    app.api.state.sslFiles = { play: { certificate: 'CERT', privateKey: 'KEY' } };
    assert.equal(app.api.getServiceUrl('play'), 'https://play.example.test/');
    assert.equal(
        app.api.sslRoutes({ playPublicAddressOverride: 'play.example.test:8443' })[0].port,
        8443,
    );
    assert.equal(
        app.api.sslRoutes({ playPublicAddressOverride: 'http://play.example.test' })[0].secure,
        false,
    );
    app.api.state.sslFiles = {};
    app.api.state.config.publicSslConfigured = { play: true };
    assert.equal(app.api.getServiceUrl('play'), 'https://play.example.test/');
    app.api.state.sslStatus = { config: null };
    assert.equal(app.api.getServiceUrl('play'), 'http://play.example.test/');
    assert.equal(
        app.api.sslRoutes({ playPublicAddressOverride: '203.0.113.10', playPort: 4121 })[0].port,
        4121,
    );
    const ipv6 = app.api.sslRoutes({ playPublicAddressOverride: '[2001:db8::1]:8443' })[0];
    assert.equal(ipv6.domain, '2001:db8::1');
    assert.equal(ipv6.port, 8443);
});

test('saving an automatic domain sends certificate flags without fixing its raw protocol or leaking keys', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.config.playPublicAddressOverride = 'play.example.test';
    app.api.state.sslFiles = { play: { certificate: 'CERT', privateKey: 'KEY' } };
    app.api.state.sslDraft = { mode: 'managed' };
    app.results.apply_ssl_config = { running: true };
    app.api.render();
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.error, '');
    const saved = app.calls.find((call) => call.command === 'save_configuration_command').payload
        .config;
    assert.equal(saved.playPublicAddressOverride, 'play.example.test');
    assert.equal(saved.publicSslConfigured.play, true);
    assert.ok(!JSON.stringify(saved).includes('KEY'));
    const route = app.calls
        .find((call) => call.command === 'apply_ssl_config')
        .payload.config.settings.routes.find((route) => route.service === 'play');
    assert.equal(route.secure, true);
    assert.equal(route.port, 443);
});

test('Linux Web manager presents manual external Nginx configuration', async () => {
    const app = await createFixture({ webManager: true, token: 'test-manager-token' });
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'external' };
    app.api.render();
    assert.match(app.html, /查看 Nginx 配置/);
    assert.doesNotMatch(app.html, /id="external-example-nginx"/);
    app.api.openExternalNginxDialog();
    assert.match(app.html, /proxy_pass http:\/\/127\.0\.0\.1:3121/);
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.ok(!app.calls.some((call) => call.command === 'apply_ssl_config'));
});

test('service links respect separate creator access mode', async () => {
    const app = await createFixture();
    app.api.state.config.playNetworkMode = 'public';
    app.api.state.config.creatorNetworkMode = 'local';
    app.api.state.config.creatorPublicAddressOverride = 'https://old-arena.example.test';
    assert.equal(app.api.getServiceUrl('creator'), 'http://127.0.0.1:3127/');
});

test('running built-in Nginx has a manual reload button and preserves active service on failure', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.sslStatus = { running: true, imageAvailable: true };
    app.api.render();
    assert.match(app.html, /id="nginx-reload"/);
    app.results.reload_ssl_proxy = { running: true };
    app.results.get_ssl_status = { running: true };
    await app.api.reloadNginx();
    assert.equal(app.calls.filter((call) => call.command === 'reload_ssl_proxy').length, 1);
    assert.match(app.api.state.notice, /已重载/);
    app.results.reload_ssl_proxy = () => {
        throw new Error('certificate mismatch');
    };
    await app.api.reloadNginx();
    assert.match(app.api.state.error, /certificate mismatch/);
    assert.equal(app.api.state.sslStatus.running, true);
});

test('certificate paths use SSL payload only and incomplete pairs cannot apply', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'network';
    app.api.state.sslLoaded = true;
    app.api.state.sslDraft = { mode: 'managed' };
    app.api.state.config.playPublicAddressOverride = 'https://play.example.test';
    app.api.state.sslFiles = {
        play: {
            inputMode: 'path',
            certificatePath: '/certs/fullchain.pem',
            privateKeyPath: '/certs/key.pem',
        },
    };
    app.results.apply_ssl_config = { running: true };
    app.api.render();
    assert.match(app.html, /ssl-cert-path-play/);
    assert.ok(!app.html.includes('每 5 秒'));
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.equal(app.api.state.error, '');
    const payload = app.calls.find((call) => call.command === 'apply_ssl_config').payload.config;
    assert.equal(payload.certificatePaths.play.certificatePath, '/certs/fullchain.pem');
    assert.equal(payload.certificatePaths.play.privateKeyPath, '/certs/key.pem');
    assert.equal(payload.certificates.play, undefined);
    const saved = app.calls.find((call) => call.command === 'save_configuration_command').payload
        .config;
    assert.ok(!JSON.stringify(saved).includes('/certs/key.pem'));
    app.api.state.sslFiles = {
        play: { inputMode: 'path', certificatePath: '/certs/fullchain.pem' },
    };
    const before = app.calls.filter((call) => call.command === 'apply_ssl_config').length;
    await app.api.saveConfiguration({ currentTarget: app.form, preventDefault() {} });
    assert.match(app.api.state.error, /同时填写证书和私钥/);
    assert.equal(app.calls.filter((call) => call.command === 'apply_ssl_config').length, before);
});

test('raw Nginx configuration appears with a managed config and saves validated text', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'data';
    app.api.state.sslLoaded = true;
    app.results.get_ssl_status = { provider: 'managed', running: true, nginxConfigAvailable: true };
    app.api.state.sslStatus = { provider: 'managed', running: true, nginxConfigAvailable: false };
    app.api.render();
    assert.ok(!app.html.includes('原始 Nginx 配置'));
    app.api.state.sslStatus = { provider: 'managed', running: true, nginxConfigAvailable: true };
    app.api.render();
    assert.ok(app.html.includes('原始 Nginx 配置'));
    await app.api.loadRawNginxConfig();
    const textarea = app.document.querySelector('#raw-nginx-config');
    assert.ok(textarea);
    assert.match(textarea.value, /events \{\}/);
    textarea.value = 'events {}\nhttp { server { listen 8080; } }\n';
    await app.api.saveRawNginxConfig();
    const call = app.calls.filter((item) => item.command === 'save_raw_nginx_config').at(-1);
    assert.equal(call.payload.content, 'events {}\nhttp { server { listen 8080; } }\n');
    assert.equal(app.api.state.nginxConfigMessage, '内置 Nginx 配置已校验并重载。');
    assert.equal(app.api.state.error, '');
});

test('raw Nginx configuration stays hidden without a built-in config', async () => {
    const app = await createFixture();
    app.api.state.page = 'setup';
    app.api.state.setupSection = 'environment';
    app.api.state.sslLoaded = true;
    app.api.state.sslStatus = { provider: 'external', nginxConfigAvailable: false };
    app.api.render();
    assert.ok(!app.html.includes('原始 Nginx 配置'));
});

test('about update button checks the release and opens the available update', async () => {
    const app = await createFixture({
        releaseResponse: {
            schemaVersion: 1,
            version: '0.4.0',
            date: '2026-10-14',
            summary: 'New release',
            sections: [],
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    app.api.state.page = 'about';
    app.api.state.updateRelease = null;
    app.api.state.updateDialogOpen = false;
    app.api.render();
    const initialRequests = app.calls.filter((call) => call.command === 'fetch_release').length;
    await app.document.querySelector('[data-check-version-updates]').click();
    assert.ok(
        app.calls.filter((call) => call.command === 'fetch_release').length > initialRequests,
    );
    assert.equal(app.api.state.updateRelease.version, '0.4.0');
    assert.equal(app.api.state.updateDialogOpen, true);
});

test('about page hides management actions before Web login', async () => {
    const app = await createFixture({ webManager: true });
    app.api.state.page = 'about';
    app.api.render();
    assert.doesNotMatch(app.html, /data-check-version-updates/);
    assert.doesNotMatch(app.html, /id="export-about-diagnostics"/);
    assert.match(app.html, /data-open-legal-document="license"/);
});

for (const webManager of [false, true]) {
    test(`${webManager ? 'Web' : 'desktop'}: sidebar update control appears only with an available release`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        await new Promise((resolve) => setImmediate(resolve));
        app.api.state.page = 'about';
        app.api.state.updateRelease = null;
        for (const checking of [false, true]) {
            app.api.state.updateChecking = checking;
            app.api.render();
            assert.doesNotMatch(app.html, /id="check-version-updates"/);
            assert.match(app.html, /data-check-version-updates/);
        }
        app.api.state.updateChecking = false;
        app.api.state.updateRelease = { version: '0.4.0' };
        app.api.render();
        assert.match(
            app.html,
            /class="icon-button update-check update-available" id="check-version-updates"/,
        );
        app.api.state.updateRelease = null;
        app.api.render();
        assert.doesNotMatch(app.html, /id="check-version-updates"/);
    });
}

for (const webManager of [false, true]) {
    test(`${webManager ? 'Web' : 'desktop'}: About repository shortcut uses the project repository opener`, async () => {
        const app = await createFixture({ webManager, token: 'fixture-token' });
        app.api.state.page = 'about';
        app.api.render();
        await app.document.querySelector('[data-open-project-repository]').click();
        assert.ok(
            app.calls.some(
                (call) =>
                    call.command === 'open_project_repository' &&
                    call.payload.url === 'https://github.com/box3lab/box3-local-engine',
            ),
        );
    });
}

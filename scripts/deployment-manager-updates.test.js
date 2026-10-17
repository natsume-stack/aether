'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./lib/deployment-manager-ui-fixture');
const { buildReleaseManifest } = require('./build-release-manifest');
const release = {
    schemaVersion: 1,
    version: '0.4.0',
    date: '2026-10-09',
    summary: '<script>alert(1)</script>',
    sections: [{ title: 'New features', items: ['<img src=x onerror=alert(1)>'] }],
};

test('dev launchers do not request staging or production update manifests', async () => {
    for (const webManager of [false, true]) {
        const app = await createFixture({
            webManager,
            releaseResponse: release,
            responses: {
                get_about_info: {
                    applicationVersion: '2026.1.4-dev',
                    imageTag: 'v2026.1.4-dev-linux-arm64',
                    platform: 'macos',
                    architecture: 'aarch64',
                },
            },
        });
        await app.api.checkForUpdates(true);
        assert.equal(
            app.calls.some((call) =>
                ['fetch_release', 'get_latest_release'].includes(call.command),
            ),
            false,
        );
        assert.equal(app.api.state.updateDialogOpen, false);
        assert.match(app.api.state.notice, /开发版请重新打包/);
        assert.throws(() => app.api.isNewerVersion('2026.1.5', '2026.1.4-dev'), /开发版/);
    }
});

test('testing launcher never requests the production update manifest', async () => {
    const app = await createFixture({
        releaseResponse: release,
        responses: {
            get_about_info: {
                applicationVersion: '0.3.0',
                imageTag: 'test-v0.3.0-linux-arm64',
                platform: 'macos',
                architecture: 'aarch64',
            },
        },
    });
    await app.api.checkForUpdates(true);
    assert.equal(
        app.calls.some((call) => call.command === 'fetch_release'),
        false,
    );
    assert.equal(app.api.state.updateDialogOpen, false);
    assert.match(app.api.state.notice, /测试启动器/);
});

test('startup checks CDN and newer releases display escaped changelog, version and date', async () => {
    const app = await createFixture({ releaseResponse: release });
    assert.equal(app.calls.filter((call) => call.command === 'fetch_release').length, 1);
    assert.equal(
        app.calls.find((call) => call.command === 'fetch_release').url,
        'https://assets.box3.fun/local-engine/latest.json',
    );
    assert.equal(app.api.state.updateDialogOpen, true);
    assert.match(app.html, /发现新版本 0\.4\.0/);
    assert.match(app.html, /2026-10-09/);
    assert.doesNotMatch(app.html, /&lt;script&gt;/);
    assert.match(app.html, /&lt;img src=x/);
    assert.doesNotMatch(app.html, /<img src=x/);
    assert.doesNotMatch(app.html, /安装包平台|update-download-target/);
    app.api.closeUpdateDialog();
    assert.equal(app.api.state.updateDialogOpen, false);
    assert.doesNotMatch(app.html, /id="update-title"/);
});

test('staging checks and downloads updates only from the staging channel', async () => {
    const app = await createFixture({
        releaseResponse: { ...release, version: '0.4.0-staging' },
        responses: {
            get_about_info: {
                applicationVersion: '0.3.0-staging',
                imageTag: 'v0.3.0-staging-linux-arm64',
                platform: 'macos',
                architecture: 'aarch64',
            },
        },
    });
    assert.equal(
        app.calls.find((call) => call.command === 'fetch_release').url,
        'https://assets.box3.fun/local-engine-staging/latest.json',
    );
    assert.equal(app.api.state.updateDialogOpen, true);
    await app.api.downloadUpdate();
    assert.equal(
        app.calls.find((call) => call.command === 'download_launcher_update').payload.url,
        'https://assets.box3.fun/local-engine-staging/BOX-Local-Engine-0.4.0-staging-macos-arm64.zip',
    );
});

test('download uses native system and architecture for every supported installer', async () => {
    for (const [platform, architecture, target] of [
        ['macos', 'aarch64', 'macos-arm64'],
        ['windows', 'x86_64', 'windows-amd64'],
        ['windows', 'aarch64', 'windows-arm64'],
        ['linux', 'x86_64', 'linux-amd64'],
        ['linux', 'aarch64', 'linux-arm64'],
    ]) {
        const app = await createFixture({
            releaseResponse: release,
            responses: { get_about_info: { applicationVersion: '0.2.0', platform, architecture } },
        });
        await app.api.downloadUpdate();
        const download = app.calls.find((call) => call.command === 'download_launcher_update');
        assert.equal(
            download?.payload.url,
            `https://assets.box3.fun/local-engine/BOX-Local-Engine-0.4.0-${target}.zip`,
        );
        assert.doesNotMatch(app.html, /安装包平台|update-download-target/);
    }
});

test('unsupported native systems never fall back to another installer', async () => {
    const app = await createFixture({
        releaseResponse: release,
        responses: {
            get_about_info: {
                applicationVersion: '0.2.0',
                platform: 'macos',
                architecture: 'x86_64',
            },
        },
    });
    await app.api.checkForUpdates(true);
    assert.match(app.api.state.error, /当前系统暂无对应安装包/);
    await app.api.downloadUpdate();
    assert.equal(
        app.calls.some((call) => call.command === 'download_launcher_update'),
        false,
    );
});

test('download shows live progress, prevents duplicate requests and offers restart after completion', async () => {
    let finish;
    const waiting = new Promise((resolve) => {
        finish = resolve;
    });
    const app = await createFixture({
        releaseResponse: release,
        responses: { download_launcher_update: () => waiting },
    });
    const download = app.api.downloadUpdate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(app.html, /正在下载更新/);
    app.context.progressListeners.get('launcher-update-progress')({
        payload: { bytes: 25, total: 100 },
    });
    assert.match(app.html, /25%/);
    await app.api.downloadUpdate();
    assert.equal(app.calls.filter((call) => call.command === 'download_launcher_update').length, 1);
    assert.equal(
        app.calls.some((call) => call.command === 'apply_launcher_update'),
        false,
    );
    finish();
    await download;
    assert.match(app.html, /下载完成/);
    assert.match(app.html, /重启并更新/);
    await app.api.restartAndUpdate();
    assert.equal(app.calls.filter((call) => call.command === 'apply_launcher_update').length, 1);
});

test('failed downloads can retry and restart failures preserve the prepared update', async () => {
    let failed = true;
    const app = await createFixture({
        releaseResponse: release,
        responses: {
            download_launcher_update: () => {
                if (failed) {
                    throw new Error('下载中断');
                }
            },
            apply_launcher_update: () => {
                throw new Error('目录只读');
            },
        },
    });
    await app.api.restartAndUpdate();
    assert.equal(
        app.calls.some((call) => call.command === 'apply_launcher_update'),
        false,
    );
    await app.api.downloadUpdate();
    assert.match(app.html, /下载中断/);
    assert.equal(app.api.state.updateReady, false);
    assert.equal(app.api.state.updateDownloading, false);
    failed = false;
    await app.api.downloadUpdate();
    await app.api.restartAndUpdate();
    assert.match(app.html, /目录只读/);
    assert.equal(app.api.state.updateReady, true);
    assert.equal(app.api.state.updateRestarting, false);
});

test('download progress does not remount the page or replay the update dialog entrance', async () => {
    let finish;
    const waiting = new Promise((resolve) => {
        finish = resolve;
    });
    const app = await createFixture({
        releaseResponse: release,
        responses: { download_launcher_update: () => waiting },
    });
    const download = app.api.downloadUpdate();
    await new Promise((resolve) => setImmediate(resolve));
    const renders = app.renderCount;
    const bar = app.document.querySelector('#launcher-update-progress');
    const label = app.document.querySelector('#launcher-update-progress-label');
    try {
        for (let bytes = 1; bytes <= 100; bytes++) {
            app.context.progressListeners.get('launcher-update-progress')({
                payload: { bytes, total: 100 },
            });
        }
        assert.equal(app.renderCount, renders, 'progress must leave the page and dialog mounted');
        assert.equal(app.document.querySelector('#launcher-update-progress'), bar);
        assert.equal(app.document.querySelector('#launcher-update-progress-label'), label);
        assert.equal(bar.value, 100);
        assert.match(label.textContent, /100%/);
    } finally {
        finish();
        await download;
    }
});

test('old-image cleanup defaults on and the user can opt out before confirming', async () => {
    for (const enabled of [false, true]) {
        const app = await createFixture({ releaseResponse: release });
        await app.api.downloadUpdate();
        assert.match(app.html, /同时清理旧镜像/);
        assert.equal(app.api.state.updateCleanupOldImages, true);
        app.api.state.updateCleanupOldImages = enabled;
        await app.api.restartAndUpdate();
        assert.equal(
            app.calls.find((call) => call.command === 'apply_launcher_update').payload
                .cleanupOldImages,
            enabled,
        );
    }
});

test('manual checks report latest and semantic comparison rejects nonstable versions', async () => {
    const app = await createFixture();
    assert.equal(app.api.state.updateDialogOpen, false);
    await app.api.checkForUpdates(true);
    assert.equal(app.api.state.notice, '当前已是最新版本。');
    assert.equal(app.api.isNewerVersion('0.10.0', '0.9.9'), true);
    assert.equal(app.api.isNewerVersion('0.2.0', '0.3.0'), false);
    assert.equal(app.api.isNewerVersion('v0.3.0', '0.3.0+build'), false);
    assert.throws(() => app.api.isNewerVersion('0.4.0-beta.1', '0.3.0'));
    assert.throws(() =>
        app.api.validateRelease({ ...release, sections: [{ title: 'x', items: [{}] }] }),
    );
});

test('offline startup is silent, manual failure is actionable, and Web checks through its backend', async () => {
    const app = await createFixture({
        releaseResponse: () => {
            throw new Error('offline');
        },
    });
    assert.equal(app.api.state.error, '');
    assert.equal(app.api.state.updateChecking, false);
    await app.api.checkForUpdates(true);
    assert.match(app.api.state.error, /无法检测更新/);
    const web = await createFixture({
        webManager: true,
        token: 'fixture-manager-token',
        responses: {
            get_latest_release: release,
            get_about_info: {
                applicationVersion: '0.3.0',
                platform: 'linux',
                architecture: 'aarch64',
            },
        },
    });
    await web.api.checkForUpdates(true);
    assert.equal(web.calls.filter((call) => call.command === 'fetch_release').length, 0);
    assert.ok(web.calls.some((call) => call.command === 'get_latest_release'));
    assert.equal(web.api.state.updateDialogOpen, true);
    assert.match(web.html, /id="check-version-updates"/);
});

test('Web update uses the helper identifier and reloads after the new manager returns', async () => {
    let started = false;
    const app = await createFixture({
        webManager: true,
        token: 'local-web-manager-token',
        responses: {
            get_latest_release: release,
            get_about_info: () => ({
                applicationVersion: started ? '0.4.0' : '0.3.0',
                platform: 'linux',
                architecture: 'aarch64',
            }),
            start_server_update: () => {
                started = true;
                return { updater: 'box3-fixture-updater' };
            },
        },
    });
    await app.api.checkForUpdates(true);
    const update = app.api.downloadUpdate();
    await new Promise((resolve) => setImmediate(resolve));
    const delay = [...app.timeouts.values()].find((timer) => timer.delay === 2000);
    assert.ok(delay, 'Web update waits for the replacement manager');
    delay.handler();
    await update;
    assert.equal(app.api.state.updateError, '');
    assert.ok(
        app.calls.some(
            (call) => call.command === 'start_server_update' && call.payload.version === '0.4.0',
        ),
    );
    assert.ok(app.calls.some((call) => call.command === 'reload_web_manager'));
});

test('overlapping startup and manual checks share one request', async () => {
    let finish;
    const response = new Promise((resolve) => {
        finish = resolve;
    });
    const app = await createFixture({ releaseResponse: () => response });
    const check = app.api.checkForUpdates(true);
    assert.equal(app.calls.filter((call) => call.command === 'fetch_release').length, 1);
    finish(release);
    await check;
    assert.equal(app.api.state.updateChecking, false);
    assert.equal(app.api.state.updateDialogOpen, true);
});

test('manifest selects version logs, retains history and rejects unpublished versions', () => {
    const notes = require('../distribution/release-notes.json');
    const version = require('../package.json').version;
    const manifest = buildReleaseManifest(`v${version}`, '2026-10-09');
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.date, '2026-10-09');
    assert.deepEqual(manifest.sections, notes[0].sections);
    assert.throws(() => buildReleaseManifest('0.4.0', '2026-10-09'), /Missing release notes/);
    assert.throws(() => buildReleaseManifest(version, '2026-02-31'), /Invalid release date/);
});

test('missing CDN manifest reports the publication problem instead of blaming connectivity', async () => {
    const app = await createFixture({
        releaseHttpResponse: {
            ok: false,
            status: 404,
            text: async () =>
                '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
        },
    });
    assert.equal(app.api.state.error, '');
    await app.api.checkForUpdates(true);
    assert.match(app.api.state.error, /HTTP 404/);
    assert.match(app.api.state.error, /NoSuchKey/);
    assert.match(app.api.state.error, /The specified key does not exist\./);
    assert.match(app.html, /&lt;Error&gt;/);
    assert.doesNotMatch(app.html, /<Error>/);
    assert.doesNotMatch(app.api.state.error, /检查网络/);
    assert.equal(app.api.state.updateRelease, null);
    assert.equal(app.api.state.updateChecking, false);
});

test('manual checks preserve server and invalid-manifest errors', async () => {
    const server = await createFixture({
        releaseHttpResponse: { ok: false, status: 503, text: async () => 'Service Unavailable' },
    });
    await server.api.checkForUpdates(true);
    assert.match(server.api.state.error, /HTTP 503：\nService Unavailable/);
    const invalid = await createFixture({
        releaseHttpResponse: { ok: true, text: async () => '<Error>NoSuchKey</Error>' },
    });
    await invalid.api.checkForUpdates(true);
    assert.match(invalid.api.state.error, /Unexpected token/);
});

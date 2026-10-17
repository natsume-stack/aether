'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
for (const architecture of ['arm64', 'amd64']) {
    const templateRoot = path.join(root, 'distribution', `windows-${architecture}`);
    const deployScript = fs.readFileSync(path.join(templateRoot, 'deploy.ps1'), 'utf8');

    for (const file of [
        'ONE-CLICK-DEPLOY.cmd',
        'RECONFIGURE.cmd',
        'deploy.ps1',
        'logs.cmd',
        'start.cmd',
        'status.cmd',
        'stop.cmd',
    ]) {
        assert.ok(
            fs.statSync(path.join(templateRoot, file)).isFile(),
            `windows-${architecture}: missing ${file}`,
        );
    }

    for (const value of [
        'BOX_DATABASE_URL',
        'PERMISSION_TOKEN_SECRET',
        'BOX_PLAYER_AUTH_API_KEY',
        'BOX_PLAY_ADMIN_TOKEN',
        'BOX_POSTGRES_PASSWORD',
        'BOX_REDIS_PASSWORD',
        '数据库地址/IP',
        '数据库端口 [5432]',
        '数据库名 [box]',
        '数据库账号 [box]',
        'EscapeDataString',
        '-AsSecureString',
        'verify-package.ps1',
        'BUILD-INFO.json',
        'api/health-check',
        'box-local-engine-creator:$tag',
        'box-local-engine-play:$tag',
        'box-local-engine-player-service:$tag',
        'box-local-engine-voxa:$tag',
        'box-local-engine-player-auth-portal:$tag',
    ]) {
        assert.ok(
            deployScript.includes(value),
            `windows-${architecture}: installer is missing ${value}`,
        );
    }

    assert.doesNotMatch(deployScript, /43\.154\.|B66x|vifanlyrs|box3local/);
    assert.match(deployScript, /RandomNumberGenerator/);
    assert.match(deployScript, /Test-Configured/);
    assert.match(deployScript, /sourceRevision/);
    assert.match(deployScript, /imageRevisions/);
    assert.match(deployScript, /imageCreatedAt/);
    assert.match(deployScript, /imageExpectedRevision/);
    assert.match(deployScript, /imageExpectedCreatedAt/);
    assert.match(deployScript, new RegExp(`windows-${architecture}`));
    assert.match(deployScript, new RegExp(`linux/${architecture}`));
    assert.doesNotMatch(deployScript, /请输入完整 PostgreSQL 连接串/);
}

console.log('Windows one-click installer checks passed');

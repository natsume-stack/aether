'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

test('export tag follows the repository version instead of the runtime image tag', () => {
    process.env.BOX_IMAGE_TAG = '0.1.1';
    const { defaultExportImageTag } = require('./export-image-plan');

    assert.equal(defaultExportImageTag('0.2.0', 'arm64', {}), 'v0.2.0-dev-linux-arm64');
    assert.equal(defaultExportImageTag('0.2.0', 'amd64', {}), 'v0.2.0-dev-linux-amd64');
    assert.equal(
        defaultExportImageTag('0.2.0', 'arm64', { GITHUB_ACTIONS: 'true' }),
        'v0.2.0-linux-arm64',
    );
});

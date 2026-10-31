import assert from 'node:assert/strict';

import {
  CREATOR_CAPABILITIES,
  CREATOR_CAPABILITY_META,
  hasCreatorCapability,
  normalizeCreatorCapabilities,
} from '../shared/creator-policy';

assert.ok(CREATOR_CAPABILITIES.includes('voxa.edit'), 'voxa.edit must be grantable');
assert.equal(CREATOR_CAPABILITY_META['voxa.edit'].label, 'VOXA 编辑器');
assert.equal(CREATOR_CAPABILITY_META['models.manage'].label, '管理模型');
for (const capability of CREATOR_CAPABILITIES) {
  assert.ok(CREATOR_CAPABILITY_META[capability]?.description, `${capability} needs a description`);
}

assert.deepEqual(normalizeCreatorCapabilities(['voxa.edit', 'voxa.edit', 'models.manage']), [
  'voxa.edit',
  'models.manage',
]);
assert.deepEqual(normalizeCreatorCapabilities(['voxa.edit', 'voxa.admin', 42]), ['voxa.edit']);
assert.deepEqual(normalizeCreatorCapabilities('voxa.edit'), []);
assert.deepEqual(normalizeCreatorCapabilities(null), []);

assert.equal(hasCreatorCapability(['voxa.edit'], 'voxa.edit'), true);
assert.equal(hasCreatorCapability(['models.manage'], 'voxa.edit'), false, 'library admin must not imply editor access');
assert.equal(hasCreatorCapability(['projects.edit'], 'voxa.edit'), false);
assert.equal(hasCreatorCapability([], 'projects.view'), true);

console.log('creator capability checks passed');

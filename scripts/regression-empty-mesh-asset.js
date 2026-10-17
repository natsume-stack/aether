'use strict';

const assert = require('assert');
const { hasRuntimeAssetHash } = require('../internals/build-system/build/project/bake');

assert.strictEqual(hasRuntimeAssetHash(''), false, 'empty model hash must not enter prebake');
assert.strictEqual(hasRuntimeAssetHash('   '), false, 'blank model hash must not enter prebake');
assert.strictEqual(hasRuntimeAssetHash('QmYA7QWy1HEesFgyKBbrDHsD8uMXzdtGK9WNzybPD7PsfS'), true);
console.log('empty mesh asset regression passed');

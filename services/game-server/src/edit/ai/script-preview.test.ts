import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore Native test runner requires explicit extension.
import { previewScript, scriptRevision, scriptReviewRevision } from './script-preview.ts';

const source = { fileId: 'one', name: 'main.js', isClient: false, text: 'const a = 1;\r\nconst b = 2;\r\n' };
test('review revision detects sibling scripts and UI changes but ignores object key order', () => {
  const ui = { b: { name: 'button', visible: true }, a: { name: 'screen' } };
  const revision = scriptReviewRevision([source], ui);
  assert.equal(scriptReviewRevision([source], { a: ui.a, b: { visible: true, name: 'button' } }), revision);
  assert.notEqual(scriptReviewRevision([source, { ...source, fileId: 'sibling', name: 'sibling.js' }], ui), revision);
  assert.notEqual(scriptReviewRevision([source], { ...ui, a: { name: 'changed' } }), revision);
});
test('preview applies unsorted original-source offsets and preserves untouched CRLF content', () => {
  const original = structuredClone(source);
  const result = previewScript(source, scriptRevision(source), [{ index: 24, deleteCount: 1, text: '4' }, { index: 10, deleteCount: 1, text: '3' }]);
  assert.equal(result.content, 'const a = 3;\r\nconst b = 4;\r\n');
  assert.deepEqual(source, original);
  assert.deepEqual(result.changes.map(c => c.line), [1,2]);
  assert.equal(result.applied, false);
  assert.equal(result.validation, 'not-typechecked');
});
test('stale text, renamed script and execution-side changes invalidate source revision', () => {
  for (const changed of [{ ...source, text: source.text + ' ' }, { ...source, name: 'other.js' }, { ...source, isClient: true }]) {
    assert.throws(() => previewScript(changed, scriptRevision(source), [{ index: 0, deleteCount: 0, text: 'x' }]), { code: 'REVISION_CONFLICT' });
  }
});
test('invalid ranges, overlap and ambiguous insertion order are refused', () => {
  for (const edits of [
    [{ index: -1, deleteCount: 0, text: '' }], [{ index: 1.5, deleteCount: 0, text: '' }],
    [{ index: 0, deleteCount: 999, text: '' }],
    [{ index: 0, deleteCount: 3, text: '' }, { index: 2, deleteCount: 0, text: 'a' }],
    [{ index: 0, deleteCount: 0, text: 'a' }, { index: 0, deleteCount: 0, text: 'b' }],
  ]) assert.throws(() => previewScript(source, scriptRevision(source), edits));
});
test('Unicode boundaries, no-op and output capacity are explicit', () => {
  const unicode = { ...source, text: 'a😀b' };
  assert.throws(() => previewScript(unicode, scriptRevision(unicode), [{ index: 2, deleteCount: 0, text: 'x' }]), { code: 'INVALID_SCRIPT_PATCH' });
  assert.equal(previewScript(unicode, scriptRevision(unicode), [{ index: 1, deleteCount: 2, text: '猫' }]).content, 'a猫b');
  assert.equal(previewScript(source, scriptRevision(source), [{ index: 0, deleteCount: 0, text: '' }]).changed, false);
  assert.throws(() => previewScript(source, scriptRevision(source), [{ index: 0, deleteCount: 0, text: 'x'.repeat(500001) }]), { code: 'SCRIPT_TOO_LARGE' });
});

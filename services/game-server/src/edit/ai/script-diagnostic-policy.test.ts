import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Native test runner requires explicit extension.
import { compareDiagnosticErrors, diagnosticIdentity } from './script-diagnostic-policy.ts';

test('baseline comparison preserves multiplicity and never trades fixed errors for new ones', () => {
  assert.deepEqual(compareDiagnosticErrors(['old', 'old'], ['old', 'new']), {
    baselineErrorCount: 2, candidateErrorCount: 2, introducedErrorCount: 1, resolvedErrorCount: 1,
  });
  assert.equal(compareDiagnosticErrors(['old'], ['old', 'old']).introducedErrorCount, 1);
  assert.equal(compareDiagnosticErrors(Array(300).fill('old'), [...Array(300).fill('old'), 'hidden']).introducedErrorCount, 1);
});

test('diagnostic identity tolerates shifted lines but preserves source and binding identity', () => {
  const original = { code: 'TS2339', file: 'one.js', message: 'missing', span: 'missing', line: 3 };
  assert.equal(diagnosticIdentity(original), diagnosticIdentity({ ...original, line: 9 }));
  assert.notEqual(diagnosticIdentity(original), diagnosticIdentity({ ...original, file: 'two.js' }));
  assert.notEqual(diagnosticIdentity(original), diagnosticIdentity({ ...original, span: 'different' }));
  assert.notEqual(diagnosticIdentity({ code: 'UI_TREE_REF_UNRESOLVED', name: 'old' }),
    diagnosticIdentity({ code: 'UI_TREE_REF_UNRESOLVED', name: 'new' }));
});

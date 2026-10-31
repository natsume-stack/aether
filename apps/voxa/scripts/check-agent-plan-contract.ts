import assert from 'node:assert/strict';

import { validateVoxaAiPlan } from '../server/ai-planner';

const plan = validateVoxaAiPlan({
  message: 'ok',
  commands: [{ kind: 'paint', args: { at: [0, 0, 0], colorId: 1 } }],
});
assert.equal(plan.done, false, 'commands without done must continue the loop');

assert.equal(validateVoxaAiPlan({ message: 'advice', commands: [] }).done, true);
assert.equal(validateVoxaAiPlan({ message: 'done', commands: [], done: true }).done, true);
assert.equal(
  validateVoxaAiPlan({ message: 'partial', commands: [{ kind: 'trim', args: {} }], done: false }).done,
  false,
);

assert.throws(() => validateVoxaAiPlan(null));
assert.throws(() => validateVoxaAiPlan({ message: 'x', commands: [{ kind: 'rm -rf', args: {} }] }));
assert.throws(() => validateVoxaAiPlan({ message: 'x', commands: [{ kind: 'paint', args: [] }] }));
assert.throws(() => validateVoxaAiPlan({ message: 'x', commands: [], done: 'yes' }));
assert.throws(() => validateVoxaAiPlan({ message: 'x', commands: new Array(33).fill({ kind: 'trim', args: {} }) }));

console.log('voxa agent plan contract passed');

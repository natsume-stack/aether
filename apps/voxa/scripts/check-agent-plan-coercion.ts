import assert from 'node:assert/strict';

import { coerceCommand, coercePlanValue } from '../server/ai-planner';

const deepseek = {
  commands: [
    { tool: 'palette_add', alias: '$bat', rgb: [46, 33, 64] },
    { tool: 'palette_add', alias: '$eye', rgb: [255, 70, 70], emissive: 1 },
    { tool: 'part_create', alias: '$bat', name: '蝙蝠' },
    { tool: 'fill_box', from: [7, 5, 7], to: [8, 9, 8], colorId: '$bat' },
    { tool: 'paint', at: [7, 12, 7], colorId: '$bat' },
  ],
  message: '已创建蝙蝠',
  done: false,
};

const plan = coercePlanValue(deepseek);
assert.equal(plan.rejected, 0);
assert.equal(plan.commands.length, 5);
assert.equal(plan.commands[0].kind, 'palette_add');
assert.deepEqual(plan.commands[0].args, { alias: '$bat', rgb: [46, 33, 64] });
assert.equal(plan.commands[2].kind, 'part_create');
assert.equal(plan.commands[3].kind, 'fill_box');
assert.equal(plan.commands[3].args.colorId, '$bat');
assert.equal(plan.done, false);

assert.equal(coerceCommand({ kind: 'paint', args: { at: [0, 0, 0], colorId: 1 } })?.kind, 'paint');
assert.equal(coerceCommand({ type: 'setColor', args: { id: 2 } })?.kind, 'set_color');
assert.equal(coerceCommand({ action: 'fill', start: [0, 0, 0], end: [1, 1, 1], color: 3 })?.kind, 'fill_box');
assert.deepEqual(
  coerceCommand({ action: 'fill', start: [0, 0, 0], end: [1, 1, 1], color: 3 })?.args,
  { start: [0, 0, 0], end: [1, 1, 1], color: 3, from: [0, 0, 0], to: [1, 1, 1], colorId: 3 },
);
assert.equal(coerceCommand({ tool: 'createPart', alias: '$x' })?.kind, 'part_create');
assert.equal(coerceCommand({ function: { name: 'paint', arguments: '{"at":[1,2,3],"colorId":4}' } })?.kind, 'paint');
assert.equal(coerceCommand({ tool: 'rm -rf', args: {} }), undefined);
assert.equal(coerceCommand({ kind: 'paint', args: [] }), undefined);

const rejected = coercePlanValue({ commands: [{ tool: 'nope' }], message: 'x' });
assert.equal(rejected.commands.length, 0);
assert.equal(rejected.rejected, 1);
assert.deepEqual(rejected.rejectedKinds, ['nope']);

const advice = coercePlanValue({ commands: [], message: '需要更多信息' });
assert.equal(advice.done, true);

const arrayOnly = coercePlanValue([{ tool: 'trim' }]);
assert.equal(arrayOnly.commands[0].kind, 'trim');
assert.equal(arrayOnly.done, false);

console.log('voxa plan coercion passed');

assert.equal(coerceCommand({ cmd: 'palette_add', alias: '$fur', rgb: [1, 2, 3] })?.kind, 'palette_add');
assert.deepEqual(coerceCommand({ palette_add: { alias: '$fur', rgb: [1, 2, 3] } })?.args, { alias: '$fur', rgb: [1, 2, 3] });
assert.equal(coerceCommand({ name: 'paint', arguments: '{"at":[1,1,1],"colorId":2}' })?.kind, 'paint');
assert.equal(coerceCommand({ type: 'tool_use', name: 'paint', input: { at: [1, 1, 1], colorId: 2 } })?.kind, 'paint');
assert.equal(coerceCommand({ type: 'function', function: { name: 'paint', arguments: '{"at":[1,1,1],"colorId":2}' } })?.kind, 'paint');
assert.equal(coerceCommand({ type: 'function_call', name: 'paint', arguments: '{"at":[1,1,1],"colorId":2}' })?.kind, 'paint');
assert.equal(coerceCommand({ functionCall: { name: 'paint', args: { at: [1, 1, 1], colorId: 2 } } })?.kind, 'paint');

const deepseekStream = coercePlanValue({
  commands: [
    { palette_add: { alias: '$fur', rgb: [46, 33, 64] } },
    { palette_add: { alias: '$eye', rgb: [255, 70, 70], emissive: 1 } },
    { part_create: { alias: '$bat', name: '蝙蝠' } },
    { fill_box: { from: [7, 5, 7], to: [8, 9, 8], colorId: '$bat' } },
  ],
  message: '已创建蝙蝠',
  done: false,
});
assert.equal(deepseekStream.rejected, 0);
assert.deepEqual(deepseekStream.commands.map((item) => item.kind), ['palette_add', 'palette_add', 'part_create', 'fill_box']);

const deepseekCmd = coercePlanValue({
  commands: [
    { cmd: 'palette_add', alias: '$fur', rgb: [68, 50, 90] },
    { cmd: 'part_create', alias: '$bat', name: 'Bat' },
  ],
  message: 'ok',
  done: false,
});
assert.equal(deepseekCmd.rejected, 0);
assert.equal(deepseekCmd.commands[1].kind, 'part_create');

const noise = coercePlanValue({ output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [] }, { type: 'function_call', name: 'paint', arguments: '{"at":[1,1,1],"colorId":1}' }] });
assert.equal(noise.commands.length, 1);
assert.equal(noise.rejected, 0);

console.log('gateway shape compatibility passed');

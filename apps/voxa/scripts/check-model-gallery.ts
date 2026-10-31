import assert from 'node:assert/strict';
import { retrieveDesignReferences } from '../server/model-gallery';

for (const prompt of ['精细建模一只蝙蝠', '做一辆汽车', '设计一个人形角色']) {
  const references = retrieveDesignReferences(prompt, 3);
  assert.ok(references.length > 0, prompt);
  for (const reference of references) {
    assert.ok(reference.title && reference.source, reference);
    assert.ok(Array.isArray(reference.dimensions));
    assert.ok(typeof reference.nodes === 'number');
  }
  console.log(prompt, references.map((item) => `${item.title}(${item.nodes}n/${item.palette}c)`).join(' | '));
}
console.log('model gallery references passed');

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from '@box/apis';
import { uploadLocalResource, localResourceIds } from '../src/apis/local-api/resource-upload';

test('binary uploads parse the content host hash as text, not JSON', async () => {
  const file = new Blob(['image fixture'], { type: 'image/png' });
  const api = new ApiClient({
    baseUrl: 'http://runtime.test',
    fetch: async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(new URL(request.url).pathname, '/block');
      assert.equal(request.headers.get('Content-Type'), 'image/png');
      assert.equal(await request.text(), 'image fixture');
      return new Response('QmaxpsL8GhFixtureHash', { headers: { 'Content-Type': 'application/octet-stream' } });
    },
  });
  assert.equal(await uploadLocalResource(api, file), 'QmaxpsL8GhFixtureHash');
});

test('upload failures and invalid success bodies do not become resource hashes', async () => {
  for (const response of [new Response('failed', { status: 500 }), new Response(''), new Response('<html>error</html>')]) {
    const api = new ApiClient({ baseUrl: 'http://runtime.test', fetch: async () => response });
    await assert.rejects(uploadLocalResource(api, new Blob(['fixture'])));
  }
});

test('resource IDs support contexts without randomUUID using secure random bytes', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let seed = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues(bytes: Uint8Array) { bytes.fill(++seed); return bytes; },
  } });
  try {
    const ids = localResourceIds(3);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) assert.match(id, /^local-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(localResourceIds(0), []);
    assert.equal(localResourceIds(1001).length, 1000);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

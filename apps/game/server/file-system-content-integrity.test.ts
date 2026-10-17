import { afterEach, expect, test } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import { FileSystemContentServer } from '../../../packages/content-server/src/file-system-store-node';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(['buffer', 'view'])(
  'persisted %s bytes match the hash even when the caller reuses its serialization buffer',
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'box-content-integrity-'));
    roots.push(root);
    const store = new FileSystemContentServer(root);
    const backing = Buffer.from('prefix-original-model-bytes-suffix');
    const input =
      kind === 'buffer' ? backing : new Uint8Array(backing.buffer, backing.byteOffset + 7, 20);
    const original = Buffer.from(input);
    const expected = bs58.encode(
      Buffer.concat([Buffer.from([0x12, 0x20]), createHash('sha256').update(original).digest()]),
    );
    const pending = store.store(input);
    backing.fill(0);
    const hash = await pending;
    expect(hash).toBe(expected);
    expect(Buffer.from((await store.retrieve(hash))!)).toEqual(original);
  },
);

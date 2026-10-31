/**
 * Durable conversation store checks.
 *
 * Run from apps/voxa:
 *   node -r ts-node/register/transpile-only scripts/check-agent-conversation-store.ts
 *
 * VOXA_DATA_PATH is read lazily on every call by server/agent-conversation, so
 * pointing it at a temp directory here is enough to keep the real data dir clean.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONVERSATION_FILE_RETENTION_MS,
  CONVERSATION_MAX_FILE_BYTES,
  CONVERSATION_TTL_MS,
  clearConversation,
  conversationFileKey,
  conversationFilePath,
  conversationKey,
  hydrateConversation,
  loadConversation,
  loadConversationContext,
  saveConversation,
  type ConversationMessage,
} from '../server/agent-conversation';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxa-conversation-store-'));
process.env.VOXA_DATA_PATH = root;
const storeDir = path.join(root, 'ai-conversations');

const messages: ConversationMessage[] = [
  { role: 'system', content: 'You are the VOXA voxel assistant.' },
  { role: 'user', content: '把一个方块改成红色' },
  { role: 'assistant', content: '{"message":"ok","commands":[]}' },
];
const context = { projectId: 42, voxelContext: { partId: 'p1', cells: [[1, 0, 0, 2]] }, parts: [{ id: 'b' }] };

const tests: Array<[string, () => void]> = [];
function test(name: string, run: () => void) {
  tests.push([name, run]);
}

function writeFile(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}

test('paths use a SHA-256 of the logical key, never raw input', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'chat-1');
  const file = conversationFilePath(key);
  assert.ok(file.startsWith(storeDir + path.sep));
  assert.match(path.basename(file), /^[0-9a-f]{64}\.json$/);
  assert.equal(path.basename(file), `${conversationFileKey(key)}.json`);
  assert.ok(!file.includes('SYSTEM'), 'system prompt must not reach the path');
  assert.ok(!file.includes('chat-1'), 'conversation id must not reach the path');
});

test('VOXA_DATA_PATH falls back to <cwd>/.voxa-data', () => {
  const saved = process.env.VOXA_DATA_PATH;
  delete process.env.VOXA_DATA_PATH;
  try {
    const expected = path.join(process.cwd(), '.voxa-data', 'ai-conversations') + path.sep;
    assert.ok(conversationFilePath('k').startsWith(expected));
  } finally {
    process.env.VOXA_DATA_PATH = saved;
  }
});

test('project scope is part of the key and is sanitised', () => {
  const plain = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'chat-1');
  const project = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'chat-1', 'project-42');
  assert.notEqual(plain, project);
  assert.ok(project.endsWith(':project:project-42'));
  assert.equal(conversationKey('u1', 'prov', 'model', 'SYSTEM', 'chat-1', null), plain);
  assert.equal(conversationKey('u1', 'prov', 'model', 'SYSTEM', 'chat-1', ''), plain);

  const hostile = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'chat-1', '../../etc/passwd');
  assert.ok(!hostile.includes('/') && !hostile.includes('..'));
  assert.ok(hostile.startsWith(`${plain}:project:h`));
  assert.notEqual(conversationFilePath(hostile), conversationFilePath(plain));
});

test('save writes memory and a 0600 file with messages, context and updatedAt', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'round-trip', 'project-42');
  saveConversation(key, messages, context);
  const file = conversationFilePath(key);
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.keyHash, conversationFileKey(key));
  assert.ok(Number.isFinite(stored.updatedAt) && stored.updatedAt > 0);
  assert.deepEqual(stored.messages, messages);
  assert.deepEqual(stored.context, context);
  assert.deepEqual(loadConversation(key), messages);
  assert.deepEqual(loadConversationContext(key), context);
  assert.deepEqual(fs.readdirSync(storeDir).filter((name) => name.includes('.tmp-')), []);
});

test('atomic writes leave no temp files even when overwriting', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'overwrite');
  saveConversation(key, messages, { step: 1 });
  const next = [...messages, { role: 'user' as const, content: 'second turn' }];
  saveConversation(key, next, { step: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(conversationFilePath(key), 'utf8')).messages, next);
  assert.deepEqual(fs.readdirSync(storeDir).filter((name) => name.includes('.tmp-')), []);
});

test('hydrates from disk after the in-memory entry is gone (simulated restart)', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'restart-local');
  saveConversation(key, messages, context);
  const file = conversationFilePath(key);
  const raw = fs.readFileSync(file, 'utf8');

  clearConversation(key);
  assert.equal(fs.existsSync(file), false, 'clear must remove the file as well as memory');
  assert.equal(loadConversation(key), undefined);

  writeFile(file, raw);
  assert.deepEqual(loadConversation(key), messages);
  assert.deepEqual(loadConversationContext(key), context);

  // The disk read repopulated memory: deleting the file no longer loses the thread.
  fs.unlinkSync(file);
  assert.deepEqual(loadConversation(key), messages);
  assert.deepEqual(loadConversationContext(key), context);
});

test('hydrateConversation is an explicit disk refill', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'hydrate');
  saveConversation(key, messages, context);
  const file = conversationFilePath(key);
  const raw = fs.readFileSync(file, 'utf8');
  clearConversation(key);
  writeFile(file, raw);
  assert.deepEqual(hydrateConversation(key), messages);
  fs.unlinkSync(file);
  assert.deepEqual(loadConversation(key), messages);
});

test('a fresh node process reads the persisted conversation', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'fresh-process', 'project-42');
  saveConversation(key, messages, context);
  const script = [
    "const store = require('./server/agent-conversation');",
    'const key = process.env.CONVERSATION_CHECK_KEY;',
    'process.stdout.write(JSON.stringify({messages: store.loadConversation(key), context: store.loadConversationContext(key)}));',
  ].join('');
  const output = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, VOXA_DATA_PATH: root, CONVERSATION_CHECK_KEY: key },
    encoding: 'utf8',
  }).trim();
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.messages, messages);
  assert.deepEqual(parsed.context, context);
});

test('files older than the retention window are ignored and removed', () => {
  assert.equal(CONVERSATION_TTL_MS, 3 * 60 * 60 * 1000);
  assert.equal(CONVERSATION_FILE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);

  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'stale');
  saveConversation(key, messages, context);
  const file = conversationFilePath(key);
  const raw = fs.readFileSync(file, 'utf8');
  clearConversation(key);

  const stale = JSON.parse(raw);
  stale.updatedAt = Date.now() - CONVERSATION_FILE_RETENTION_MS - 60_000;
  writeFile(file, stale);
  assert.equal(loadConversation(key), undefined);
  assert.equal(fs.existsSync(file), false, 'expired files are cleaned up');
});

test('the short memory TTL does not drop durable conversations', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'ttl');
  saveConversation(key, messages, context);
  const future = Date.now() + CONVERSATION_TTL_MS + 60_000;
  assert.deepEqual(loadConversation(key, future), messages);
  assert.deepEqual(loadConversationContext(key, future), context);
});

test('malformed, mismatched and out-of-contract files are ignored safely', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'malformed');
  const file = conversationFilePath(key);
  const base = { version: 1, keyHash: conversationFileKey(key), updatedAt: Date.now(), messages };

  writeFile(file, '{not json');
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, keyHash: 'deadbeef' });
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, version: 2 });
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, messages: [{ role: 'admin', content: 'x' }] });
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, messages: [{ role: 'user', content: 42 }] });
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, messages: new Array(41).fill({ role: 'user', content: 'x' }) });
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, messages: [{ role: 'user', content: 'x'.repeat(400_001) }] });
  assert.equal(loadConversation(key), undefined);
  writeFile(file, { ...base, messages, updatedAt: 'yesterday' });
  assert.equal(loadConversation(key), undefined);

  saveConversation(key, messages, context);
  assert.deepEqual(loadConversation(key), messages);
});

test('files larger than 2MB are skipped and oversized contexts are dropped', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'oversized');
  const file = conversationFilePath(key);
  const huge = 'x'.repeat(CONVERSATION_MAX_FILE_BYTES + 1024);
  writeFile(file, { version: 1, keyHash: conversationFileKey(key), updatedAt: Date.now(), messages: [{ role: 'user', content: 'hi' }], context: { huge } });
  assert.ok(fs.statSync(file).size > CONVERSATION_MAX_FILE_BYTES);
  assert.equal(loadConversation(key), undefined);
  assert.ok(fs.existsSync(file), 'oversized files are skipped, not rewritten');

  const key2 = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'oversized-save');
  saveConversation(key2, messages, { huge: 'x'.repeat(CONVERSATION_MAX_FILE_BYTES + 1024) });
  const file2 = conversationFilePath(key2);
  assert.ok(fs.statSync(file2).size <= CONVERSATION_MAX_FILE_BYTES);
  const stored = JSON.parse(fs.readFileSync(file2, 'utf8'));
  assert.equal(stored.context, undefined);
  assert.deepEqual(stored.messages, messages);
  assert.equal(loadConversationContext(key2), undefined);
  assert.deepEqual(loadConversation(key2), messages);
});

test('compaction happens before writing', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'compact');
  const many: ConversationMessage[] = [];
  for (let index = 0; index < 30; index += 1) {
    many.push({ role: 'user', content: `q${index}` });
    many.push({ role: 'assistant', content: `a${index}` });
  }
  const kept = saveConversation(key, many, { projectId: 7 });
  assert.equal(kept.length, 40);
  const stored = JSON.parse(fs.readFileSync(conversationFilePath(key), 'utf8'));
  assert.equal(stored.messages.length, 40);
  assert.equal(stored.context, undefined, 'reset history also resets context');
  assert.equal(stored.messages[39].content, 'a29');
});

test('projects and conversations stay isolated', () => {
  const shared = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'isolation', 'project-a');
  const otherProject = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'isolation', 'project-b');
  const otherChat = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'isolation-2', 'project-a');
  saveConversation(shared, [{ role: 'user', content: 'only project a' }], { projectId: 'a' });
  assert.equal(loadConversation(otherProject), undefined);
  assert.equal(loadConversation(otherChat), undefined);
  const copy = loadConversation(shared);
  assert.ok(copy);
  copy[0].content = 'mutated';
  assert.equal(loadConversation(shared)![0].content, 'only project a', 'loads are copies');
});

test('clear removes memory and disk but leaves other conversations alone', () => {
  const key = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'clear-me');
  const neighbour = conversationKey('u1', 'prov', 'model', 'SYSTEM', 'keep-me');
  saveConversation(key, messages, context);
  saveConversation(neighbour, messages, context);
  clearConversation(key);
  clearConversation(conversationKey('u1', 'prov', 'model', 'SYSTEM', 'never-saved'));
  assert.equal(loadConversation(key), undefined);
  assert.equal(fs.existsSync(conversationFilePath(key)), false);
  assert.deepEqual(loadConversation(neighbour), messages);
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} of ${tests.length} checks failed`);
  process.exitCode = 1;
} else {
  console.log(`all ${tests.length} checks passed`);
}

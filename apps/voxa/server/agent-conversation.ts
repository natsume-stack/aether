import { createHash } from 'node:crypto';

export type ConversationRole = 'system' | 'user' | 'assistant';
export type ConversationMessage = { role: ConversationRole; content: string };

type Entry = { messages: ConversationMessage[]; context?: unknown; updatedAt: number };

const TTL_MS = 3 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_MESSAGES = 40;
const MAX_CHARS = 400_000;
const store = new Map<string, Entry>();

export function systemFingerprint(system: string) {
  return createHash('sha256').update(system).digest('hex').slice(0, 16);
}

export function conversationKey(userId: string, providerId: string, model: string, system: string, conversationId: string) {
  return `${userId}:${providerId}:${model}:${systemFingerprint(system)}:${conversationId}`;
}

function prune(now = Date.now()) {
  for (const [key, entry] of store) {
    if (now - entry.updatedAt > TTL_MS) store.delete(key);
  }
}

export function loadConversation(key: string): ConversationMessage[] | undefined {
  prune();
  const entry = store.get(key);
  if (!entry) return undefined;
  entry.updatedAt = Date.now();
  return entry.messages.map((message) => ({ ...message }));
}

function compact(messages: ConversationMessage[]) {
  const system = messages.filter((message) => message.role === 'system');
  let rest = messages.filter((message) => message.role !== 'system');
  if (rest.length + system.length > MAX_MESSAGES) {
    rest = rest.slice(-(MAX_MESSAGES - system.length));
    while (rest.length && rest[0].role !== 'user') rest = rest.slice(1);
  }
  let list = [...system, ...rest];
  let chars = list.reduce((total, message) => total + message.content.length, 0);
  while (chars > MAX_CHARS && list.length > 4) {
    // Drop the oldest user/assistant pair so the role alternation stays valid.
    const drop = list[1]?.role === 'assistant' ? 1 : 2;
    list = [...list.slice(0, 1), ...list.slice(1 + drop)];
    chars = list.reduce((total, message) => total + message.content.length, 0);
  }
  return list;
}

export function saveConversation(key: string, messages: ConversationMessage[], context?: unknown) {
  const list = compact(messages);
  const compacted = list.length !== messages.length;
  store.set(key, { messages: list.map((message) => ({ ...message })), context: compacted ? undefined : context, updatedAt: Date.now() });
  if (store.size > MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [entryKey] of oldest.slice(0, store.size - MAX_ENTRIES)) store.delete(entryKey);
  }
  return list;
}

export function loadConversationContext(key: string): unknown {
  prune();
  return store.get(key)?.context;
}

export function clearConversation(key: string) {
  store.delete(key);
}

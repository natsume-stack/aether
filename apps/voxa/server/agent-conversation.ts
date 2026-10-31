import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ConversationRole = 'system' | 'user' | 'assistant';
export type ConversationMessage = { role: ConversationRole; content: string };

type Entry = { messages: ConversationMessage[]; context?: unknown; updatedAt: number };
type StoredFile = { version: number; keyHash: string; updatedAt: number; messages: ConversationMessage[]; context?: unknown };

/** Memory cache TTL. Disk copies are kept far longer so a restart does not lose the thread. */
export const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000;
/** Durable copies older than this are ignored (and removed on the next read). */
export const CONVERSATION_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard bound for a single persisted conversation file. */
export const CONVERSATION_MAX_FILE_BYTES = 2 * 1024 * 1024;

const MAX_ENTRIES = 200;
const MAX_MESSAGES = 40;
const MAX_CHARS = 400_000;
const STORE_DIRNAME = 'ai-conversations';
const FILE_VERSION = 1;
const TMP_MARKER = '.tmp-';

const store = new Map<string, Entry>();
let writeSequence = 0;

/**
 * Resolved on every call so a process can point VOXA_DATA_PATH at a temp dir
 * (tests, launcher reconfiguration) without a module reload.
 */
function storeDirectory() {
  const configured = (process.env.VOXA_DATA_PATH || '').trim();
  return path.join(path.resolve(configured || path.join(process.cwd(), '.voxa-data')), STORE_DIRNAME);
}

/** SHA-256 of the logical key: the only thing that ever becomes part of a path. */
export function conversationFileKey(key: string) {
  return createHash('sha256').update(String(key)).digest('hex');
}

export function conversationFilePath(key: string) {
  return path.join(storeDirectory(), `${conversationFileKey(key)}.json`);
}

export function systemFingerprint(system: string) {
  return createHash('sha256').update(system).digest('hex').slice(0, 16);
}

const SAFE_SCOPE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Builds the logical conversation key. `projectId` is optional and appended as
 * its own scope segment so old five-argument callers keep the exact same key.
 * The key is hashed before touching the filesystem, but the project segment is
 * still sanitised so keys stay readable in logs and never contain separators.
 */
export function conversationKey(userId: string, providerId: string, model: string, system: string, conversationId: string, projectId?: string | number | null) {
  const base = `${userId}:${providerId}:${model}:${systemFingerprint(system)}:${conversationId}`;
  const raw = projectId === undefined || projectId === null ? '' : String(projectId).trim();
  if (!raw) return base;
  const scope = SAFE_SCOPE.test(raw) ? raw : `h${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  return `${base}:project:${scope}`;
}

function prune(now = Date.now()) {
  for (const [key, entry] of store) {
    if (now - entry.updatedAt > CONVERSATION_TTL_MS) store.delete(key);
  }
}

function remember(key: string, entry: Entry) {
  store.set(key, entry);
  if (store.size <= MAX_ENTRIES) return;
  const oldest = [...store.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  for (const [entryKey] of oldest) {
    if (store.size <= MAX_ENTRIES) break;
    if (entryKey !== key) store.delete(entryKey);
  }
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

function cleanMessage(value: unknown): ConversationMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { role?: unknown; content?: unknown };
  if (record.role !== 'system' && record.role !== 'user' && record.role !== 'assistant') return undefined;
  if (typeof record.content !== 'string') return undefined;
  return { role: record.role, content: record.content.length > MAX_CHARS ? record.content.slice(0, MAX_CHARS) : record.content };
}

/** Lenient: used for caller-supplied history before compaction. */
function sanitizeMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const list: ConversationMessage[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const clean = cleanMessage(message);
    if (clean) list.push(clean);
  }
  return list;
}

/** Strict: a persisted file must be fully valid or it is ignored wholesale. */
function readMessages(value: unknown): ConversationMessage[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return undefined;
  const list: ConversationMessage[] = [];
  let chars = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const record = item as { role?: unknown; content?: unknown };
    if (record.role !== 'system' && record.role !== 'user' && record.role !== 'assistant') return undefined;
    if (typeof record.content !== 'string' || record.content.length > MAX_CHARS) return undefined;
    chars += record.content.length;
    if (chars > MAX_CHARS) return undefined;
    list.push({ role: record.role, content: record.content });
  }
  return list;
}

function readContext(value: unknown): unknown {
  return value && typeof value === 'object' ? value : undefined;
}

function jsonBuffer(payload: StoredFile) {
  try {
    return Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Writes `{messages, context, updatedAt}` next to a SHA-256 of the logical key.
 * Returns the context that actually made it to disk so memory and disk agree.
 */
function persist(key: string, messages: ConversationMessage[], context: unknown, updatedAt = Date.now()) {
  const hash = conversationFileKey(key);
  const directory = storeDirectory();
  const file = path.join(directory, `${hash}.json`);
  let storedContext = context;
  let buffer = jsonBuffer({ version: FILE_VERSION, keyHash: hash, updatedAt, messages, context: storedContext });
  if (!buffer && storedContext !== undefined) {
    // Context is not JSON-safe: keep the conversation, drop the context.
    storedContext = undefined;
    buffer = jsonBuffer({ version: FILE_VERSION, keyHash: hash, updatedAt, messages });
  }
  if (buffer && buffer.length > CONVERSATION_MAX_FILE_BYTES && storedContext !== undefined) {
    storedContext = undefined;
    buffer = jsonBuffer({ version: FILE_VERSION, keyHash: hash, updatedAt, messages });
  }
  if (!buffer || buffer.length > CONVERSATION_MAX_FILE_BYTES) return { written: false, context: storedContext };

  const temporary = path.join(directory, `${TMP_MARKER}${hash}.${process.pid}.${(writeSequence++).toString(36)}`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, buffer, { mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort outside POSIX */ }
    // Rename is atomic: readers see either the old file or the new one, never a partial write.
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort outside POSIX */ }
    return { written: true, context: storedContext };
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
    return { written: false, context: storedContext };
  }
}

function forgetFile(file: string) {
  try { fs.unlinkSync(file); } catch { /* already gone or not removable */ }
}

function readStoredFile(key: string, now: number): Entry | undefined {
  const file = conversationFilePath(key);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > CONVERSATION_MAX_FILE_BYTES) return undefined;

  let raw: StoredFile;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || raw.version !== FILE_VERSION || raw.keyHash !== conversationFileKey(key)) return undefined;
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  if (updatedAt <= 0) return undefined;
  if (now - updatedAt > CONVERSATION_FILE_RETENTION_MS) {
    // Past the retention window: drop it so the directory does not grow forever.
    forgetFile(file);
    return undefined;
  }
  // A file dated far in the future means a skewed clock; ignore it but keep the
  // data around in case the clock is corrected.
  if (updatedAt > now + 60 * 60 * 1000) return undefined;
  const messages = readMessages(raw.messages);
  if (!messages) return undefined;
  return { messages, context: readContext(raw.context), updatedAt: now };
}

/** Disk -> memory. Used by the load helpers and exported for callers that want an explicit refill. */
export function hydrateConversation(key: string, now = Date.now()): ConversationMessage[] | undefined {
  const entry = readStoredFile(key, now);
  if (!entry) return undefined;
  remember(key, entry);
  return entry.messages.map((message) => ({ ...message }));
}

export function loadConversation(key: string, now = Date.now()): ConversationMessage[] | undefined {
  prune(now);
  const entry = store.get(key);
  if (entry) {
    entry.updatedAt = now;
    return entry.messages.map((message) => ({ ...message }));
  }
  return hydrateConversation(key, now);
}

export function loadConversationContext(key: string, now = Date.now()): unknown {
  prune(now);
  const entry = store.get(key);
  if (entry) {
    entry.updatedAt = now;
    return entry.context;
  }
  return hydrateConversation(key, now) ? store.get(key)?.context : undefined;
}

export function saveConversation(key: string, messages: ConversationMessage[], context?: unknown) {
  const sanitized = sanitizeMessages(messages);
  const list = compact(sanitized);
  const compacted = list.length !== sanitized.length;
  const saved = persist(key, list, compacted ? undefined : context);
  remember(key, {
    messages: list.map((message) => ({ ...message })),
    // A compacted history resets context (the planner sends a full snapshot next
    // turn); otherwise mirror whatever actually reached the file.
    context: compacted ? undefined : saved.context,
    updatedAt: Date.now(),
  });
  return list;
}

export function clearConversation(key: string) {
  store.delete(key);
  forgetFile(conversationFilePath(key));
}

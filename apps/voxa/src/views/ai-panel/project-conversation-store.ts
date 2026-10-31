type StoredConversation = { messages: unknown[]; updatedAt: number };

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('box3-voxa-ai-conversations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开 AI 会话存储'));
  });
}

async function transaction<T>(key: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('projects', mode);
      const request = action(tx.objectStore('projects'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('AI 会话保存失败，请检查浏览器存储空间'));
    });
  } finally {
    db.close();
  }
}

export async function loadProjectMessages(projectId: string): Promise<unknown[] | undefined> {
  const stored = await transaction<StoredConversation | undefined>(projectId, 'readonly', (store) => store.get(projectId));
  return Array.isArray(stored?.messages) ? stored!.messages.slice(-40) : undefined;
}

export async function saveProjectMessages(projectId: string, messages: unknown[]) {
  const value: StoredConversation = { messages: messages.slice(-40), updatedAt: Date.now() };
  await transaction(projectId, 'readwrite', (store) => store.put(value, projectId));
}

export async function clearProjectMessages(projectId: string) {
  await transaction(projectId, 'readwrite', (store) => store.delete(projectId));
}

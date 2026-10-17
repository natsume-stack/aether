type Entry = { listeners: Set<(value: object) => void>; timer: ReturnType<typeof setInterval>; busy: boolean; latest?: object };
const state = globalThis as typeof globalThis & { __boxRealtimeSnapshots?: Map<string, Entry> };
const entries = state.__boxRealtimeSnapshots ||= new Map<string, Entry>();
export function subscribeSnapshot(key: string, read: () => Promise<object>, send: (value: object) => void) {
  let entry = entries.get(key);
  if (!entry) {
    const listeners = new Set<(value: object) => void>();
    const sample = async () => {
      if (entry!.busy) return;
      entry!.busy = true;
      try {
        const data = await read();
        if (JSON.stringify(data) !== JSON.stringify(entry!.latest)) {
          entry!.latest = data;
          for (const listener of [...listeners]) listener({ type: 'snapshot', data });
        }
      } catch { for (const listener of [...listeners]) listener({ type: 'error', message: '状态采集失败' }); }
      finally { entry!.busy = false; }
    };
    const timer = setInterval(() => { void sample(); }, 5000); timer.unref?.();
    entry = { listeners, timer, busy: false }; entries.set(key, entry);
    void Promise.resolve().then(sample);
  }
  entry.listeners.add(send);
  if (entry.latest) send({ type: 'snapshot', data: entry.latest });
  return () => { entry!.listeners.delete(send); if (!entry!.listeners.size) { clearInterval(entry!.timer); entries.delete(key); } };
}

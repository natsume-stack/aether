import { useEffect, useMemo, useRef, useState } from 'react';
import { clientConfig } from 'src/config/client';
import style from './style.module.scss';
import { TerrainProposals } from './proposals';

/**
 * Local-only "AI 编辑动态" feed.
 *
 * The engine exposes a loopback-only event tap at `${runtime}/internal/edit-events`.
 * Through the Creator app the runtime base is already the same-origin
 * `/runtime/edit/<container>` proxy, so the browser never talks to a loopback
 * port directly and the engine keeps its loopback-only rule.
 */
type EditEventKind = 'terrain' | 'entities' | 'ui' | 'script' | 'unknown';

type EditEvent = {
  seq: number;
  at: number;
  kind: EditEventKind;
  actor: string;
  summary: string;
};

type EditEventSnapshot = {
  terrainRevision: string;
  entityCount: number;
  uiCount: number;
  lastSeq: number;
};

type ConnectionState = 'connecting' | 'live' | 'error';

const MAX_EVENTS = 60;
const MAX_SEEN = 600;

const KIND_LABEL: Record<string, string> = {
  terrain: '地形',
  entities: '实体',
  ui: '界面',
  script: '脚本',
  unknown: '其他',
};

function runtimeBaseURL() {
  return (clientConfig.BACKEND_SERVER_URL || '').replace(/\/$/, '');
}

function actorClass(actor: string) {
  return actor === 'human' ? style.actorHuman : style.actorAi;
}

function formatTime(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

export function AiActivityPanel() {
  const base = useMemo(runtimeBaseURL, []);
  const [open, setOpen] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [events, setEvents] = useState<EditEvent[]>([]);
  const [snapshot, setSnapshot] = useState<EditEventSnapshot>();
  const seen = useRef(new Set<number>());
  const runtimeId = useRef('');
  const eventsRef = useRef<EditEvent[]>([]);
  eventsRef.current = events;

  useEffect(() => {
    if (!base) return;
    const source = new EventSource(`${base}/internal/edit-events`);
    let disposed = false;

    source.onopen = () => {
      if (!disposed) setConnection('live');
    };
    source.onerror = () => {
      if (!disposed) setConnection('error');
    };
    source.onmessage = (message) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload.type === 'snapshot') {
        const nextRuntime = String(payload.runtimeId || '');
        if (nextRuntime !== runtimeId.current || payload.resetRequired === true) {
          runtimeId.current = nextRuntime;
          seen.current.clear();
          eventsRef.current = [];
          setEvents([]);
        }
        setSnapshot({
          terrainRevision: String(payload.terrainRevision || ''),
          entityCount: Number(payload.entityCount) || 0,
          uiCount: Number(payload.uiCount) || 0,
          lastSeq: Number(payload.lastSeq) || 0,
        });
        return;
      }
      if (payload.type !== 'event') return;
      const seq = Number(payload.seq);
      if (!Number.isFinite(seq) || seen.current.has(seq)) return;
      seen.current.add(seq);
      setSnapshot(current => current ? { ...current, lastSeq: Math.max(current.lastSeq, seq) } : current);
      if (seen.current.size > MAX_SEEN) {
        // Sequence numbers only grow, so everything older than the tail can be
        // forgotten without ever accepting a duplicate.
        seen.current = new Set(
          eventsRef.current.slice(0, MAX_EVENTS).map((event) => event.seq),
        );
        seen.current.add(seq);
      }
      const event: EditEvent = {
        seq,
        at: Number(payload.at) || Date.now(),
        kind: String(payload.kind || 'unknown') as EditEventKind,
        actor: String(payload.actor || 'human'),
        summary: String(payload.summary || ''),
      };
      setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
    };

    return () => {
      disposed = true;
      source.close();
    };
  }, [base]);

  if (!base) return null;

  const connectionLabel =
    connection === 'live' ? '实时' : connection === 'error' ? '重连中' : '连接中';

  return (
    <div className={style.root}>
      {open ? (
        <section className={style.panel} aria-label="AI 编辑动态">
          <header className={style.header}>
            <span className={`${style.dot} ${style[connection]}`} />
            <span className={style.title}>AI 编辑动态</span>
            <span className={style.connection}>{connectionLabel}</span>
            <button
              type="button"
              className={style.collapse}
              onClick={() => setOpen(false)}
              title="收起"
            >
              ×
            </button>
          </header>
          <div className={style.meta}>
            <span>事件序号 {snapshot?.lastSeq ?? 0}</span>
            <span>
              实体 {snapshot?.entityCount ?? '-'} · 界面{' '}
              {snapshot?.uiCount ?? '-'}
            </span>
          </div>
          <TerrainProposals base={base} />
          <ul className={style.list}>
            {events.length === 0 && (
              <li className={style.empty}>
                {connection === 'error'
                  ? '正在重新连接编辑动态…'
                  : '等待 AI 的编辑动作…'}
              </li>
            )}
            {events.map((event) => (
              <li key={event.seq} className={style.item}>
                <div className={style.itemHead}>
                  <span className={`${style.actor} ${actorClass(event.actor)}`}>
                    {event.actor}
                  </span>
                  <span className={style.kind}>
                    {KIND_LABEL[event.kind] || event.kind}
                  </span>
                  <span className={style.time}>{formatTime(event.at)}</span>
                </div>
                <div className={style.summary} title={event.summary}>
                  {event.summary}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <button
          type="button"
          className={style.collapsed}
          onClick={() => setOpen(true)}
          title="展开 AI 编辑动态"
        >
          <span className={`${style.dot} ${style[connection]}`} />
          AI 动态
          <span className={style.count}>{events.length}</span>
        </button>
      )}
    </div>
  );
}

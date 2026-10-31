import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientConfig } from 'src/config/client';
import style from './style.module.scss';

/**
 * Local-only "Agent Active" 工作台（识别码 / Agent / 日志 / 产物）。
 *
 * 识别码 = 这张地图的开发账号：把面板上的 MAP-xxxx 识别码发给一个 AI，它通过
 * POST /api/agent/v1/join 换取 agx_ 令牌后即可参与这张地图的全部开发（地形 /
 * 实体 / 界面 / 脚本 / 保存），每个动作都会回流到本面板。VOXA 的模型-only
 * 识别码在 VOXA 应用里展示（VOX-xxxx）。
 *
 * 数据源是同源的 /api/agent/v1/state（创建者会话鉴权），3s 轮询足够展示
 * 审计流；避免 SSE 再造一条通道。
 */
type AgentRow = {
  id: string;
  name: string;
  scope: string;
  joinedAt: string;
  lastSeenAt: string;
  fingerprint: string;
};

type LogRow = { at: string; agent: string; action: string; result: string; detail: string };

type ArtifactRow = { at: string; agent: string; kind: string; name: string; detail: string };

type AgentState = {
  code: string;
  codeUpdatedAt: string;
  agents: AgentRow[];
  logs: LogRow[];
  artifacts: ArtifactRow[];
  project: { id: string; name?: string; permanentMapId?: string };
  editorUrl?: string;
};

type LiveStatus = {
  attached: boolean;
  stale: boolean;
  attachedAt?: string;
  lastSeenAt?: string;
  lastSeq: number;
  queued: number;
  lastAction?: {
    kind: string;
    status: 'running' | 'ok' | 'error' | 'timeout';
    actor: { id: string; name: string };
    at: string;
    summary?: string;
  };
  snapshot?: {
    camera?: { eye?: number[]; target?: number[]; agentControlled?: boolean };
    cursor?: { voxel?: number[]; blockName?: string } | null;
    lookHit?: { voxel?: number[]; blockName?: string } | null;
    project?: { running?: boolean; name?: string };
  };
};

type LiveManifest = {
  baseUrl: string;
  editorUrl?: string;
  joinCode: string;
  mcpServers: Record<string, unknown>;
  endpoints: Record<string, string>;
  prerequisites?: string[];
  instructions: string[];
};

type Tab = 'live' | 'code' | 'agents' | 'logs' | 'artifacts';

type ConnectionState = 'connecting' | 'live' | 'error';

const TAB_LABEL: Record<Tab, string> = {
  live: '活体',
  code: '识别码',
  agents: 'Agent',
  logs: '日志',
  artifacts: '产物',
};

const RESULT_LABEL: Record<string, string> = {
  applied: '执行',
  refused: '拒绝',
  failed: '失败',
  saved: '保存',
  joined: '加入',
  rotated: '轮换',
  revoked: '吊销',
};

function formatTime(iso: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

export function AgentActivePanel() {
  const container = clientConfig.name || '';
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>('live');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [state, setState] = useState<AgentState>();
  const [live, setLive] = useState<LiveStatus>();
  const [manifest, setManifest] = useState<LiveManifest>();
  const [copied, setCopied] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [handoffCopied, setHandoffCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!container) return;
    try {
      const [stateResponse, liveResponse] = await Promise.all([
        fetch(`/api/agent/v1/state?container=${encodeURIComponent(container)}`),
        fetch(`/api/agent/v1/live/status?container=${encodeURIComponent(container)}`),
      ]);
      if (!mounted.current) return;
      if (stateResponse.status === 404) {
        // 地图不存在（可能已被删除）：面板退化为错误态而不是报错刷屏。
        setConnection('error');
        return;
      }
      const data = await stateResponse.json();
      if (!stateResponse.ok) throw new Error(data?.message || String(stateResponse.status));
      setState(data as AgentState);
      if (liveResponse.ok) setLive((await liveResponse.json()) as LiveStatus);
      setConnection('live');
    } catch {
      if (mounted.current) setConnection('error');
    }
  }, [container]);

  useEffect(() => {
    mounted.current = true;
    if (!container) return;
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [container, refresh]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        await fetch('/api/agent/v1/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ container, ...body }),
        });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [container, refresh],
  );

  const copyCode = useCallback(() => {
    if (!state?.code) return;
    void navigator.clipboard?.writeText(state.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [state?.code]);

  const copyMcpConfig = useCallback(async () => {
    if (!container) return;
    setBusy(true);
    try {
      let current = manifest;
      if (!current) {
        const response = await fetch(
          `/api/agent/v1/live/manifest?container=${encodeURIComponent(container)}`,
        );
        if (!response.ok) throw new Error(String(response.status));
        current = (await response.json()) as LiveManifest;
        setManifest(current);
      }
      await navigator.clipboard?.writeText(JSON.stringify(current.mcpServers, null, 2));
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 1800);
    } finally {
      setBusy(false);
    }
  }, [container, manifest]);

  // The smallest handoff that works: the editor URL a human must open, plus the
  // map code. The project id is discovered from the join response, never typed.
  const copyHandoff = useCallback(async () => {
    const editorUrl = state?.editorUrl || manifest?.editorUrl;
    if (!state?.code || !editorUrl) return;
    await navigator.clipboard?.writeText(`编辑器地址：${editorUrl}\n地图识别码：${state.code}`);
    setHandoffCopied(true);
    setTimeout(() => setHandoffCopied(false), 1800);
  }, [state?.code, state?.editorUrl, manifest?.editorUrl]);

  const activityCount = useMemo(
    () => (state?.logs.length || 0) + (state?.artifacts.length || 0),
    [state],
  );

  if (!container) return null;

  if (!open) {
    return (
      <div className={style.root}>
        <button
          type="button"
          className={style.collapsed}
          onClick={() => setOpen(true)}
          title="展开 Agent Active 工作台"
        >
          <span className={`${style.dot} ${style[connection]}`} />
          Agent Active
          <span className={style.count}>{activityCount}</span>
        </button>
      </div>
    );
  }

  const connectionLabel =
    connection === 'live' ? '实时' : connection === 'error' ? '离线' : '连接中';

  return (
    <div className={style.root}>
      <section className={style.panel} aria-label="Agent Active 工作台">
        <header className={style.header}>
          <span className={`${style.dot} ${style[connection]}`} />
          <span className={style.title}>Agent Active</span>
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
        <nav className={style.tabs}>
          {(Object.keys(TAB_LABEL) as Tab[]).map((item) => (
            <button
              key={item}
              type="button"
              className={`${style.tab} ${tab === item ? style.active : ''}`}
              onClick={() => setTab(item)}
            >
              {TAB_LABEL[item]}
              {item === 'agents' && state?.agents.length ? ` ${state.agents.length}` : ''}
            </button>
          ))}
        </nav>
        <div className={style.body}>
          {tab === 'live' && (
            <div>
              <div className={style.liveHead}>
                <span
                  className={`${style.dot} ${
                    live?.attached ? style.live : live?.stale ? style.error : style.connecting
                  }`}
                />
                <span className={style.liveTitle}>
                  {live?.attached
                    ? '编辑器已接入 AI 通道'
                    : live?.stale
                      ? '心跳超时'
                      : '等待 AI 接入'}
                </span>
                <span className={style.time}>
                  {live?.lastSeenAt ? formatTime(live.lastSeenAt) : ''}
                </span>
              </div>
              {live?.lastAction ? (
                <div className={style.liveAction}>
                  <div className={style.itemHead}>
                    <span className={style.badge}>
                      {live.lastAction.actor?.name || 'AI'}
                    </span>
                    <span className={style.kind}>{live.lastAction.kind}</span>
                    <span className={style.kind}>
                      {RESULT_LABEL[live.lastAction.status] || live.lastAction.status}
                    </span>
                    <span className={style.time}>{formatTime(live.lastAction.at)}</span>
                  </div>
                  <div className={style.summary}>{live.lastAction.summary}</div>
                </div>
              ) : (
                <p className={style.hint}>
                  复制下方 MCP 配置给 AI，即可读取现有地图、提出局部修改并应用或回滚。
                  创作进度会出现在“AI 编辑动态”；需要调整视角时，AI 也能操作相机和光标。
                </p>
              )}
              <div className={style.liveMeta}>
                <span>
                  光标{' '}
                  {live?.snapshot?.cursor?.voxel
                    ? live.snapshot.cursor.voxel.join(', ')
                    : '—'}
                </span>
                <span>
                  相机 {live?.snapshot?.camera?.agentControlled ? 'AI 控制中' : '人控制'}
                </span>
                <span>队列 {live?.queued ?? 0}</span>
              </div>
              <div className={style.codeRow}>
                <button
                  type="button"
                  className={style.smallBtn}
                  disabled={busy || !state?.code || !(state?.editorUrl || manifest?.editorUrl)}
                  onClick={copyHandoff}
                  title="复制给 AI 的最小信息：编辑器地址 + 地图识别码（project id 由 join 自动发现）"
                >
                  {handoffCopied ? '已复制' : '复制 地址+识别码'}
                </button>
                <button
                  type="button"
                  className={style.smallBtn}
                  disabled={busy}
                  onClick={copyMcpConfig}
                >
                  {mcpCopied ? '已复制' : '复制 MCP 配置'}
                </button>
              </div>
              <p className={style.hint} title={state?.editorUrl || manifest?.editorUrl}>
                <span className={style.kind}>AI 要打开的地址：</span>
                {state?.editorUrl || manifest?.editorUrl || '加载中…'}
              </p>
              <p className={style.hint}>
                先打开地图启动编辑运行时，再把地址和识别码交给 AI。
                AI 侧需要运行 MCP 客户端；地图数据工具由运行时执行，相机和光标操作需要此标签页保持打开。
              </p>
              <p className={style.hint}>
                人点击或滚动画面会自动交还视角；视角操作见“日志”，地图数据修改见“AI 编辑动态”。
              </p>
            </div>
          )}
          {tab === 'code' && (
            <div>
              <div className={style.codeRow}>
                <span className={style.code} title={state?.code}>
                  {state?.code || '— — —'}
                </span>
                <button type="button" className={style.smallBtn} onClick={copyCode}>
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  className={style.smallBtn}
                  disabled={busy}
                  onClick={() => post({ action: 'rotate-code' })}
                  title="作废旧识别码并生成新码（已加入的 agent 不受影响）"
                >
                  轮换
                </button>
              </div>
              <p className={style.hint}>
                把“编辑器地址 + 识别码”发给 AI 即等于发出这张图的开发邀请：AI 用它换取令牌后可参与
                这张地图的开发。令牌只对这张图有效，换图必须用那张图自己的码。
              </p>
              <p className={style.hint}>
                识别码请只发给信任的协作方，泄露后立即轮换；轮换后旧码无法再加入，
                已加入的 agent 不受影响（可在 Agent 页签单独吊销）。
              </p>
            </div>
          )}
          {tab === 'agents' && (
            <ul className={style.list}>
              {(state?.agents.length ?? 0) === 0 && (
                <li className={style.empty}>还没有 agent 加入；把识别码发给 AI 开始协作</li>
              )}
              {state?.agents.map((agent) => (
                <li key={agent.id} className={style.item}>
                  <div className={style.itemHead}>
                    <span className={style.badge}>{agent.name}</span>
                    <span className={style.kind}>{agent.fingerprint}</span>
                    <span className={style.time}>{formatTime(agent.lastSeenAt)}</span>
                  </div>
                  <div className={style.itemHead}>
                    <span className={style.summary}>
                      加入于 {formatTime(agent.joinedAt) || agent.joinedAt}
                    </span>
                    <button
                      type="button"
                      className={style.smallBtn}
                      disabled={busy}
                      onClick={() => post({ action: 'revoke-agent', agentId: agent.id })}
                    >
                      吊销
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tab === 'logs' && (
            <ul className={style.list}>
              {(state?.logs.length ?? 0) === 0 && (
                <li className={style.empty}>{connection === 'error' ? '状态不可用' : '等待 agent 动作…'}</li>
              )}
              {state?.logs.map((row, index) => (
                <li key={`${row.at}-${index}`} className={style.item}>
                  <div className={style.itemHead}>
                    <span className={`${style.badge} ${row.agent === 'owner' ? style.owner : ''}`}>
                      {row.agent}
                    </span>
                    <span className={style.kind}>{RESULT_LABEL[row.result] || row.result}</span>
                    <span className={style.kind}>{row.action}</span>
                    <span className={style.time}>{formatTime(row.at)}</span>
                  </div>
                  <div className={style.summary} title={row.detail}>
                    {row.detail}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tab === 'artifacts' && (
            <ul className={style.list}>
              {(state?.artifacts.length ?? 0) === 0 && (
                <li className={style.empty}>还没有产物登记（GDD / 地形 / 模型 / UI…）</li>
              )}
              {state?.artifacts.map((row, index) => (
                <li key={`${row.at}-${index}`} className={style.item}>
                  <div className={style.itemHead}>
                    <span className={style.badge}>{row.kind}</span>
                    <span className={style.kind}>{row.name}</span>
                    <span className={style.time}>{formatTime(row.at)}</span>
                  </div>
                  <div className={style.summary} title={row.detail}>
                    {row.agent} · {row.detail}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

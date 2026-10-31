import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import style from './style.module.scss';
import { useVoxaAgentPresence } from '../../utils/agent-presence';

/**
 * VOXA "Agent Active" 工作台（识别码 / Agent / 日志 / 产物）。
 *
 * VOX- 识别码 = 模型开发账号：发给 AI 后它仅参与模型构建（列出 / 导入
 * .voxaproject / 登记产物），不能触碰地图。地图侧的 MAP- 识别码与全量开发
 * 在 Creator 编辑器的 Agent Active 面板展示。
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
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>('live');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [state, setState] = useState<AgentState>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveNote, setLiveNote] = useState('');
  const mounted = useRef(true);
  const presence = useVoxaAgentPresence();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/agent/v1/state');
      if (!mounted.current) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || String(response.status));
      setState(data as AgentState);
      setConnection('live');
    } catch {
      if (mounted.current) setConnection('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        await fetch('/api/agent/v1/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const copyCode = useCallback(() => {
    if (!state?.code) return;
    void navigator.clipboard?.writeText(state.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [state?.code]);

  const activityCount = useMemo(
    () => (state?.logs.length || 0) + (state?.artifacts.length || 0),
    [state],
  );

  const liveStatus = useMemo(() => {
    const phase = presence.phase;
    if (phase === 'attached') return { text: '编辑器已接入 · AI 可操作', tone: style.live };
    if (phase === 'connecting') return { text: '接入中…', tone: style.connecting };
    if (phase === 'error') return { text: `接入失败：${presence.error || '未知错误'}`, tone: style.error };
    return { text: '未接入（打开模型后自动接入）', tone: style.connecting };
  }, [presence.phase, presence.error]);

  const copyManifest = useCallback(() => {
    if (!state?.code) return;
    const manifest = {
      mcpServers: {
        'box3-agent': {
          command: 'node',
          args: ['tools/box3-agent-mcp/src/index.js'],
          env: {
            BOX_VOXA_AGENT_BASE_URL: window.location.origin,
            BOX_VOXA_AGENT_CODE: state.code,
          },
        },
      },
    };
    void navigator.clipboard?.writeText(JSON.stringify(manifest, null, 2)).then(() => {
      setLiveNote('MCP 配置已复制');
      setTimeout(() => setLiveNote(''), 2000);
    });
  }, [state?.code]);

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
          <span className={style.title}>Agent Active · VOXA</span>
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
              <div className={style.codeRow}>
                <span className={`${style.dot} ${presence.phase === 'attached' ? style.live : style.connecting}`} />
                <span className={style.summary}>{liveStatus.text}</span>
              </div>
              {presence.agentName && (
                <p className={style.hint}>
                  agent：{presence.agentName}
                  {presence.action ? ` · ${presence.action.label}（${presence.action.status}）` : ''}
                </p>
              )}
              {presence.note && <p className={style.hint}>播报：{presence.note}</p>}
              {presence.lookTarget && (
                <p className={style.hint}>
                  AI 正在看 [{presence.lookTarget.map((v) => v.toFixed(1)).join(', ')}]
                </p>
              )}
              <div className={style.codeRow}>
                <button type="button" className={style.smallBtn} onClick={copyManifest}>
                  复制 MCP 配置
                </button>
                <span className={style.hint}>{liveNote}</span>
              </div>
              <p className={style.hint}>
                AI 可以在当前工程上继续创作，读取部件、体素和材质，再进行局部修改。编辑器会同步显示修改，镜头和光标操作按需要使用。
                接入方式：把上面的 VOX- 识别码和地址发给 AI，或复制 MCP 配置到客户端。
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
                VOXA 识别码只授权模型构建：AI 加入后可以列出模型、导入 .voxaproject、登记产物。
                地图全量开发请用 Creator 编辑器里的地图识别码。
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
                <li className={style.empty}>{connection === 'error' ? '状态不可用（需登录且有模型权限）' : '等待 agent 动作…'}</li>
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
                <li className={style.empty}>还没有产物登记（voxa-model…）</li>
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

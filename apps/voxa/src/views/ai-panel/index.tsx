import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVoxaAgentLiveSession } from '../../models/agent-live';
import { store } from '../../redux/store';
import { loadProjectMessages, saveProjectMessages } from './project-conversation-store';
import styles from './style.module.scss';

type Provider = {
  id: string;
  owner: 'user' | 'admin';
  name: string;
  protocol: string;
  baseUrl: string;
  defaultModel: string;
  models: Array<{ id: string; name?: string }>;
  enabled: boolean;
  keyHint: string;
};
type Command = { kind: string; args: Record<string, unknown> };
type Context = Awaited<ReturnType<NonNullable<ReturnType<typeof getVoxaAgentLiveSession>>['panelContext']>>;
type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';
type ToolCard = { index: number; kind: string; args: Record<string, unknown>; status: ToolStatus; error?: string };
type ToolResult = { kind: string; ok: boolean; error?: string };
type Phase = 'thinking' | 'planned' | 'executing' | 'done' | 'error' | 'cancelled';
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  phase?: Phase;
  tools?: ToolCard[];
  results?: ToolResult[];
  done?: boolean;
  step?: number;
  context?: Context;
  status?: string;
  usage?: { input: number; output: number; cached: number; cacheWrite: number; hitRate: number };
  stage?: string;
  quality?: { symmetry: number; floating: number; components: number; colors: number; occupied: number; truncated: boolean };
};
type PlanReply = { message: string; commands: Command[]; done: boolean; stage?: string; quality?: ChatMessage['quality'] };
type Reasoning = 'off' | 'low' | 'medium' | 'high';
type StreamEvent =
  | { type: 'phase'; phase: string }
  | { type: 'progress'; chars: number }
  | { type: 'command'; index: number; kind: string; args: Record<string, unknown> }
  | { type: 'plan'; message: string; commands: Command[]; done: boolean; stage?: string; quality?: { symmetry: number; floating: number; components: number; colors: number; occupied: number; truncated: boolean }; usage?: { input: number; output: number; cached: number; cacheWrite: number; hitRate: number } }
  | { type: 'error'; message: string };
type Draft = { id?: string; name: string; protocol: string; baseUrl: string; apiKey: string; defaultModel: string; models: string };
type Tab = 'chat' | 'channels';

const emptyDraft: Draft = { name: '', protocol: 'chat-completions', baseUrl: 'https://api.openai.com/v1', apiKey: '', defaultModel: '', models: '' };
const REASONING_OPTIONS: Array<{ value: Reasoning; label: string }> = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];
const PHASE_TEXT: Record<string, string> = {
  preparing: '准备请求…',
  waiting: '等待模型响应…',
  generating: '模型正在生成…',
  parsing: '校验计划…',
};
const PROTOCOLS: Array<{ value: string; label: string }> = [
  { value: 'chat-completions', label: 'Chat Completions' },
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];
const TOOL_LABELS: Record<string, string> = {
  paint: '体素上色',
  erase: '擦除体素',
  paint_path: '路径上色',
  fill_box: '区域填充',
  set_color: '切换颜色',
  trim: '裁掉空白',
  palette_add: '新增调色板颜色',
  workspace_resize: '调整画布尺寸',
  part_create: '新建部件',
  part_select: '切换部件',
  part_delete: '删除部件',
  part_group: '组合部件',
  part_move: '移动部件',
  part_patch: '修改部件',
  sphere: '球形填充',
  ellipsoid: '椭球填充',
  cylinder: '圆柱填充',
  erase_box: '区域擦除',
  replace_color: '替换颜色',
  copy_region: '复制区域',
  mirror: '镜像',
};
const STATUS_LABELS: Record<ToolStatus, string> = {
  pending: '待执行',
  running: '执行中',
  success: '完成',
  error: '失败',
  cancelled: '已取消',
};

function conversationStorageKey(projectId: string) {
  return `voxa.conversation.${projectId}`;
}

function newConversationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let messageSeq = 0;
function nextId(prefix: string) {
  messageSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${messageSeq}`;
}

async function request<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((value as { message?: string }).message || `请求失败（${response.status}）`);
  return value as T;
}

async function streamPlan(body: Record<string, unknown>, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<PlanReply> {
  const response = await fetch('/api/ai/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `请求失败（${response.status}）`;
    try {
      const value = JSON.parse(text) as { message?: string };
      message = value.message || message;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式响应');
  const decoder = new TextDecoder();
  let buffer = '';
  let plan: PlanReply | undefined;
  const consume = (line: string) => {
    const raw = line.trim();
    if (!raw) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(raw) as StreamEvent;
    } catch {
      return;
    }
    onEvent(event);
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'plan') plan = { message: event.message, commands: event.commands, done: event.done };
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  for (const line of buffer.split('\n')) consume(line);
  if (!plan) throw new Error('AI 流式响应中断，请重试');
  return plan;
}

function coordinate(value: unknown) {
  return Array.isArray(value) && value.length === 3 ? `(${value.join(',')})` : '';
}

function summarize(kind: string, args: Record<string, unknown>) {
  if (kind === 'paint' || kind === 'erase') return `${coordinate(args.at)} 颜色 ${String(args.colorId ?? '')}`;
  if (kind === 'paint_path') return `${Array.isArray(args.points) ? args.points.length : 0} 个点 · 颜色 ${String(args.colorId ?? '')}`;
  if (kind === 'fill_box') return `${coordinate(args.from)} → ${coordinate(args.to)} 颜色 ${String(args.colorId ?? '')}`;
  if (kind === 'set_color') return `颜色 ${String(args.id ?? '')}`;
  if (kind === 'palette_add') return `${String(args.alias ?? '')} · RGB ${Array.isArray(args.rgb) ? args.rgb.join(',') : '?'}`;
  if (kind === 'workspace_resize') return `尺寸 ${Array.isArray(args.size) ? args.size.join(' × ') : '?'}`;
  if (kind === 'part_create' || kind === 'part_group') return [String(args.alias ?? ''), String(args.name ?? '')].filter(Boolean).join(' · ');
  if (kind === 'part_patch') {
    const fields = ['name', 'position', 'scale', 'pivot', 'rotationDegrees', 'alpha'].filter((key) => args[key] !== undefined);
    return `${String(args.id ?? '')}${fields.length ? ` · ${fields.join('/')}` : ''}`;
  }
  if (kind === 'part_delete' || kind === 'part_select') return String(args.id ?? '');
  if (kind === 'part_move') return `${String(args.id ?? '')} → ${String(args.parentId ?? '')}`;
  if (kind === 'sphere') return `${coordinate(args.center)} r=${String(args.radius ?? '')} 颜色 ${String(args.colorId ?? '')}`;
  if (kind === 'ellipsoid') return `${coordinate(args.center)} r=${Array.isArray(args.radii) ? args.radii.join(',') : '?'} 颜色 ${String(args.colorId ?? '')}`;
  if (kind === 'cylinder') return `${coordinate(args.base)} r=${String(args.radius ?? '')} h=${String(args.height ?? '')} ${String(args.axis ?? 'y')} 轴`;
  if (kind === 'erase_box') return `${coordinate(args.from)} → ${coordinate(args.to)}`;
  if (kind === 'replace_color') return `${String(args.fromColorId ?? '')} → ${String(args.toColorId ?? '')}`;
  if (kind === 'copy_region') return `${coordinate(args.from)} → ${coordinate(args.to)} 偏移 ${coordinate(args.offset)}`;
  if (kind === 'mirror') return `${String(args.axis ?? 'x')} 轴镜像${args.plane !== undefined ? ` @${String(args.plane)}` : ''}`;
  return Object.keys(args).slice(0, 3).map((key) => `${key}: ${JSON.stringify(args[key])}`).join(', ');
}

type IconName = 'spark' | 'send' | 'stop' | 'settings' | 'rollback' | 'close' | 'chevron' | 'check' | 'alert' | 'plus';


function groupTools(tools: ToolCard[]) {
  const groups = new Map<string, ToolCard[]>();
  for (const tool of tools) {
    const list = groups.get(tool.kind) || [];
    list.push(tool);
    groups.set(tool.kind, list);
  }
  return [...groups.entries()].map(([kind, items]) => ({ kind, items }));
}

function summarizeToolGroups(tools: ToolCard[]) {
  return groupTools(tools).map(({ kind, items }) => `${TOOL_LABELS[kind] || kind}×${items.length}`).join(' · ');
}

function statusSummary(items: ToolCard[]) {
  const success = items.filter((tool) => tool.status === 'success').length;
  const running = items.filter((tool) => tool.status === 'running').length;
  const failed = items.filter((tool) => tool.status === 'error' || tool.status === 'cancelled').length;
  const pending = items.length - success - running - failed;
  return [
    success ? `完成 ${success}` : '',
    running ? `执行 ${running}` : '',
    failed ? `失败 ${failed}` : '',
    pending ? `待执行 ${pending}` : '',
  ].filter(Boolean).join(' · ');
}

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, string> = {
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z',
    send: 'M4 12l16-8-6 8 6 8-16-8z',
    stop: 'M7 7h10v10H7z',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.4 4.9l1.7 1.3-1.6 2.8-2-.8a8 8 0 0 1-1.7 1l-.3 2.1h-3.2l-.3-2.1a8 8 0 0 1-1.7-1l-2 .8-1.6-2.8 1.7-1.3a8 8 0 0 1 0-2l-1.7-1.3 1.6-2.8 2 .8a8 8 0 0 1 1.7-1l.3-2.1h3.2l.3 2.1a8 8 0 0 1 1.7 1l2-.8 1.6 2.8-1.7 1.3a8 8 0 0 1 0 2z',
    rollback: 'M9 7H4v5M4.6 12a8 8 0 1 0 2.1-5.4L4 9',
    close: 'M6 6l12 12M18 6L6 18',
    chevron: 'M6 9l6 6 6-6',
    check: 'M5 12l4 4L19 6',
    alert: 'M12 4l9 16H3L12 4zm0 5v5m0 3v.5',
    plus: 'M12 5v14M5 12h14',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function VoxaAiPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [autonomy, setAutonomy] = useState<'review' | 'autonomous'>(() => {
    if (typeof window === 'undefined') return 'autonomous';
    return window.localStorage.getItem('voxa.autonomy') === 'review' ? 'review' : 'autonomous';
  });
  const [prompt, setPrompt] = useState('');
  const [reasoning, setReasoning] = useState<Reasoning>(() => {
    if (typeof window === 'undefined') return 'off';
    const saved = window.localStorage.getItem('voxa.aiReasoning');
    return saved === 'low' || saved === 'medium' || saved === 'high' ? saved : 'off';
  });
  const [customModel, setCustomModel] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const reasoningTouched = useRef<boolean>((() => {
    try { return window.localStorage.getItem('voxa.aiReasoningTouched') === '1'; } catch { return false; }
  })());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [note, setNote] = useState('');
  const abortRef = useRef<AbortController | undefined>(undefined);
  const conversationId = useRef<string>(newConversationId());
  const transcriptRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const mounted = useRef(true);
  const projectRef = useRef('');
  const goalRef = useRef('');
  const messagesRef = useRef<ChatMessage[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const applyProject = (id: string) => {
      if (!id || id === projectRef.current) return;
      const previous = projectRef.current;
      if (previous) void saveProjectMessages(previous, messagesRef.current).catch(() => undefined);
      projectRef.current = id;
      goalRef.current = '';
      abortRef.current?.abort();
      try {
        const storageKey = conversationStorageKey(id);
        const stored = window.localStorage.getItem(storageKey);
        conversationId.current = stored || newConversationId();
        if (!stored) window.localStorage.setItem(storageKey, conversationId.current);
      } catch {
        conversationId.current = newConversationId();
      }
      void loadProjectMessages(id).then((saved) => {
        if (!mounted.current || projectRef.current !== id) return;
        const restored = (Array.isArray(saved) ? saved : []) as ChatMessage[];
        setMessages(restored.map((message) => message.phase === 'thinking' || message.phase === 'executing'
          ? { ...message, phase: 'cancelled', text: message.text || '上次执行被中断', status: undefined, tools: message.tools?.map((tool) => tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'cancelled' } : tool) }
          : message));
      }).catch(() => undefined);
    };
    const initial = String(store.getState().app.projectId || '');
    if (initial) applyProject(initial);
    const unsubscribe = store.subscribe(() => {
      const id = String(store.getState().app.projectId || '');
      if (id) applyProject(id);
    });
    return () => {
      unsubscribe();
      if (projectRef.current) void saveProjectMessages(projectRef.current, messagesRef.current).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const id = projectRef.current;
    if (!id) return;
    const timer = window.setTimeout(() => { void saveProjectMessages(id, messages).catch(() => undefined); }, 400);
    return () => window.clearTimeout(timer);
  }, [messages]);

  useEffect(() => {
    try { window.localStorage.setItem('voxa.aiReasoning', reasoning); } catch { /* storage may be blocked */ }
  }, [reasoning]);

  useEffect(() => {
    try { window.localStorage.setItem('voxa.autonomy', autonomy); } catch { /* storage may be blocked */ }
  }, [autonomy]);

  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (draft) formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [draft]);

  const selected = useMemo(() => providers.find((item) => item.id === providerId), [providers, providerId]);
  const available = useMemo(() => providers.filter((item) => item.enabled), [providers]);
  const modelOptions = useMemo(() => {
    const values = [selected?.defaultModel, ...(selected?.models || []).map((item) => item.id)].filter(Boolean) as string[];
    return [...new Set(values)];
  }, [selected]);
  useEffect(() => {
    if (!selected || reasoningTouched.current) return;
    try {
      const host = new URL(selected.baseUrl).hostname.toLowerCase();
      if (host.endsWith('deepseek.com') && reasoning === 'off') setReasoning('low');
    } catch { /* ignore malformed base urls */ }
  }, [selected, reasoning]);

  const isCustomModel = customModel || (!!model && !modelOptions.includes(model)) || (!modelOptions.length && !model);
  const lastAssistant = useMemo(() => [...messages].reverse().find((item) => item.role === 'assistant'), [messages]);
  const status = busy
    ? lastAssistant?.phase === 'executing' ? '正在执行修改' : '正在生成计划'
    : lastAssistant?.phase === 'error' ? '上一步失败' : selected ? '就绪' : '未配置渠道';

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) => {
    setMessages((previous) => previous.map((item) => item.id === id ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch) } : item));
  }, []);

  const patchTool = useCallback((messageId: string, index: number, patch: Partial<ToolCard>) => {
    setMessages((previous) => previous.map((item) => {
      if (item.id !== messageId || !item.tools) return item;
      return { ...item, tools: item.tools.map((tool, toolIndex) => toolIndex === index ? { ...tool, ...patch } : tool) };
    }));
  }, []);

  const loadChannels = useCallback(async () => {
    const [catalog, preferences] = await Promise.all([
      request<{ providers: Provider[] }>('/api/player-ai/providers'),
      request<{ preferences: Record<string, { providerId: string; model: string; autonomy: 'review' | 'autonomous' }> }>('/api/player-ai/preferences'),
    ]);
    if (!mounted.current) return;
    const ordered = [...catalog.providers].sort((left, right) => (left.owner === 'user' ? 0 : 1) - (right.owner === 'user' ? 0 : 1));
    setProviders(ordered);
    const enabled = ordered.filter((item) => item.enabled);
    const own = enabled.filter((item) => item.owner === 'user');
    const preferred = own.length ? own : enabled;
    const preference = preferences.preferences['voxa.model'];
    setProviderId((current) => {
      if (current && enabled.some((item) => item.id === current)) return current;
      if (preference?.providerId && enabled.some((item) => item.id === preference.providerId)) return preference.providerId;
      return preferred[0]?.id || '';
    });
    setModel((current) => {
      if (current) return current;
      if (preference?.model) return preference.model;
      const fallback = preferred.find((item) => item.id === preference?.providerId) || preferred[0];
      return fallback?.defaultModel || fallback?.models[0]?.id || '';
    });
  }, []);

  const savePreferences = useCallback(async (nextProvider = providerId, nextModel = model, nextAutonomy = autonomy, signal?: AbortSignal) => {
    if (!nextProvider || !nextModel) return;
    await request('/api/player-ai/preferences', 'PUT', { workflow: 'voxa.model', providerId: nextProvider, model: nextModel, autonomy: nextAutonomy }, signal);
  }, [providerId, model, autonomy]);

  useEffect(() => {
    if (open) void loadChannels().catch((error) => setNote((error as Error).message));
  }, [open, loadChannels]);

  const append = useCallback((message: ChatMessage) => {
    setMessages((previous) => [...previous, message]);
  }, []);

  const runChannel = useCallback(async (action: () => Promise<void>) => {
    if (channelBusy) return;
    setChannelBusy(true);
    setNote('');
    try {
      await action();
    } catch (error) {
      if (mounted.current) setNote((error as Error).message || '操作失败');
    } finally {
      if (mounted.current) setChannelBusy(false);
    }
  }, [channelBusy]);

  const executePlan = useCallback(async (message: ChatMessage): Promise<ToolResult[] | undefined> => {
    const session = getVoxaAgentLiveSession();
    if (!session) throw new Error('模型编辑器尚未就绪，请先打开并保存一个模型');
    if (!message.tools?.length || !message.context) return [];
    const controller = new AbortController();
    abortRef.current = controller;
    patchMessage(message.id, { phase: 'executing' });
    const results: ToolResult[] = [];
    try {
      await session.executePanelPlan(
        message.tools.map((tool) => ({ kind: tool.kind, args: tool.args })),
        message.context,
        controller.signal,
        { providerId, model, mode: autonomy },
        (event) => {
          if (event.index === undefined) return;
          if (event.type === 'command-start') patchTool(message.id, event.index, { status: 'running' });
          if (event.type === 'command-done') {
            patchTool(message.id, event.index, { status: 'success' });
            results[event.index] = { kind: event.kind || '', ok: true };
          }
          if (event.type === 'command-error') {
            patchTool(message.id, event.index, { status: 'error', error: event.message });
            results[event.index] = { kind: event.kind || '', ok: false, error: event.message };
          }
        },
      );
      patchMessage(message.id, { phase: 'done', results });
      append({ id: nextId('system'), role: 'system', text: `已执行并保存 ${message.tools.length} 项修改，可随时回滚最近批次。` });
      return results;
    } catch (error) {
      const text = error instanceof Error ? error.message : '执行失败';
      patchMessage(message.id, { phase: controller.signal.aborted ? 'cancelled' : 'error' });
      setMessages((previous) => previous.map((item) => {
        if (item.id !== message.id || !item.tools) return item;
        return { ...item, tools: item.tools.map((tool) => tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: controller.signal.aborted ? 'cancelled' : 'error', error: text } : tool) };
      }));
      append({ id: nextId('system'), role: 'system', text });
      return undefined;
    } finally {
      abortRef.current = undefined;
    }
  }, [append, autonomy, model, patchMessage, patchTool, providerId]);

  const runPlan = useCallback(async (options: { text: string; displayUser?: boolean; toolResults?: ToolResult[]; step?: number; force?: boolean; history?: Array<{ role: 'user' | 'assistant'; content: string }> }) => {
    if (busy && !options.force) return;
    const session = getVoxaAgentLiveSession();
    if (!session) {
      setNote('模型编辑器尚未就绪，请先打开并保存一个模型');
      return;
    }
    if (!providerId || !model) {
      setTab('channels');
      setNote('请先在“渠道”中接入并选择一个模型渠道');
      return;
    }
    const text = options.text.trim();
    if (!text) return;
    const step = options.step ?? 0;
    setBusy(true);
    setNote('');
    setPrompt('');
    const history = options.history || transcriptRef.current.slice(-10);
    if (options.displayUser !== false) {
      goalRef.current = text;
      append({ id: nextId('user'), role: 'user', text });
      transcriptRef.current = [...transcriptRef.current, { role: 'user', content: text }];
    } else {
      append({ id: nextId('system'), role: 'system', text: step > 0 ? `第 ${step + 1} 步：${text}` : text });
    }
    const assistantId = nextId('assistant');
    append({ id: assistantId, role: 'assistant', text: '', phase: 'thinking', step, status: '读取模型上下文…' });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const contextStarted = performance.now();
      const context = await session.panelContext();
      const projectId = String((context as unknown as { snapshot?: { project?: { modelId?: unknown } } })?.snapshot?.project?.modelId || '');
      const modelContext = { ...(context as unknown as Record<string, unknown>) };
      for (const key of ['snapshot', 'fingerprint', 'revision', 'humanEpoch', 'undoDepth']) delete modelContext[key];
      console.info('[voxa-panel] context', { ms: Math.round(performance.now() - contextStarted), bytes: JSON.stringify(modelContext).length });
      patchMessage(assistantId, { status: '准备请求…' });
      void savePreferences(providerId, model, autonomy).catch(() => undefined);
      let planUsage: ChatMessage['usage'];
    let planStage: string | undefined;
    let planQuality: ChatMessage['quality'];
    const reply = await streamPlan({
        providerId,
        model,
        prompt: text,
        context: modelContext,
        history,
        toolResults: options.toolResults,
        step,
        reasoning,
        projectId,
        goal: goalRef.current || text,
        conversationId: conversationId.current,
      }, controller.signal, (event) => {
        if (event.type === 'phase') patchMessage(assistantId, { status: PHASE_TEXT[event.phase] || '处理中…' });
        if (event.type === 'progress') patchMessage(assistantId, { status: `已接收 ${event.chars} 字符…` });
        if (event.type === 'plan' && event.usage) planUsage = event.usage;
        if (event.type === 'plan') { planStage = event.stage; planQuality = event.quality; }
        if (event.type === 'command') {
          patchMessage(assistantId, (message) => {
            const tools = message.tools ? [...message.tools] : [];
            if (!tools.some((tool) => tool.index === event.index)) {
              tools.push({ index: event.index, kind: event.kind, args: event.args, status: 'pending' });
            }
            return { tools, status: `已解析 ${tools.length} 项修改…` };
          });
        }
      });
      const assistant: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        text: reply.message || (reply.commands.length ? `已生成 ${reply.commands.length} 项修改。` : '没有需要执行的修改。'),
        phase: 'planned',
        step,
        done: reply.done,
        context,
        status: undefined,
        usage: planUsage,
        stage: planStage || reply.stage,
        quality: planQuality || reply.quality,
        tools: reply.commands.map((command, index) => ({ index, kind: command.kind, args: command.args, status: 'pending' })),
      };
      patchMessage(assistantId, assistant);
      transcriptRef.current = [...transcriptRef.current, { role: 'assistant', content: assistant.text }];
      if (autonomy === 'autonomous' && reply.commands.length) {
        const results = await executePlan(assistant);
        if (results && !reply.done && step < 5) {
          const failed = results.filter((item) => !item.ok);
          const next = failed.length ? '上一步有命令执行失败，请修复后继续完成剩余目标。' : '继续完成剩余目标。';
          setBusy(false);
          await runPlan({ text: next, displayUser: false, toolResults: results, step: step + 1, force: true });
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '请求失败';
      patchMessage(assistantId, { phase: controller.signal.aborted ? 'cancelled' : 'error', text: message });
      append({ id: nextId('system'), role: 'system', text: message });
    } finally {
      abortRef.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }, [append, autonomy, busy, executePlan, model, patchMessage, providerId, reasoning, savePreferences]);

  const followUp = useCallback((message: ChatMessage) => {
    const failures = (message.results || []).filter((item) => !item.ok);
    const text = failures.length ? '上一步有命令执行失败，请修复后继续完成剩余目标。' : '继续完成剩余目标。';
    void runPlan({ text, displayUser: false, toolResults: message.results, step: (message.step || 0) + 1 });
  }, [runPlan]);

  const resetConversation = useCallback(() => {
    conversationId.current = newConversationId();
    try {
      if (projectRef.current) window.localStorage.setItem(conversationStorageKey(projectRef.current), conversationId.current);
    } catch { /* storage may be blocked */ }
  }, []);

  const saveChannel = useCallback(async () => {
    if (!draft) return;
    const { id, models, ...fields } = draft;
    const payload: Record<string, unknown> = {
      ...fields,
      models: models.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
    };
    if (!String(payload.apiKey || '').trim()) delete payload.apiKey;
    const saved = await request<{ provider: Provider }>(id ? `/api/player-ai/providers/${id}` : '/api/player-ai/providers', id ? 'PATCH' : 'POST', payload);
    setDraft(undefined);
    await loadChannels();
    if (saved.provider?.id) {
      resetConversation();
      setProviderId(saved.provider.id);
      setModel(saved.provider.defaultModel || saved.provider.models[0]?.id || '');
      await savePreferences(saved.provider.id, saved.provider.defaultModel || saved.provider.models[0]?.id || '', autonomy);
    }
    setNote('渠道已保存，可直接复用');
  }, [autonomy, draft, loadChannels, resetConversation, savePreferences]);

  const testChannel = useCallback(async (provider: Provider) => {
    const result = await request<{ result: { ok: boolean; message: string; latencyMs: number } }>(`/api/player-ai/providers/${provider.id}/test`, 'POST', { model: provider.defaultModel || provider.models[0]?.id });
    if (!result.result.ok) throw new Error(result.result.message);
    setNote(`连接成功，${result.result.latencyMs}ms`);
  }, []);

  const pullModels = useCallback(async (provider: Provider) => {
    await request(`/api/player-ai/providers/${provider.id}/models`, 'POST', {});
    await loadChannels();
    setNote('模型列表已更新');
  }, [loadChannels]);

  const openDraft = useCallback((provider: Provider, mode: 'edit' | 'clone') => {
    setDraft({
      id: mode === 'edit' ? provider.id : undefined,
      name: mode === 'clone' ? `${provider.name}（我的）` : provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: '',
      defaultModel: provider.defaultModel,
      models: provider.models.map((item) => item.id).join('\n'),
    });
  }, []);

  const chooseProvider = useCallback((provider: Provider) => {
    if (!provider.enabled) return;
    resetConversation();
    setProviderId(provider.id);
    setCustomModel(false);
    const nextModel = provider.defaultModel || provider.models[0]?.id || '';
    setModel(nextModel);
    void savePreferences(provider.id, nextModel, autonomy).catch(() => undefined);
    setTab('chat');
  }, [autonomy, resetConversation, savePreferences]);

  const toggle = () => {
    setOpen((value) => {
      if (value) abortRef.current?.abort();
      return !value;
    });
  };

  if (!open) {
    return (
      <button className={styles.pill} onClick={toggle} aria-label="打开 VOXA AI 创作面板">
        <span className={styles.spark}><Icon name="spark" size={14} /></span>
        <span>AI 创作</span>
        <span className={styles.pillState}>{status}</span>
      </button>
    );
  }

  return (
    <aside className={styles.root} aria-label="VOXA AI 创作面板">
      <header className={styles.header}>
        <span className={styles.spark}><Icon name="spark" size={15} /></span>
        <div className={styles.titleBlock}>
          <strong>VOXA Agent</strong>
          <span>{selected ? `${selected.name} · ${model || '未选模型'}` : '未配置渠道'}</span>
        </div>
        <span className={`${styles.statusDot} ${busy ? styles.busy : selected ? styles.ready : styles.idle}`} />
        <button className={styles.iconButton} title="回滚最近批次" disabled={busy} onClick={() => {
          const session = getVoxaAgentLiveSession();
          if (!session) { setNote('模型编辑器尚未就绪'); return; }
          void session.rollbackPanelPlan().then(() => {
            append({ id: nextId('system'), role: 'system', text: '已恢复并保存最近批次前的快照。' });
            setNote('');
          }).catch((error) => setNote((error as Error).message));
        }}><Icon name="rollback" size={15} /></button>
        <button className={styles.iconButton} title="收起" onClick={toggle}><Icon name="close" size={15} /></button>
      </header>

      <nav className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? styles.activeTab : styles.tab} onClick={() => setTab('chat')}>对话</button>
        <button role="tab" aria-selected={tab === 'channels'} className={tab === 'channels' ? styles.activeTab : styles.tab} onClick={() => setTab('channels')}>
          <Icon name="settings" size={13} /> 渠道
          {!available.length && <span className={styles.dotBadge} />}
        </button>
      </nav>

      {tab === 'channels' ? (
        <div className={styles.channelBody}>
          <div className={styles.sectionHead}>
            <span>我的 API 渠道</span>
            <button className={styles.primarySmall} onClick={() => setDraft({ ...emptyDraft })}><Icon name="plus" size={13} />新增</button>
          </div>
          <p className={styles.hint}>渠道按你的账号加密保存，下次打开直接复用；平台渠道只读，可点“复制”另存为自己的渠道后修改。</p>
          <ul className={styles.channelList}>
            {providers.map((provider) => (
              <li key={provider.id} className={`${styles.channel} ${provider.id === providerId ? styles.channelActive : ''}`}>
                <button className={styles.channelMain} onClick={() => chooseProvider(provider)} disabled={!provider.enabled}>
                  <span className={styles.channelName}>
                    {provider.name}
                    <em className={provider.owner === 'admin' ? styles.platform : styles.mine}>{provider.owner === 'admin' ? '平台' : '我的'}</em>
                    {!provider.enabled && <em className={styles.disabled}>已停用</em>}
                  </span>
                  <span className={styles.channelMeta}>{provider.protocol} · {provider.keyHint || '已保存密钥'} · {provider.models.length} 个模型</span>
                  <span className={styles.channelUrl}>{provider.baseUrl}</span>
                </button>
                <div className={styles.channelActions}>
                  <button disabled={channelBusy} onClick={() => void runChannel(() => testChannel(provider))}>测试</button>
                  <button disabled={channelBusy} onClick={() => void runChannel(() => pullModels(provider))}>拉取</button>
                  {provider.owner === 'user'
                    ? <button disabled={channelBusy} onClick={() => openDraft(provider, 'edit')}>编辑</button>
                    : <button disabled={channelBusy} onClick={() => openDraft(provider, 'clone')}>复制</button>}
                  {provider.owner === 'user' && <button className={styles.danger} disabled={channelBusy} onClick={() => {
                    if (!window.confirm(`删除渠道“${provider.name}”？`)) return;
                    void runChannel(async () => {
                      await request(`/api/player-ai/providers/${provider.id}`, 'DELETE');
                      if (providerId === provider.id) { setProviderId(''); setModel(''); }
                      await loadChannels();
                      setNote('渠道已删除');
                    });
                  }}>删除</button>}
                </div>
              </li>
            ))}
            {!providers.length && <li className={styles.empty}>还没有渠道。点击“新增”接入你自己的 API，保存后即可复用。</li>}
          </ul>

          {draft && (
            <form ref={formRef} className={styles.form} onSubmit={(event) => { event.preventDefault(); void runChannel(saveChannel); }}>
              <div className={styles.formTitle}>{draft.id ? '编辑渠道' : '新增渠道'}</div>
              <label>名称<input required maxLength={64} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 我的 GPT" /></label>
              <label>协议<select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value })}>
                {PROTOCOLS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select></label>
              <label>Base URL<input required type="url" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://host 或 https://host/v1" /></label>
              <label>API Key<input required={!draft.id} type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.id ? '留空保留原密钥' : 'sk-...'} /></label>
              <label>默认模型<input required value={draft.defaultModel} onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })} placeholder="模型 ID" /></label>
              <label>模型列表<textarea rows={3} value={draft.models} onChange={(event) => setDraft({ ...draft, models: event.target.value })} placeholder={'每行一个，或点击“拉取模型”自动填充'} /></label>
              <p className={styles.hint}>未写 /v1 会自动补全；密钥加密保存，不会回传到浏览器之外。</p>
              <div className={styles.formActions}>
                <button type="button" className={styles.ghost} onClick={() => setDraft(undefined)}>取消</button>
                <button type="submit" className={styles.primarySmall} disabled={channelBusy}>保存渠道</button>
              </div>
            </form>
          )}
          {note && <p className={styles.note} role="status">{note}</p>}
        </div>
      ) : (
        <>
          <div className={styles.log} ref={logRef} role="log" aria-live="polite">
            {!messages.length && (
              <div className={styles.emptyChat}>
                <Icon name="spark" size={22} />
                <p>告诉我你想建什么，我会先读模型结构，再分批体素/部件修改，执行后可回滚。</p>
                {!selected && <button className={styles.primarySmall} onClick={() => setTab('channels')}>先接入 API 渠道</button>}
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`${styles.message} ${styles[message.role]}`}>
                {message.role === 'system' ? (
                  <p className={styles.systemText}>{message.text}</p>
                ) : (
                  <>
                    {message.text && <p className={styles.bubble}>{message.text}</p>}
                    {message.phase === 'thinking' && <span className={styles.thinking}>{message.status || '正在读取模型并规划'}{busy && elapsed > 0 ? ` · ${elapsed}s` : ''}<span /><span /><span /></span>}
                    {!!message.tools?.length && (
                      <div className={styles.tools}>
                        <div className={styles.toolsHead}>
                          <span>工具调用 · {message.tools.length} 项{message.stage ? ` · ${message.stage}` : ''}</span>
                          {message.phase === 'executing' && <em>执行中 {message.tools.filter((tool) => tool.status === 'success').length}/{message.tools.length}</em>}
                          {message.phase === 'planned' && autonomy === 'autonomous' && <em>即将执行</em>}
                          {message.phase === 'done' && <em className={styles.doneLabel}><Icon name="check" size={12} /> 已保存</em>}
                          {message.phase === 'error' && <em className={styles.errorLabel}><Icon name="alert" size={12} /> 有错误</em>}
                        </div>
                        <p className={styles.toolFoldSummary}>{summarizeToolGroups(message.tools)}</p>
                        {message.quality && (
                          <p className={styles.qualityLine}>质量 · 对称 {Math.round(message.quality.symmetry * 100)}% · 悬浮 {message.quality.floating} · {message.quality.colors} 色{message.quality.truncated ? ' · 样本截断' : ''}</p>
                        )}
                        {message.usage && message.usage.input > 0 && (
                          <p className={styles.cacheLine}>上下文缓存命中 {Math.round(message.usage.hitRate * 100)}% · {message.usage.cached}/{message.usage.input} tokens</p>
                        )}
                        {message.tools.some((tool) => tool.error) && (
                          <div className={styles.failureList}>
                            {message.tools.filter((tool) => tool.error).slice(0, 3).map((tool) => (
                              <p key={`fail-${message.id}-${tool.index}`}>{TOOL_LABELS[tool.kind] || tool.kind}：{tool.error}</p>
                            ))}
                          </div>
                        )}
                        <details className={styles.toolFold}>
                          <summary>查看工具明细</summary>
                          {groupTools(message.tools).map((group) => (
                            <details key={`${message.id}-${group.kind}`} className={styles.toolGroup}>
                              <summary>
                                <span className={styles.toolKind}>{TOOL_LABELS[group.kind] || group.kind} × {group.items.length}</span>
                                <span className={styles.toolStatus}>{statusSummary(group.items)}</span>
                              </summary>
                              {group.items.map((tool) => (
                                <div key={`${message.id}-${tool.index}`} className={`${styles.toolRow} ${styles[tool.status]}`}>
                                  <span className={styles.toolRowIndex}>#{tool.index + 1}</span>
                                  <span className={styles.toolSummary}>{summarize(tool.kind, tool.args)}</span>
                                  <span className={styles.toolStatus}>{STATUS_LABELS[tool.status]}</span>
                                </div>
                              ))}
                            </details>
                          ))}
                        </details>
                        {message.phase === 'planned' && autonomy === 'review' && (
                          <div className={styles.batchActions}>
                            <button className={styles.primarySmall} disabled={busy} onClick={() => {
                              setBusy(true);
                              void executePlan(message).then((results) => {
                                if (!results) return;
                                const failures = results.filter((item) => !item.ok);
                                if (!failures.length && !message.done) setNote('本批已完成，可继续下一步');
                                if (failures.length) setNote('部分命令失败，可让 AI 修复');
                              }).catch((error) => setNote((error as Error).message || '执行失败')).finally(() => setBusy(false));
                            }}>执行这 {message.tools.length} 项</button>
                            <button className={styles.ghost} disabled={busy} onClick={() => patchMessage(message.id, { phase: 'cancelled', tools: [] })}>放弃</button>
                            <span className={styles.reviewHint}>当前为审核模式</span>
                          </div>
                        )}
                        {message.phase === 'done' && message.step !== undefined && message.step < 5 && (
                          <div className={styles.batchActions}>
                            <button className={styles.ghost} disabled={busy} onClick={() => followUp(message)}>
                              {(message.results || []).some((item) => !item.ok) ? '让 AI 修复' : message.done ? '继续微调' : '继续下一步'}
                            </button>
                          </div>
                        )}
                        {message.phase === 'error' && message.step !== undefined && message.step < 5 && (
                          <div className={styles.batchActions}>
                            <button className={styles.ghost} disabled={busy} onClick={() => followUp(message)}>让 AI 修复</button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>

          <div className={styles.composer}>
            <div className={styles.composerTop}>
              <select
                className={styles.modelSelect}
                value={isCustomModel ? '__custom' : model}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value === '__custom') { setCustomModel(true); return; }
                  setCustomModel(false);
                  resetConversation();
                  setModel(event.target.value);
                }}
                aria-label="选择模型"
              >
                {modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                {!modelOptions.length && <option value="">未选模型</option>}
                <option value="__custom">自定义模型…</option>
              </select>
              <div className={styles.segmented} role="group" aria-label="执行方式">
                <button className={autonomy === 'review' ? styles.segmentActive : styles.segment} disabled={busy} onClick={() => setAutonomy('review')}>审核</button>
                <button className={autonomy === 'autonomous' ? styles.segmentActive : styles.segment} disabled={busy} onClick={() => setAutonomy('autonomous')}>自主</button>
              </div>
            </div>
            {isCustomModel && (
              <input className={styles.modelInput} value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} placeholder="输入模型 ID" aria-label="自定义模型 ID" />
            )}
            <div className={styles.reasoningRow} title="DeepSeek：关=none，低=low，中=high，高=max；低/中通常兼顾细节与速度">
              <span>思考强度</span>
              <div className={styles.segmented} role="group" aria-label="思考强度">
                {REASONING_OPTIONS.map((item) => (
                  <button key={item.value} className={reasoning === item.value ? styles.segmentActive : styles.segment} disabled={busy} onClick={() => { reasoningTouched.current = true; try { window.localStorage.setItem('voxa.aiReasoningTouched', '1'); } catch { /* storage may be blocked */ } setReasoning(item.value); }}>{item.label}</button>
                ))}
              </div>
            </div>
            <p className={styles.hint}>DeepSeek 推荐“低/中”；关=none、低=low、中=high、高=max。</p>
            <textarea
              value={prompt}
              disabled={busy}
              rows={3}
              maxLength={16000}
              placeholder={selected ? '描述要构建或修改的内容，例如：把头部加宽并做出耳朵' : '先在“渠道”接入 API，再开始创作'}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void runPlan({ text: prompt });
                }
              }}
            />
            <div className={styles.composerActions}>
              <span className={styles.hint}>Ctrl/Cmd + Enter 发送</span>
              {busy ? (
                <button className={styles.stop} onClick={() => abortRef.current?.abort()}><Icon name="stop" size={14} />停止</button>
              ) : (
                <button className={styles.primary} disabled={!providerId || !model || !prompt.trim()} onClick={() => void runPlan({ text: prompt })}>
                  <Icon name="send" size={14} />发送
                </button>
              )}
            </div>
            {note && <p className={styles.note} role="status">{note}</p>}
          </div>
        </>
      )}
    </aside>
  );
}

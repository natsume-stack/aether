'use client';

import { Copy, Loader2, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import {
  PROTOCOL_LABELS,
  PROTOCOL_PLACEHOLDERS,
  type AiProviderProtocol,
  type AiProviderView,
} from './provider-types';

type FormState = {
  name: string;
  protocol: AiProviderProtocol;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: string;
  headers: string;
  tools: boolean;
  vision: boolean;
  json: boolean;
};

const EMPTY_FORM: FormState = {
  name: '',
  protocol: 'chat-completions',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  models: '',
  headers: '',
  tools: true,
  vision: false,
  json: false,
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `请求失败（HTTP ${response.status}）`);
  return data as T;
}

function modelList(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .map((id) => ({ id }));
}

function formFrom(provider: AiProviderView): FormState {
  return {
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: '',
    defaultModel: provider.defaultModel,
    models: provider.models.map((model) => model.id).join('\n'),
    headers: Object.keys(provider.headers || {}).length ? JSON.stringify(provider.headers, null, 2) : '',
    tools: provider.capabilities.tools !== false,
    vision: provider.capabilities.vision === true,
    json: provider.capabilities.json === true,
  };
}

export type AiProviderSettingsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: AiProviderView[];
  activeProviderId: string;
  onProvidersChanged: (providers: AiProviderView[]) => void;
  onUseProvider: (providerId: string, model: string) => void;
};

export function AiProviderSettings({
  open,
  onOpenChange,
  providers,
  activeProviderId,
  onProvidersChanged,
  onUseProvider,
}: AiProviderSettingsProps) {
  const [editing, setEditing] = useState<AiProviderView | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState('');

  const title = useMemo(() => editing === 'new' ? '新增 AI 渠道' : editing ? '编辑 AI 渠道' : 'AI 接入', [editing]);

  const reload = async () => {
    const data = await request<{ providers: AiProviderView[] }>('/api/player-ai/providers');
    onProvidersChanged(data.providers || []);
    return data.providers || [];
  };

  const beginCreate = () => {
    setEditing('new');
    setForm(EMPTY_FORM);
  };

  const beginEdit = (provider: AiProviderView) => {
    setEditing(provider);
    setForm(formFrom(provider));
  };

  const beginClone = (provider: AiProviderView) => {
    setEditing('new');
    setForm({ ...formFrom(provider), name: `${provider.name}（我的）`, apiKey: '' });
  };

  const save = async () => {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      toast.error('渠道名和 Base URL 必填');
      return;
    }
    let headers: Record<string, string> = {};
    if (form.headers.trim()) {
      try {
        const parsed = JSON.parse(form.headers);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('headers must be an object');
        headers = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
      } catch {
        toast.error('自定义请求头必须是 JSON 对象');
        return;
      }
    }
    if (editing === 'new' && !form.apiKey.trim()) {
      toast.error('新增渠道必须填写 API Key');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: form.name.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        defaultModel: form.defaultModel.trim(),
        models: modelList(form.models),
        headers,
        capabilities: { tools: form.tools, vision: form.vision, json: form.json },
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      const result = editing === 'new'
        ? await request<{ provider: AiProviderView }>('/api/player-ai/providers', { method: 'POST', body: JSON.stringify(payload) })
        : await request<{ provider: AiProviderView }>(`/api/player-ai/providers/${(editing as AiProviderView).id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const list = await reload();
      setEditing(null);
      setForm(EMPTY_FORM);
      const provider = result.provider || list.find((item) => item.id === result.provider?.id);
      if (provider) onUseProvider(provider.id, provider.defaultModel || provider.models[0]?.id || '');
      toast.success('渠道已保存');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: AiProviderView) => {
    if (!window.confirm(`删除渠道「${provider.name}」？已保存的密钥会一并删除。`)) return;
    setBusy(true);
    try {
      await request(`/api/player-ai/providers/${provider.id}`, { method: 'DELETE' });
      await reload();
      toast.success('渠道已删除');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (provider: AiProviderView) => {
    setTestingId(provider.id);
    try {
      const data = await request<{ result: { ok: boolean; status: number; latencyMs: number; message: string } }>(
        `/api/player-ai/providers/${provider.id}/test`,
        { method: 'POST', body: JSON.stringify({ model: provider.defaultModel || provider.models[0]?.id }) },
      );
      const result = data.result;
      if (result.ok) toast.success(`连接成功 · ${result.latencyMs}ms · HTTP ${result.status}`);
      else toast.error(`连接失败：${result.message}`);
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTestingId('');
    }
  };

  const pullModels = async (provider: AiProviderView) => {
    setTestingId(provider.id);
    try {
      const data = await request<{ models: Array<{ id: string }> }>(`/api/player-ai/providers/${provider.id}/models`, { method: 'POST' });
      const text = (data.models || []).map((model) => model.id).join('\n');
      if (editing && editing !== 'new' && editing.id === provider.id) {
        setForm((current) => ({ ...current, models: text }));
      }
      toast.success(`已拉取 ${data.models?.length || 0} 个模型`);
      await reload();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setTestingId('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setEditing(null); onOpenChange(next); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            渠道密钥只保存在服务端并加密，浏览器只显示末四位。用户渠道优先，未配置时使用管理员默认渠道。
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm">
                <span>渠道名</span>
                <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 DeepSeek 官方" />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>协议</span>
                <Select value={form.protocol} onValueChange={(value) => setForm({ ...form, protocol: value as AiProviderProtocol })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROTOCOL_LABELS) as AiProviderProtocol[]).map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <label className="grid gap-1.5 text-sm">
              <span>Base URL</span>
              <Input
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder={PROTOCOL_PLACEHOLDERS[form.protocol]}
              />
              <span className="text-xs text-muted-foreground">可填 API 根地址或完整端点；未带版本时自动补 /v1（例如 https://host → https://host/v1，也可直接粘贴 .../v1/chat/completions）。</span>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span>API Key</span>
              <Input
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder={editing !== 'new' && editing ? `已保存 ${editing.keyHint}；留空不修改` : 'sk-...'}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm">
                <span>默认模型</span>
                <Input value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} placeholder="例如 deepseek-chat" />
              </label>
              <div className="flex items-end gap-3 pb-1 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={form.tools} onChange={(event) => setForm({ ...form, tools: event.target.checked })} />工具调用</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={form.vision} onChange={(event) => setForm({ ...form, vision: event.target.checked })} />视觉</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={form.json} onChange={(event) => setForm({ ...form, json: event.target.checked })} />JSON</label>
              </div>
            </div>
            <label className="grid gap-1.5 text-sm">
              <span>模型列表（每行或逗号分隔）</span>
              <Textarea rows={4} value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} placeholder={'deepseek-chat\ndeepseek-reasoner'} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span>自定义请求头（JSON，可选）</span>
              <Textarea rows={3} value={form.headers} onChange={(event) => setForm({ ...form, headers: event.target.value })} placeholder={'{"X-Custom": "value"}'} />
              <span className="text-xs text-muted-foreground">鉴权/协议关键头由服务端管理，不允许覆盖。</span>
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>返回</Button>
              {editing !== 'new' && editing ? (
                <Button variant="outline" onClick={() => pullModels(editing)} disabled={busy || testingId === editing.id}>
                  {testingId === editing.id ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}拉取模型
                </Button>
              ) : null}
              <Button onClick={save} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}保存</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">已保存 {providers.length} 个渠道</div>
              <Button size="sm" onClick={beginCreate}><Plus className="size-4" />新增渠道</Button>
            </div>
            {providers.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <Server className="mx-auto mb-3 size-8 text-muted-foreground" />
                <div className="text-sm font-medium">还没有配置 AI 渠道</div>
                <p className="mt-1 text-xs text-muted-foreground">保存一次 API Key，之后可以直接在面板里选择模型使用。</p>
                <Button className="mt-4" size="sm" onClick={beginCreate}><Plus className="size-4" />接入你的 AI</Button>
              </div>
            ) : providers.map((provider) => (
              <div key={provider.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">{provider.name}</span>
                    <Badge variant={provider.id === activeProviderId ? 'default' : 'secondary'}>{provider.id === activeProviderId ? '使用中' : provider.owner === 'admin' ? '管理员' : '我的'}</Badge>
                    <span className="text-[10px] text-muted-foreground">{PROTOCOL_LABELS[provider.protocol]}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{provider.baseUrl} · {provider.keyHint} · {provider.models.length} 个模型</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{provider.lastTestStatus || '尚未测试'}</div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => onUseProvider(provider.id, provider.defaultModel || provider.models[0]?.id || '')}>使用</Button>
                  <Button size="sm" variant="ghost" onClick={() => test(provider)} disabled={testingId === provider.id}>
                    {testingId === provider.id ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />}测试
                  </Button>
                  {provider.owner === 'user' ? (
                    <Button size="icon-sm" variant="ghost" onClick={() => beginEdit(provider)} aria-label="编辑"><Pencil className="size-4" /></Button>
                  ) : (
                    <Button size="icon-sm" variant="ghost" onClick={() => beginClone(provider)} aria-label="复制为我的渠道" title="复制为我的渠道"><Copy className="size-4" /></Button>
                  )}
                  {provider.owner === 'user' ? (
                    <Button size="icon-sm" variant="ghost" onClick={() => remove(provider)} aria-label="删除"><Trash2 className="size-4" /></Button>
                  ) : null}
                </div>
              </div>
            ))}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

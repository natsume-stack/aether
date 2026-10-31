import { useState } from 'react';
import style from './style.module.scss';
import { getAgentLiveSession } from 'src/client/edit/agent-live/agent-live-client';

type Proposal = {
  proposalId: string; domain?: string; status: string; stepCount: number; rollbackAvailable: boolean;
  previews: { kind?: string; name?: string; changes?: { entityId?: string; nodeId?: string; name: string; parentId: string; properties: { key: string; before: unknown; after: unknown }[] }[]; validation?: { policy: string; clean: boolean; comparison?: { baselineErrorCount: number; introducedErrorCount: number; resolvedErrorCount: number } }; ranges?: { index: number; line?: number; deleted: number; inserted: number; before?: string; after?: string }[]; changed?: number | boolean; block?: number; region?: { min: number[]; max: number[] }; createdCount?: number; deletedCount?: number; movedCount?: number; operations?: { op: 'create' | 'delete' | 'move'; entityId: string; name?: string; parentId?: string; fromParentId?: string; mesh?: string | null; subtree?: boolean; nodeCount?: number }[] }[];
};
const statusLabel: Record<string, string> = { proposed: '待应用', expired: '已过期，请重新生成', discarded: '已放弃', applied: '已应用', reverted: '已回滚', partial: '部分完成', unknown: '需核对结果', applying: '应用中', reverting: '回滚中' };
const domainLabel: Record<string, string> = { script: '脚本', entities: '实体', entityLifecycle: '实体生命周期', ui: '界面', terrain: '地形' };

/** Review independent terrain/script proposals; no simulated cross-domain atomicity. */
export function TerrainProposals({ base }: { base: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [plans, setPlans] = useState<Array<{planId: string; status: string; appliedCount: number; domains: string[]}>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState<{ id: string; runtimeId: string }>();
  const [runtimeId, setRuntimeId] = useState('');
  const [history, setHistory] = useState<{ runtimeId: string; payload: { seq: number; at: number; summary: string } }[]>([]);

  async function tool(name: string, args: object = {}, operationId?: string) {
    const response = await fetch(`${base}/internal/ai-tool`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, args, ...(operationId ? { operationId } : {}) }), signal: AbortSignal.timeout(120_000) });
    const data = await response.json();
    if (!response.ok || data.result?.success === false) throw new Error(`${data.code || data.result?.code || response.status}: ${data.message || data.result?.error || '操作未完成'}`);
    return data.result;
  }
  async function refresh() {
    const data = await tool('authoringProposals');
    setRuntimeId(data.runtimeId);
    setProposals(data.proposals);
    const index = await tool('authoringPlans');
    setPlans(index.plans || []);
    return data.runtimeId as string;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function apply(p: Proposal, revert: boolean) {
    const id = `editor-${crypto.randomUUID()}`;
    setUncertain({ id, runtimeId });
    await tool(revert ? 'authoringRevert' : 'authoringApply', { proposalId: p.proposalId }, id);
    setUncertain(undefined);
    setMessage('修改已完成，保存后写入工程文件。');
    await refresh();
  }
  async function query() {
    if (!uncertain) return;
    const epoch = await refresh();
    const receipt = await tool('authoringOperation', { operationId: uncertain.id });
    if (epoch !== uncertain.runtimeId || receipt.status === 'recovered') {
      setUncertain(undefined);
      setMessage('已找到重启前的操作记录。历史执行不代表修改已保存，请核对当前地图后重新创建提案。');
      return;
    }
    if (receipt.status === 'running' || receipt.status === 'queued') { setMessage('操作仍在执行，请稍后查询。'); return; }
    setUncertain(undefined);
    setMessage(receipt.result?.success === false ? `${receipt.result.code || '操作失败'}：${receipt.result.error || '请核对提案状态'}` : '操作已完成，请查看提案状态并保存。');
  }
  return <details className={style.proposals}>
    <summary>创作提案</summary>
    <div className={style.actions}>
      <button disabled={busy} onClick={() => void run(async () => { await refresh(); })}>刷新提案</button>
      <button onClick={() => getAgentLiveSession()?.endRegionReview()}>返回原视角</button>
      <button disabled={busy} onClick={() => void run(async () => {
        const data = await tool('authoringHistory', { limit: 30 });
        setHistory([...data.events].reverse());
        if (!data.durable) setMessage('持久历史暂不可用，当前记录仅供本次运行查看。');
      })}>历史动作</button>
      <button disabled={busy || !!uncertain} onClick={() => void run(async () => {
        const response = await fetch(`${base}/internal/save-local-project`, { method: 'POST', signal: AbortSignal.timeout(120_000) });
        const result = await response.json();
        if (!response.ok || !result.permissionHash) throw new Error(result.message || '保存失败');
        setMessage('已保存工程。');
      })}>保存工程</button>
      {uncertain && <button disabled={busy} onClick={() => void run(query)}>查询上次操作</button>}
    </div>
    <p className={style.proposalNote}>各类提案独立应用，完成后仍需保存。重启后待应用提案过期，已应用提案仅在相关内容匹配时可回滚。</p>
    {message && <p role="status" className={style.proposalNote}>{message}</p>}
    {history.length > 0 && <details>
      <summary>历史动作 · 最近 {history.length} 条</summary>
      <ul className={style.proposalList}>{history.map(row => <li key={`${row.runtimeId}:${row.payload.seq}`}>
        {new Date(row.payload.at).toLocaleString('zh-CN')} · {row.payload.summary}
      </li>)}</ul>
    </details>}
    {plans.length > 0 && <details open>
      <summary>批次计划 · {plans.length}</summary>
      <p className={style.proposalNote}>计划按顺序执行各内容域，失败时尝试补偿。应用后需要保存工程。</p>
      <ul className={style.proposalList}>{plans.map(plan => <li key={plan.planId}>
        <strong>{statusLabel[plan.status] || plan.status}</strong> · {plan.domains.map(domain => domainLabel[domain] || domain).join('、')} · 已应用 {plan.appliedCount} 项
        <div className={style.actions}>
          {(['proposed', 'applied'].includes(plan.status)) && <button disabled={busy || !!uncertain} onClick={() => void run(async () => {
            const id = `editor-${crypto.randomUUID()}`;
            setUncertain({id, runtimeId});
            await tool(plan.status === 'proposed' ? 'authoringApplyPlan' : 'authoringRevertPlan', {planId: plan.planId}, id);
            setUncertain(undefined);
            await refresh();
            setMessage('计划处理完成，请保存工程。');
          })}>{plan.status === 'proposed' ? '批准并应用计划' : '回滚计划'}</button>}
          {plan.status === 'proposed' && <button disabled={busy || !!uncertain} onClick={() => void run(async () => {
            await tool('authoringDiscardPlan', {planId: plan.planId}, `editor-${crypto.randomUUID()}`);
            await refresh();
          })}>拒绝计划</button>}
        </div>
      </li>)}</ul>
    </details>}
    <ul className={style.proposalList}>{proposals.slice(0, 20).map(p => <li key={p.proposalId}>
      <strong>{statusLabel[p.status] || p.status}</strong> · {domainLabel[p.domain || 'terrain'] || p.domain} · {p.stepCount} 步
      {p.previews.map((preview, index) => <div key={index}>
        {preview.kind === 'script' ? <>
          {preview.name} · {preview.ranges?.length || 0} 处修改
          {preview.validation && <p className={style.proposalNote}>{preview.validation.clean ? '静态检查通过' :
            `保留原工程问题 · 原有 ${preview.validation.comparison?.baselineErrorCount ?? '—'} 项 · 新增 ${preview.validation.comparison?.introducedErrorCount ?? '—'} 项 · 修复 ${preview.validation.comparison?.resolvedErrorCount ?? '—'} 项`}</p>}
          {preview.ranges?.map((range, i) => <details key={i}>
            <summary>{range.line ? `原文第 ${range.line} 行 · ` : ''}位置 {range.index} · 删除 {range.deleted} 字符 · 插入 {range.inserted} 字符</summary>
            {range.before !== undefined || range.after !== undefined ? <div className={style.scriptDiff}>
              <div>删除内容</div><pre aria-label="删除内容">{range.before || '（空）'}</pre>
              <div>插入内容</div><pre aria-label="插入内容">{range.after || '（空）'}</pre>
            </div> : <p className={style.proposalNote}>历史提案未保存正文差分，请读取脚本核对。</p>}
          </details>)}
        </> : preview.kind === 'entities-lifecycle' ? <>
          <span>新增 {preview.createdCount ?? 0} 个 · 删除 {preview.deletedCount ?? 0} 个</span>
          {preview.operations?.map((operation: any, i: number) => <div key={i}>
            <code>{operation.op === 'create' ? '+' : '−'} {operation.name || operation.entityId}</code>
            {operation.parentId ? ` · 父级 ${operation.parentId}` : ''}
            {operation.mesh ? ` · ${operation.mesh}` : ''}
          </div>)}
        </> : preview.kind === 'entities' || preview.kind === 'ui' ? <>
          {preview.changes?.map(change => <details key={change.entityId || change.nodeId}>
            <summary>{change.name || '未命名节点'} · {change.entityId || change.nodeId} · {change.properties.length} 项属性</summary>
            <p className={style.proposalNote}>父级 {change.parentId}</p>
            {change.properties.map(property => <div key={property.key} className={style.scriptDiff}>
              <strong>{property.key}</strong>
              <div>修改前 <code>{JSON.stringify(property.before)}</code></div>
              <div>修改后 <code>{JSON.stringify(property.after)}</code></div>
            </div>)}
          </details>)}
        </> : <>
          {preview.region ? `${preview.region.min.join(',')} → ${preview.region.max.join(',')}` : '选区'}
          {` · ${preview.changed ?? 0} 格 · 方块 ${preview.block ?? '—'}`}
          {preview.region && <button disabled={busy} onClick={() => void run(async () => {
            const viewer = getAgentLiveSession();
            if (!viewer) throw new Error('编辑器尚未就绪，无法定位选区');
            await viewer.reviewRegion(preview.region!);
            setMessage('已定位修改选区；点击画面会交还视角。地图内容未改动。');
          })}>定位选区</button>}
        </>}
      </div>)}
      <div className={style.actions}>
        {p.status === 'proposed' && <button disabled={busy || !!uncertain} onClick={() => void run(() => apply(p, false))}>应用</button>}
        {['proposed', 'expired'].includes(p.status) && <button disabled={busy || !!uncertain} onClick={() => void run(async () => {
          const id = `editor-${crypto.randomUUID()}`;
          setUncertain({ id, runtimeId });
          await tool('authoringDiscard', { proposalId: p.proposalId }, id);
          setUncertain(undefined);
          setMessage('已放弃草稿，地图内容未改动。');
          await refresh();
        })}>放弃草稿</button>}
        {['applied','partial'].includes(p.status) && p.rollbackAvailable && <button disabled={busy || !!uncertain} onClick={() => void run(() => apply(p, true))}>回滚</button>}
      </div>
    </li>)}</ul>
  </details>;
}

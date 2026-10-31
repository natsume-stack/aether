import {useEffect,useRef,useState} from 'react';
import {getVoxaAgentLiveSession} from '../../models/agent-live';
import styles from './style.module.scss';

type Provider={id:string;owner:'user'|'admin';name:string;protocol:string;baseUrl:string;defaultModel:string;models:Array<{id:string}>;enabled:boolean;keyHint:string};
type Command={kind:string;args:Record<string,unknown>};
type Context=Awaited<ReturnType<NonNullable<ReturnType<typeof getVoxaAgentLiveSession>>['panelContext']>>;
type Plan={message:string;commands:Command[];context:Context};
type Draft={id?:string;name:string;protocol:string;baseUrl:string;apiKey:string;defaultModel:string;models:string};
const empty:Draft={name:'',protocol:'chat-completions',baseUrl:'https://api.openai.com/v1',apiKey:'',defaultModel:'',models:''};
async function request<T>(url:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T> {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal,credentials:'same-origin'});
  const value=await response.json();
  if(!response.ok) throw new Error(value.message || `请求失败（${response.status}）`);
  return value;
}

export function VoxaAiPanel() {
  const [open,setOpen]=useState(false);
  const [providers,setProviders]=useState<Provider[]>([]);
  const [providerId,setProviderId]=useState('');
  const [model,setModel]=useState('');
  const [autonomy,setAutonomy]=useState<'review'|'autonomous'>('review');
  const [prompt,setPrompt]=useState('');
  const [plan,setPlan]=useState<Plan>();
  const [busy,setBusy]=useState(false);
  const [note,setNote]=useState('');
  const [draft,setDraft]=useState<Draft>();
  const abort=useRef<AbortController | undefined>(undefined);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;abort.current?.abort();};},[]);
  async function load() {
    const [catalog,prefs]=await Promise.all([
      request<{providers:Provider[]}>('/api/player-ai/providers'),
      request<{preferences:Record<string,{providerId:string;model:string;autonomy:'review'|'autonomous'}>}>('/api/player-ai/preferences'),
    ]);
    if(!mounted.current) return;
    const available=catalog.providers.filter(p=>p.enabled);
    setProviders(catalog.providers);
    const pref=prefs.preferences['voxa.model'];
    const selected=available.find(p=>p.id===(providerId || pref?.providerId)) || available[0];
    setProviderId(selected?.id || '');setModel(selected?.defaultModel || selected?.models[0]?.id || '');
    if(pref && !providerId) {setAutonomy(pref.autonomy);if(pref.model) setModel(pref.model);}
  }
  async function run(action:()=>Promise<void>) {
    if(busy) return;
    setBusy(true);setNote('');
    try {await action();} catch(error) {if(mounted.current) setNote(error instanceof Error?error.message:'操作失败');}
    finally {if(mounted.current) setBusy(false);}
  }
  useEffect(()=>{if(open) void run(load);},[open]);
  async function execute(value:Plan) {
    const session=getVoxaAgentLiveSession();
    if(!session) throw new Error('模型编辑器尚未就绪');
    const controller=new AbortController();abort.current=controller;
    await session.executePanelPlan(value.commands,value.context,controller.signal,{providerId,model,mode:autonomy});
    setPlan(undefined);setNote(`已执行并保存 ${value.commands.length} 项修改，可回滚最近批次。`);
  }
  async function send() {
    const session=getVoxaAgentLiveSession();
    if(!session) throw new Error('模型编辑器尚未就绪');
    if(!providerId || !model || !prompt.trim()) throw new Error('请选择渠道和模型，并输入创作要求');
    const controller=new AbortController();abort.current=controller;
    const context=await session.panelContext();
    await request('/api/player-ai/preferences','PUT',{workflow:'voxa.model',providerId,model,autonomy},controller.signal);
    const value=await request<Omit<Plan,'context'>>('/api/ai/plan','POST',{providerId,model,prompt,context},controller.signal);
    const next={...value,context};setPlan(next);
    if(autonomy==='autonomous' && next.commands.length) await execute(next);
  }
  const selected=providers.find(p=>p.id===providerId);
  const models=[...new Set([selected?.defaultModel,...(selected?.models || []).map(m=>m.id)].filter(Boolean))];
  return <aside className={styles.panel} aria-label="VOXA AI 创作">
    <button className={styles.heading} onClick={()=>setOpen(!open)}>AI 模型创作 {open?'收起':'打开'}</button>
    {open && <div className={styles.body}>
      <label>渠道<select disabled={busy} value={providerId} onChange={e=>{setProviderId(e.target.value);const p=providers.find(p=>p.id===e.target.value);setModel(p?.defaultModel || p?.models[0]?.id || '');setPlan(undefined);}}>
        <option value="">请选择渠道</option>{providers.filter(p=>p.enabled).map(p=><option key={p.id} value={p.id}>{p.name}{p.owner==='admin'?'（平台）':''}</option>)}
      </select></label>
      <label>模型<input disabled={busy} value={model} list="voxa-ai-models" onChange={e=>{setModel(e.target.value);setPlan(undefined);}} placeholder="模型 ID，可手动填写"/><datalist id="voxa-ai-models">{models.map(id=><option key={id} value={id}/>)}</datalist></label>
      <label>执行方式<select disabled={busy} value={autonomy} onChange={e=>{setAutonomy(e.target.value as typeof autonomy);setPlan(undefined);}}><option value="review">审核：批准批次后执行</option><option value="autonomous">自主：自动执行并保存</option></select></label>
      <div className={styles.actions}>
        <button disabled={busy} onClick={()=>setDraft({...empty})}>新增渠道</button>
        {selected?.owner==='user' && <button disabled={busy} onClick={()=>setDraft({id:selected.id,name:selected.name,protocol:selected.protocol,baseUrl:selected.baseUrl,apiKey:'',defaultModel:selected.defaultModel,models:selected.models.map(m=>m.id).join('\n')})}>编辑渠道</button>}
        <button disabled={busy || !selected} onClick={()=>void run(async()=>{const result=await request<{result:{ok:boolean;message:string;latencyMs:number}}>(`/api/player-ai/providers/${providerId}/test`,'POST',{model});if(!result.result.ok) throw new Error(result.result.message);setNote(`连接成功，${result.result.latencyMs}ms`);})}>测试连接</button>
        <button disabled={busy || !selected} onClick={()=>void run(async()=>{await request(`/api/player-ai/providers/${providerId}/models`,'POST',{});await load();setNote('模型列表已更新');})}>拉取模型</button>
        {selected?.owner==='user' && <button disabled={busy} onClick={()=>{if(window.confirm('删除当前 AI 渠道？')) void run(async()=>{await request(`/api/player-ai/providers/${providerId}`,'DELETE');setProviderId('');await load();});}}>删除渠道</button>}
      </div>
      {draft && <form onSubmit={e=>{e.preventDefault();void run(async()=>{const {id,models,...fields}=draft;await request(id?`/api/player-ai/providers/${id}`:'/api/player-ai/providers',id?'PATCH':'POST',{...fields,models:models.split(/[,\n]/).map(s=>s.trim()).filter(Boolean)});setDraft(undefined);await load();});}}>
        <label>名称<input required maxLength={64} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <label>协议<select value={draft.protocol} onChange={e=>setDraft({...draft,protocol:e.target.value})}>{['chat-completions','responses','anthropic-messages'].map(p=><option key={p}>{p}</option>)}</select></label>
        <label>Base URL<input required type="url" value={draft.baseUrl} onChange={e=>setDraft({...draft,baseUrl:e.target.value})}/></label>
        <label>API Key<input required={!draft.id} type="password" autoComplete="new-password" value={draft.apiKey} placeholder={draft.id?'留空保留原密钥':''} onChange={e=>setDraft({...draft,apiKey:e.target.value})}/></label>
        <label>默认模型<input required value={draft.defaultModel} onChange={e=>setDraft({...draft,defaultModel:e.target.value})}/></label>
        <label>模型列表<textarea value={draft.models} onChange={e=>setDraft({...draft,models:e.target.value})}/></label>
        <div className={styles.actions}><button disabled={busy} type="submit">保存渠道</button><button disabled={busy} type="button" onClick={()=>setDraft(undefined)}>取消</button></div>
      </form>}
      <label>创作要求<textarea disabled={busy} value={prompt} maxLength={16000} onChange={e=>setPrompt(e.target.value)} placeholder="描述需要构建或修改的模型" rows={4}/></label>
      <div className={styles.actions}><button disabled={busy || !providerId || !model || !prompt.trim()} onClick={()=>void run(send)}>{busy?'处理中…':'发送'}</button><button disabled={!busy} onClick={()=>abort.current?.abort()}>停止</button><button disabled={busy} onClick={()=>void run(async()=>{const session=getVoxaAgentLiveSession();if(!session) throw new Error('编辑器尚未就绪');await session.rollbackPanelPlan();setPlan(undefined);setNote('已恢复并保存最近批次前的快照');})}>回滚最近批次</button></div>
      {plan && <section><p className={styles.message}>{plan.message}</p>{plan.commands.length>0 && <><details><summary>查看 {plan.commands.length} 项修改</summary><pre>{JSON.stringify(plan.commands,null,2)}</pre></details><div className={styles.actions}><button disabled={busy} onClick={()=>void run(()=>execute(plan))}>批准并执行</button><button disabled={busy} onClick={()=>setPlan(undefined)}>拒绝批次</button></div></>}</section>}
      {note && <p role="status">{note}</p>}
    </div>}
  </aside>;
}

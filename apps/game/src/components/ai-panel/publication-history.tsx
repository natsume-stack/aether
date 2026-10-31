import {useState} from 'react';
import {clientConfig} from 'src/config/client';
type Operation={id:string;version:string;status:string;createdAt:string};
export function PublicationHistory() {
  const [operations,setOperations]=useState<Operation[]>([]);const [busy,setBusy]=useState(false);const [note,setNote]=useState('');
  const url=`/api/local-projects/${encodeURIComponent(clientConfig.name || '')}/ai-publications`;
  async function request(method='GET',operationId?:string) {
    const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},...(operationId?{body:JSON.stringify({operationId})}:{})});
    const value=await response.json();if(!response.ok) throw new Error(value.message || '无法读取发布记录');return value;
  }
  async function load(){setOperations((await request()).operations);}
  async function run(action:()=>Promise<void>) {if(busy)return;setBusy(true);setNote('');try{await action();}catch(error){setNote(error instanceof Error?error.message:'操作失败');}finally{setBusy(false);}}
  return <details className="border-b p-2 text-xs"><summary className="cursor-pointer">AI 发布记录与回撤</summary>
    <p className="py-2 text-muted-foreground">回撤会移除该次 AI 发布版本，保留当前编辑内容。后续项目设置或版本发生变化时会拒绝自动回撤。</p>
    <button type="button" disabled={busy} className="rounded border px-2 py-1" onClick={()=>void run(load)}>刷新记录</button>
    {operations.map(operation=><div key={operation.id} className="flex items-center justify-between gap-2 py-1"><span>{operation.version} · {operation.status}</span><button type="button" disabled={busy || operation.status!=='published'} onClick={()=>{if(window.confirm(`回撤发布版本 ${operation.version}？`)) void run(async()=>{await request('POST',operation.id);await load();});}}>回撤发布</button></div>)}
    {note && <p role="status">{note}</p>}
  </details>;
}

import {AiProviderError} from './ai-provider-store';
const windows=new Map<string,{count:number;expires:number}>();
/** Per-process abuse guard; database ownership checks remain authoritative. */
export function limitAiProviderOperation(subject:string, action:string, maximum=10) {
  const now=Date.now();
  if(windows.size>=10000) {
    for(const [key,value] of windows) if(value.expires<=now) windows.delete(key);
    if(windows.size>=10000) throw new AiProviderError('AI_RATE_LIMITED','AI service is busy; retry later',429);
  }
  const key=JSON.stringify([subject,action]);
  const current=windows.get(key);
  const row=current && current.expires>now?current:{count:0,expires:now+60000};
  if(row.count>=maximum) throw new AiProviderError('AI_RATE_LIMITED','Too many AI configuration requests; retry in a minute',429);
  row.count++;windows.set(key,row);
}

import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';

export function privateProviderAddress(address:string):boolean {
  if(isIP(address)===4) {
    const [a,b]=address.split('.').map(Number);
    return a===0 || a===10 || a===127 || a>=224 || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && b===168) || (a===100 && b>=64 && b<=127) || (a===198 && (b===18 || b===19));
  }
  if(isIP(address)===6) {
    const value=address.toLowerCase();
    if(value==='::' || value==='::1' || /^(fc|fd|fe[89ab]|ff)/.test(value)) return true;
    if(value.startsWith('::ffff:')) {
      const suffix=value.slice(7);
      if(isIP(suffix)===4) return privateProviderAddress(suffix);
      const words=suffix.split(':');
      if(words.length!==2 || words.some(word=>!/^[0-9a-f]{1,4}$/.test(word))) return true;
      const n=parseInt(words[0],16)*65536+parseInt(words[1],16);
      return privateProviderAddress([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'));
    }
    // IPv4-compatible, transition and NAT64 prefixes can encode private IPv4.
    return value.startsWith('::') || value.startsWith('64:ff9b:') || value.startsWith('2002:');
  }
  return true;
}

/** DNS is validated inside the actual socket lookup, preventing preflight/connection rebinding. */
export const safeProviderFetch:typeof fetch=async(input,init)=>{
  const request=new Request(input,init);
  const url=new URL(request.url);
  const allowPrivate=process.env.NODE_ENV!=='production' && process.env.AI_PROVIDER_ALLOW_PRIVATE==='true';
  if(url.protocol!=='https:' && !(allowPrivate && url.protocol==='http:')) throw new Error('AI provider requires HTTPS');
  if(url.username || url.password) throw new Error('AI provider URL credentials are forbidden');
  const hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!allowPrivate && (hostname==='localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || (isIP(hostname)!==0 && privateProviderAddress(hostname)))) throw new Error('AI provider private network access is forbidden');
  const body=request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  if(body && body.byteLength>4*1024*1024) throw new Error('AI provider request is too large');
  if(request.signal.aborted) throw new Error('AI provider request cancelled');
  return new Promise<Response>((resolve,reject)=>{
    const nodeRequest=url.protocol==='https:'?httpsRequest:httpRequest;
    const headers: Record<string,string> = {'accept-encoding':'identity'};
    request.headers.forEach((value,name)=>{headers[name]=value;});
    headers['accept-encoding']='identity';
    const outgoing=nodeRequest(url,{
      method:request.method,headers,
      // A fresh connection also prevents a pooled socket from bypassing a changed policy.
      agent:false,
      lookup:(host,options,callback)=>{
        lookup(host,{all:true,verbatim:true}).then(records=>{
          if(!records.length || (!allowPrivate && records.some(record=>privateProviderAddress(record.address)))) {
            callback(new Error('AI provider private network access is forbidden'),'',4);return;
          }
          if(options.all) callback(null,records);
          else callback(null,records[0].address,records[0].family);
        },()=>callback(new Error('AI provider DNS lookup failed'),'',4));
      },
    },incoming=>{
      const status=incoming.statusCode || 502;
      if(status>=300 && status<400) {incoming.resume();reject(new Error('AI provider redirects are forbidden'));return;}
      const responseHeaders=new Headers();
      for(const [name,value] of Object.entries(incoming.headers)) {
        if(value!==undefined) responseHeaders.set(name,Array.isArray(value)?value.join(', '):value);
      }
      if(responseHeaders.has('content-encoding') && responseHeaders.get('content-encoding')!=='identity') {
        incoming.destroy();reject(new Error('AI provider returned unsupported content encoding'));return;
      }
      const stream=[204,205,304].includes(status)?null:Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(stream,{status,headers:responseHeaders}));
    });
    const cancel=()=>outgoing.destroy(new Error('AI provider request cancelled'));
    request.signal.addEventListener('abort',cancel,{once:true});
    outgoing.once('close',()=>request.signal.removeEventListener('abort',cancel));
    outgoing.once('error',reject);
    outgoing.setTimeout(120000,()=>outgoing.destroy(new Error('AI provider request timed out')));
    if(body) outgoing.write(body);
    outgoing.end();
  });
};

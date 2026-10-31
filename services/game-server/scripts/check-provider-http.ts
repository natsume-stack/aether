import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {safeProviderFetch,privateProviderAddress} from '../src/edit/ai/provider-http';

async function main(){
  for(const value of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::1','::ffff:7f00:1','fc00::1','fe80::1','64:ff9b::7f00:1']) assert.equal(privateProviderAddress(value),true,value);
  for(const value of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(privateProviderAddress(value),false,value);
  const oldPrivate=process.env.AI_PROVIDER_ALLOW_PRIVATE,oldMode=process.env.NODE_ENV;
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'http://127.0.0.1/private'});res.end();return;}
    if(req.url==='/slow')return;
    res.setHeader('Content-Type','text/plain');res.write('po');res.end('ng');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  try{
    process.env.NODE_ENV='development';process.env.AI_PROVIDER_ALLOW_PRIVATE='false';
    await assert.rejects(safeProviderFetch(url),/HTTPS|private/);
    process.env.AI_PROVIDER_ALLOW_PRIVATE='true';
    assert.equal(await (await safeProviderFetch(url)).text(),'pong');
    await assert.rejects(safeProviderFetch(`${url}/redirect`),/redirect/);
    const abort=new AbortController();const pending=safeProviderFetch(`${url}/slow`,{signal:abort.signal});
    abort.abort();await assert.rejects(pending,/cancelled/);
    process.env.NODE_ENV='production';
    await assert.rejects(safeProviderFetch(url),/HTTPS|private/);
    console.log(JSON.stringify({ok:true,checks:['private-ipv4-ipv6','stream-body','redirect-refusal','socket-cancel','production-private-opt-in-disabled']}));
  }finally{
    if(oldPrivate===undefined)delete process.env.AI_PROVIDER_ALLOW_PRIVATE;else process.env.AI_PROVIDER_ALLOW_PRIVATE=oldPrivate;
    if(oldMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldMode;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

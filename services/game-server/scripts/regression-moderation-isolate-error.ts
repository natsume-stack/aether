import assert from 'node:assert/strict'
import path from 'node:path'
import ivm from 'isolated-vm'

// Bundle the real moderation bridge into the same kind of isolate as map scripts.
const esbuild = require('../../../apps/player-auth-portal/node_modules/esbuild')
const entry = path.resolve(__dirname, '../src/moderation/moderation-script.ts')
const bundle = esbuild.buildSync({entryPoints:[entry],bundle:true,write:false,format:'iife',globalName:'ModerationTest',platform:'browser'}).outputFiles[0].text
const expected = {status:'MODERATION_CONFLICT',code:41900,msg:'已存在对应处罚，请复核或使用原 requestId 重试'}
async function main() {
  const isolate = new ivm.Isolate({memoryLimit:64})
  try {
    const context = await isolate.createContext()
    await context.eval(bundle)
    await context.eval(`
      globalThis.runModeration = () => {
        let reply, request;
        const script = new ModerationTest.ModerationScript({protocol:()=>({configure:h=>reply=h.message.reply,server:{message:{request:m=>request=m}}})},f=>f(),()=>7,{setTimeout:()=>1,clearTimeout:()=>{}});
        const pending = script.banCurrentIP({}, {reason:'测试用途',durationSeconds:1000});
        reply({handle:request.handle,success:false,payload:${JSON.stringify(JSON.stringify(expected))}});
        return pending;
      };
    `)
    await assert.rejects(context.eval('runModeration()', {promise:true}), error => {
      assert.equal((error as Error).message, JSON.stringify(expected))
      return true
    })
    const caught = await context.eval('runModeration().catch(error=>JSON.stringify({json:JSON.parse(JSON.stringify(error)),isError:error instanceof Error,status:error.status,code:error.code,msg:error.msg}))', {promise:true})
    assert.deepEqual(JSON.parse(caught as string), {json:expected,isError:true,...expected})
    console.log('Moderation isolated-vm error regression passed: real bridge, uncaught description, CommonError fields and JSON serialization')
  } finally {isolate.dispose()}
}
main().catch(error=>{console.error(error);process.exitCode=1})

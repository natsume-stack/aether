import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { buildContext, buildTools } from '../src/index.js'

test('saved model context is a bounded authenticated read and rejects bad arguments before transport', async () => {
  const requests = []
  const server = http.createServer((req,res) => {
    requests.push({ method:req.method,path:req.url,authorization:req.headers.authorization })
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({ modelId:4,revision:2,scope:'persisted source context',parts:[] }))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const context=buildContext({ BOX_VOXA_BASE_URL:`http://127.0.0.1:${server.address().port}`,BOX_VOXA_AGENT_TOKEN:'fixture-token' })
    const tool=buildTools(context).find(tool=>tool.name==='voxa_model_context')
    assert.equal(tool.annotations.readOnlyHint,true)
    assert.equal((await tool.handler({modelId:'4'})).isError,true)
    assert.equal((await tool.handler({modelId:4,limit:10000})).isError,true)
    assert.equal(requests.length,0)
    const result=await tool.handler({modelId:4,offset:7,limit:7})
    assert.equal(JSON.parse(result.content[0].text).revision,2)
    assert.deepEqual(requests,[{method:'GET',path:'/api/agent/v1/models/4/context?offset=7&limit=7&paletteOffset=0',authorization:'Bearer fixture-token'}])
  } finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())) }
})

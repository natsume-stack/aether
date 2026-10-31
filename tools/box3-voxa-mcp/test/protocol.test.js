import assert from 'node:assert/strict'
import test from 'node:test'
import { handleMessage } from '../src/index.js'

test('tool exceptions return a JSON-RPC response instead of leaving caller hanging', async () => {
  const replies = []
  const byName = new Map([['inspect', { handler: async () => { throw Object.assign(new Error('missing auth'), { code: 'AGENT_AUTH_REQUIRED' }) } }]])
  await handleMessage({ id: 7, method: 'tools/call', params: { name: 'inspect' } }, {
    byName, reply: (id, result) => replies.push({ id, result }), replyError: () => assert.fail('expected tool error result'),
  })
  assert.equal(replies.length, 1)
  assert.equal(replies[0].id, 7)
  assert.equal(replies[0].result.isError, true)
  assert.equal(JSON.parse(replies[0].result.content[0].text).code, 'AGENT_AUTH_REQUIRED')
})

test('unexpected tool errors also reply once and unknown tools use protocol error', async () => {
  const replies = []
  const errors = []
  const context = { byName: new Map([['broken', { handler: async () => { throw new Error('bad bundle') } }]]),
    reply: (id, result) => replies.push({ id, result }), replyError: (id, code) => errors.push({ id, code }) }
  await handleMessage({ id: 8, method: 'tools/call', params: { name: 'broken' } }, context)
  assert.equal(replies.length, 1)
  assert.equal(JSON.parse(replies[0].result.content[0].text).code, 'VOXA_REJECTED')
  await handleMessage({ id: 9, method: 'tools/call', params: { name: 'missing' } }, context)
  assert.deepEqual(errors, [{ id: 9, code: -32602 }])
})

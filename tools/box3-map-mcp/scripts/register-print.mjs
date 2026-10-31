#!/usr/bin/env node
/**
 * register-print — 生成各 AI 客户端的 MCP 注册 JSON（凭证不进命令行，走 env）。
 *
 *   node scripts/register-print.mjs --client zcode
 *   node scripts/register-print.mjs --client claude-code --profile readonly
 *
 * client: zcode | claude-code | cursor | generic（默认 zcode）
 * profile: authoring（默认，读写）| readonly
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(packageRoot, 'src', 'index.js')

const args = {}
for (let i = 0; i < process.argv.slice(2).length; i += 1) {
  const raw = process.argv.slice(2)[i]
  if (!raw.startsWith('--')) continue
  const eq = raw.indexOf('=')
  if (eq < 0) {
    const next = process.argv.slice(2)[i + 1]
    if (next && !next.startsWith('--')) {
      args[raw.slice(2)] = next
      i += 1
    } else args[raw.slice(2)] = true
  } else args[raw.slice(2, eq)] = raw.slice(eq + 1)
}

const client = String(args.client || 'zcode').toLowerCase()
const profile = args.profile === 'readonly' ? 'readonly' : 'authoring'
const env = {
  BOX_CREATOR_BASE_URL: 'http://127.0.0.1:3127',
  BOX_MCP_PROFILE: profile,
  // BOX_CREATOR_CLI_TOKEN: 'bxc_...'   ← 由用户在本机填充；不要提交进任何仓库
}

const serverEntry = { command: 'node', args: [entry], env }

let payload
switch (client) {
  case 'zcode':
    payload = {
      mcpServers: {
        'box3-map': { ...serverEntry },
      },
    }
    break
  case 'claude-code':
    payload = { mcpServers: { 'box3-map': serverEntry } }
    break
  case 'cursor':
    payload = { mcpServers: { 'box3-map': serverEntry } }
    break
  case 'generic':
    payload = serverEntry
    break
  default:
    console.error(`未知 client：${client}（可选 zcode | claude-code | cursor | generic）`)
    process.exit(2)
}

console.log(JSON.stringify(payload, null, 2))
console.error(`\n# 用法：把上面的 JSON 填进 ${client} 的 MCP 配置；`)
console.error('# BOX_CREATOR_CLI_TOKEN 在本机填真实 bxc_ 令牌（authoring.apply scope），不要提交。')

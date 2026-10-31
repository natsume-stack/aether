#!/usr/bin/env node
/**
 * box3-map-mcp doctor — 交付前体检：配置、引擎可达性、工具面、本地工程根。
 *
 *   node scripts/doctor.mjs
 *   BOX_CREATOR_BASE_URL=http://127.0.0.1:3127 BOX_CREATOR_CLI_TOKEN=bxc_... node scripts/doctor.mjs
 *
 * 每一项检查失败都给出"下一步动作"（与工具错误契约同风格：code + hint）。
 * 退出码 0 = 全绿；1 = 有红项。只发 GET/只读调用，绝不写。
 */
import process from 'node:process'
import { buildContext } from '../src/index.js'
import { buildTools } from '../src/tools.js'

const checks = []
const report = (name, ok, detail, hint = '') => {
  checks.push({ name, ok, detail, hint })
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok && hint) console.log(`  ↳ ${hint}`)
}

const context = buildContext()
const config = context.config

/* 1. 配置面 */
report(
  'config: BASE_URL',
  Boolean(config.creatorBaseUrl),
  config.creatorBaseUrl,
  config.creatorBaseUrl ? '' : '设置 BOX_CREATOR_BASE_URL（默认 http://127.0.0.1:3127）',
)
report(
  'config: CLI token',
  Boolean(config.cliToken),
  config.cliToken ? `${config.cliToken.slice(0, 4)}…（已加载）` : '(未设置)',
  '在玩家门户勾选 authoring.apply 签发 bxc_ CLI Token，导出 BOX_CREATOR_CLI_TOKEN。',
)
report(
  'config: profile',
  true,
  `${config.profile}${config.allowWrite ? '（允许写）' : '（写被禁）'}`,
)
report(
  'config: projectsRoot',
  Boolean(config.projectsRoot),
  config.projectsRoot || '(未设置，map_revision 将无法离线解析 headHash)',
  '设置 BOX_MAP_PROJECTS_ROOT 指向引擎本地工程目录（可选但推荐）。',
)

/* 2. 引擎可达性：直接跑 MCP 自己的 engine_health / map_list 工具 */
const tools = buildTools(context)
const callTool = async (name, args = {}) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { ok: false, detail: '工具不存在', hint: `--coverage-json 查看 ${name} 是否被 profile 过滤` }
  try {
    const result = await tool.handler(args)
    const text = Array.isArray(result?.content)
      ? result.content.map((c) => c.text || '').join(' ').slice(0, 160)
      : JSON.stringify(result).slice(0, 160)
    return { ok: !result?.isError, detail: text }
  } catch (error) {
    return { ok: false, detail: (error?.message || String(error)).slice(0, 160) }
  }
}

const health = await callTool('engine_health')
report(
  'engine: engine_health',
  health.ok,
  health.detail,
  'Creator 没起或 BASE_URL 不对；先起引擎再 curl 该地址 /api/health-check。',
)
const maps = await callTool('map_list')
report(
  'engine: map_list',
  maps.ok,
  maps.detail,
  'token 无效/scope 不足（需 projects.view）；核对 CLI Token 与 BOX_CREATOR_BASE_URL 是否同一引擎。',
)

/* 3. 工具面自检（本地能力，不打引擎） */
const names = tools.map((t) => t.name)
report('tools: catalog size', names.length > 0, `${names.length} 个工具已注册`)
report(
  'tools: write face',
  config.profile !== 'readonly' ? names.includes('terrain_apply') : true,
  config.profile !== 'readonly'
    ? (names.includes('terrain_apply') ? 'terrain_apply 已在面内' : '写工具缺失（profile=authoring 却没有写工具）')
    : 'readonly profile：写工具按设计被过滤',
)

const failed = checks.filter((c) => !c.ok)
console.log(`\ndoctor: ${checks.length - failed.length}/${checks.length} 项通过${failed.length ? `（${failed.length} 项待处理）` : '，全绿'}`)
process.exit(failed.length ? 1 : 0)

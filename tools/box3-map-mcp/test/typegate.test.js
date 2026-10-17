import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  checkScript,
  defaultDialect,
  describeContract,
  parseScript,
  scanSensitiveContent,
} from '../src/typegate.js'
import { loadContract } from '../src/contract.js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const config = {
  repoRoot,
  packageRoot: path.resolve(import.meta.dirname, '..'),
  typeGate: 'auto',
  typescriptEntry: '',
}

test('contract parses the shipped declaration files into a member list', () => {
  const contract = loadContract(repoRoot, 'server')
  assert.ok(contract.files.length >= 2, `声明文件应可读，实际：${JSON.stringify(contract.files)}`)
  assert.ok(contract.globals.world, '必须解析出 world 全局')
  assert.ok(contract.globals.world.members.length > 20, 'GameWorld 成员名单不应为空')
  assert.ok(contract.globals.world.members.includes('querySelectorAll'))
  assert.ok(!contract.globals.world.members.includes('thisMethodDoesNotExist'))
})

test('undeclared members are warnings, never a block (86 custom properties landmine)', async () => {
  const result = await checkScript(
    { side: 'server', content: 'world.Quanjujiaoyi = 1\nworld.thisMethodDoesNotExist()\n', mode: 'syntax' },
    config,
  )
  assert.equal(result.satisfied, true, '未声明成员必须只提示、不拦落盘')
  const codes = result.warnings.map((item) => item.symbol)
  assert.ok(codes.includes('world.thisMethodDoesNotExist'))
  assert.ok(codes.includes('world.Quanjujiaoyi'))
})

test('syntax gate blocks unparseable scripts', () => {
  const broken = parseScript('function ( {', 'cjs')
  assert.equal(broken.errors[0].code, 'SYNTAX_ERROR')
  assert.equal(parseScript('console.log(1)\n', 'cjs').errors.length, 0)
})

/**
 * REAL DATA (2026-10-18, read against the shipped loaders, not assumed):
 * the server isolate is CommonJS (`resource.ts:387-405` injects
 * require/module/exports and `safe-eval.ts:36-52` evaluates a function body),
 * while `clientIndex.js` executes as a genuine ES module inside an iframe
 * sandbox driven by an Import Map (`ses-client.ts:51`, `:230-232`,
 * `:283-294` `entryScript.type = 'module'`, `:334` `text/javascript` Blob).
 * The gate must therefore default per side, and must parse ESM for real
 * instead of commenting the import lines out.
 */
test('server defaults to CommonJS and rejects ESM syntax', async () => {
  assert.equal(defaultDialect('server'), 'cjs')
  assert.equal(
    parseScript("import fs from 'node:fs'\nconsole.log(1)\n", 'cjs').errors[0].code,
    'ESM_SYNTAX_IN_CJS_SCRIPT',
  )
  const checked = await checkScript(
    { side: 'server', content: "import hp from './lib.js'\nmodule.exports = { hp }\n", mode: 'syntax' },
    config,
  )
  assert.equal(checked.dialect, 'cjs')
  assert.equal(checked.dialectSource, 'side=server 默认')
  assert.equal(checked.satisfied, false)
  assert.ok(checked.errors.some((item) => item.code === 'ESM_SYNTAX_IN_CJS_SCRIPT'))
})

test('client defaults to ESM and a top-level import parses for real', async () => {
  assert.equal(defaultDialect('client'), 'esm')
  const esm = "import { hp } from './lib.js'\nimport './side-effect'\nexport const ready = true\n"
  const parsed = parseScript(esm, 'esm')
  assert.deepEqual(parsed.errors, [])
  // `stripped` used to be the tell-tale of the fake parse (comment out the
  // import lines, then vm.Script). A real module-context parse strips nothing.
  assert.equal(parsed.stripped, false)
  assert.equal(parsed.parser, 'node --check (.mjs)')
  const checked = await checkScript({ side: 'client', content: esm, mode: 'syntax' }, config)
  assert.equal(checked.dialect, 'esm')
  assert.equal(checked.satisfied, true, JSON.stringify(checked.errors))
  assert.ok(checked.notes.some((note) => note.includes('node --check')))
})

test('ESM parse catches what vm.Script could not: import.meta and top-level await', () => {
  const legal = 'const self = import.meta.url\nawait Promise.resolve(1)\nexport default self\n'
  assert.deepEqual(parseScript(legal, 'esm').errors, [])
  const broken = parseScript('import { a } from "./a.js"\nconst x = = 1\n', 'esm')
  assert.equal(broken.errors[0].code, 'SYNTAX_ERROR')
})

test('CommonJS wrapper globals are refused inside a client ESM script', async () => {
  const result = await checkScript(
    { side: 'client', content: "const lib = require('./lib.js')\nmodule.exports = lib\n", mode: 'syntax' },
    config,
  )
  assert.equal(result.satisfied, false)
  const finding = result.errors.find((item) => item.code === 'COMMONJS_GLOBALS_IN_ESM_SCRIPT')
  assert.ok(finding, 'require/module.exports 在客户端 ESM 沙箱里不存在，必须拦')
  assert.match(finding.message, /dialect:"cjs"/)
  // A commented-out require must not trip the scan.
  const commented = await checkScript(
    { side: 'client', content: "// const lib = require('./lib.js')\nexport const ok = 1\n", mode: 'syntax' },
    config,
  )
  assert.equal(commented.satisfied, true, JSON.stringify(commented.errors))
})

test('bare import specifiers in ESM are advisory, matching the require policy', async () => {
  const result = await checkScript(
    { side: 'client', content: "import _ from 'lodash'\nexport const v = _\n", mode: 'syntax' },
    config,
  )
  assert.equal(result.satisfied, true, '裸标识符只提示：Import Map 只登记本图模块，最终由运行期验收兜底')
  assert.ok(result.warnings.some((item) => item.code === 'BARE_IMPORT_SPECIFIER_UNVERIFIED'))
})

test('explicit dialect still overrides the side default', async () => {
  const legacy = await checkScript(
    { side: 'client', content: "const lib = require('./lib.js')\nmodule.exports = lib\n", dialect: 'cjs', mode: 'syntax' },
    config,
  )
  assert.equal(legacy.dialect, 'cjs')
  assert.equal(legacy.dialectSource, 'explicit')
  assert.equal(legacy.satisfied, true, '老客户端脚本可以显式按 cjs 过门，两个逃生阀（dialect / mode=off）都在')
})

test('sensitive content mirrors the engine publish rule and is blocking', () => {
  const hits = scanSensitiveContent('const dsn = "postgres://user:secret@10.0.0.1/db"\n')
  assert.equal(hits[0].code, 'SENSITIVE_CONTENT')
  assert.match(hits[0].message, /数据库连接串/)
})

test('size limit matches the protocol ceiling', async () => {
  const result = await checkScript({ side: 'server', content: 'x'.repeat(21 * 1024 * 1024), mode: 'syntax' }, config)
  assert.equal(result.satisfied, false)
  assert.equal(result.errors[0].code, 'SCRIPT_CONTENT_TOO_LARGE')
})

test('require() specifiers outside map scripts are advisory, not fatal', async () => {
  const result = await checkScript(
    { side: 'server', content: "const x = require('left-pad')\nmodule.exports = x\n", mode: 'syntax' },
    config,
  )
  assert.equal(result.satisfied, true)
  assert.ok(result.warnings.some((item) => item.code === 'REQUIRE_SPECIFIER_UNVERIFIED'))
})

test('auto mode reports honestly which tier ran', async () => {
  const result = await checkScript({ side: 'server', content: 'console.log(1)\n' }, config)
  assert.ok(['language-service', 'syntax-fallback'].includes(result.mode), `mode=${result.mode}`)
  assert.ok(result.notes.length >= 1)
})

test('client side gate uses the client SDK surface', async () => {
  const result = await checkScript(
    { side: 'client', content: 'console.log(1)\nconst t = ui.screen("MAIN")\n', mode: 'syntax' },
    config,
  )
  assert.equal(result.satisfied, true)
  const described = describeContract(config, 'client')
  assert.ok(described.declarationFiles.length >= 1, '客户端声明文件应可读')
})

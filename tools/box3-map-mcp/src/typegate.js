/**
 * Pre-write gate for author scripts (plan/N2 4.1 V0).
 *
 * Two tiers, so the loop never silently weakens itself:
 *
 *  1. `language-service` — the exact mechanism of
 *     `apps/game/scripts/check-editor-types.ts:12-54` (`ts.createLanguageService`
 *     with the same declaration files Monaco loads). Semantic diagnostics are
 *     authoritative and therefore blocking.
 *  2. `syntax` — Node-standard-library fallback when `typescript` is not
 *     resolvable in this deployment (it is a devDependency and the deployed
 *     runtime tree has no dev dependencies). Parse errors are blocking;
 *     undeclared API members are advisory warnings only.
 *
 * The tier actually used is always reported, so "the gate passed" can never be
 * mistaken for "the type check passed".
 *
 * DIALECT IS SIDE-SPECIFIC, AND IT WAS THE WRONG WAY ROUND UNTIL REAL DATA SAID
 * OTHERWISE (measured against the shipped loaders, not assumed):
 *   - server `index.js` is CommonJS. The isolate gets a CJS wrapper environment
 *     `{__dirname, __filename, require, resources, module, exports}` and runs
 *     the source as a function body
 *     (`services/game-server/src/script/bindings/resource.ts:387-405`,
 *     `script/script-shell.ts:1007`, `script/safe-eval.ts:36-52`).
 *   - client `clientIndex.js` is a real ES Module. It executes in an iframe
 *     sandbox through an Import Map and a `<script type="module">` entry
 *     (`apps/game/src/engine/script/ses/ses-client.ts:51` "支持 ES Module",
 *     `:182-188` importmap capability check, `:210`/`:230-232` map injection,
 *     `:283-294` `entryScript.type = 'module'` + `import '<entry>'`,
 *     `:334` `new Blob([...], {type:'text/javascript'})`,
 *     `:363-380` relative-specifier rewrite). There is no `require` in the
 *     injected globals (`ses/apis/index.ts:64-95`).
 *   So the default is cjs for `server` and esm for `client`; both can be
 *   overridden per call, and the override is what gets reported.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { auditSurface, declarationFiles, loadContract } from './contract.js'

const scriptMaxBytes = 20 * 1024 * 1024

/** Mirrored from `apps/local-engine/src/project-manager.js:63-73`. */
const sensitiveContentRules = [
  ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['数据库连接串', /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+:[^\s"'@]+@/i],
  ['云访问密钥', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub 访问令牌', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['Slack 访问令牌', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['OpenAI 风格密钥', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['服主管理密钥', /\bBOX_PLAY_ADMIN_TOKEN\b/],
  [
    '硬编码密码或令牌',
    /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["'][^"'\r\n]{12,}["']/i,
  ],
]

export function scanSensitiveContent(content) {
  const findings = []
  for (const [label, rule] of sensitiveContentRules) {
    const match = rule.exec(content)
    if (match) {
      findings.push({
        severity: 'error',
        code: 'SENSITIVE_CONTENT',
        message: `脚本内容命中引擎的敏感信息规则「${label}」（偏移 ${match.index}）。同样的规则会在发布/导出时打死整张图（project-manager.js:249-261），请在落盘前移除。`,
      })
    }
  }
  return findings
}

function auditRequires(specifiers) {
  const findings = []
  for (const specifier of specifiers) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) continue
    if (/^@box\/utils\//.test(specifier)) continue
    if (/\.js$/i.test(specifier)) continue
    findings.push({
      severity: 'warning',
      code: 'REQUIRE_SPECIFIER_UNVERIFIED',
      symbol: `require('${specifier}')`,
      message:
        `require('${specifier}') 不属于 map 脚本（.js）或 @box/utils/* 命名空间，沙箱里能不能解析未经验证。` +
        '运行期一旦解析失败会以 MODULE_NOT_FOUND 出现在 exception 事件里，验收回路（acceptance）会抓到它。',
    })
  }
  return findings
}

/**
 * Authoritative ES module syntax check using nothing but the Node standard
 * library: write the bytes to a temporary `.mjs` and let `node --check` parse
 * it in module context. `--check` does not resolve specifiers and does not
 * execute, so an `import` of a module that is not in the map is not reported
 * here (that is what the runtime acceptance loop is for).
 *
 * @returns {{ok:boolean, message?:string, line?:number}|{unavailable:string}}
 */
function checkEsmSyntax(content) {
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-gate-'))
    const file = path.join(dir, 'author-script.mjs')
    fs.writeFileSync(file, content, 'utf8')
    const run = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    if (run.error) return { unavailable: `node --check 无法运行：${run.error.message}` }
    if (run.status === 0) return { ok: true }
    const stderr = String(run.stderr || '')
    const syntaxError = /SyntaxError: ([^\n]+)/.exec(stderr)
    const location = new RegExp(`${path.basename(file)}:(\\d+)`).exec(stderr)
    return {
      ok: false,
      message: syntaxError ? syntaxError[1] : stderr.trim().split('\n').slice(0, 3).join(' / '),
      ...(location ? { line: Number.parseInt(location[1], 10) } : {}),
    }
  } catch (error) {
    return { unavailable: `node --check 无法运行：${error.message}` }
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Node-stdlib parse check for the CommonJS isolate loader. */
export function parseScript(content, dialect) {
  const errors = []
  if (typeof content !== 'string') {
    return { errors: [{ severity: 'error', code: 'CONTENT_NOT_TEXT', message: 'content 必须是字符串' }], stripped: false, parser: 'none' }
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > scriptMaxBytes) {
    errors.push({
      severity: 'error',
      code: 'SCRIPT_CONTENT_TOO_LARGE',
      message: `脚本内容 ${bytes} B 超过协议上限 ${scriptMaxBytes} B（packages/cli/src/index.ts:11,82-84）`,
    })
    return { errors, stripped: false, parser: 'none' }
  }
  const esm = /^\s*(?:import|export)\s/m.test(content)

  if (dialect === 'esm') {
    // Real module-context parse. The sandbox is an import-map ESM graph, so
    // top-level import/export and top-level await are legal here and must not
    // be rejected (that rejection used to make every real clientIndex.js
    // unwritable).
    const checked = checkEsmSyntax(content)
    if (!checked.unavailable) {
      if (!checked.ok) {
        errors.push({
          severity: 'error',
          code: 'SYNTAX_ERROR',
          message: String(checked.message),
          ...(checked.line ? { line: checked.line } : {}),
          dialect,
        })
      }
      return { errors, stripped: false, parser: 'node --check (.mjs)' }
    }
    // Fallback: comment out the top-level import/export lines and parse the
    // remainder. Weaker (it cannot see import.meta / top-level await), so it is
    // reported through `stripped` and the caller's notes.
    const strippedBody = content
      .split('\n')
      .map((line) => (/^\s*(?:import|export)\s/.test(line) ? `// stripped: ${line}` : line))
      .join('\n')
    try {
      new vm.Script(strippedBody, { filename: 'author-script.js' })
    } catch (error) {
      errors.push({ severity: 'error', code: 'SYNTAX_ERROR', message: String(error.message || error), dialect })
    }
    return {
      errors,
      stripped: esm,
      parser: 'vm-strip-fallback',
      parserNote: checked.unavailable,
    }
  }

  if (esm) {
    return {
      errors: [
        {
          severity: 'error',
          code: 'ESM_SYNTAX_IN_CJS_SCRIPT',
          message:
            '服务端脚本由 CommonJS 沙箱加载（resource.ts:387-405 注入 require/module/exports，safe-eval.ts:36-52 以函数体求值），' +
            '但内容含顶层 import/export 语句。要么改用 require()，要么显式传 dialect:"esm"' +
            '（客户端 clientIndex.js 的真实方言就是 esm，side=client 时这是默认值）。',
        },
      ],
      stripped: false,
      parser: 'none',
    }
  }
  try {
    new vm.Script(content, { filename: 'author-script.js' })
  } catch (error) {
    errors.push({ severity: 'error', code: 'SYNTAX_ERROR', message: String(error.message || error), dialect })
  }
  return { errors, stripped: false, parser: 'node:vm (script body)' }
}

/** Comment stripper good enough to keep the CJS-global scan off commented code. */
function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function collectRequires(content) {
  const specifiers = new Set()
  for (const match of stripComments(content).matchAll(/\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) {
    specifiers.add(match[2])
  }
  return [...specifiers]
}

function collectImports(content) {
  const specifiers = new Set()
  const body = stripComments(content)
  for (const match of body.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*(['"])([^'"\n]+)\1/g)) specifiers.add(match[2])
  for (const match of body.matchAll(/\bimport\s*\(?\s*(['"])([^'"\n]+)\1/g)) specifiers.add(match[2])
  for (const match of body.matchAll(/\bimport\s+(['"])([^'"\n]+)\1/g)) specifiers.add(match[2])
  return [...specifiers]
}

/**
 * A client script runs as an ES module inside the iframe sandbox, so the CJS
 * wrapper names genuinely do not exist there: `require`, `module`, `exports`
 * are never injected (`ses/apis/index.ts:64-95` lists what is). Bare import
 * specifiers are a separate, softer case: the Import Map only registers this
 * map's own modules (`ses-client.ts:318-353`), and relative specifiers resolve
 * with or without the `.js` extension (`:346-350`).
 */
export function auditModuleDialect(content, dialect) {
  const findings = []
  const body = stripComments(content)
  if (dialect === 'esm') {
    const cjsNames = [...new Set([...body.matchAll(/\b(module\.exports|exports|require)\b/g)].map((m) => m[1]))]
    if (cjsNames.length) {
      findings.push({
        severity: 'error',
        code: 'COMMONJS_GLOBALS_IN_ESM_SCRIPT',
        symbol: cjsNames.join(', '),
        message:
          `客户端脚本在 import-map ES Module 沙箱里执行（ses-client.ts:283-294 type="module"），` +
          `注入的全局里没有 ${cjsNames.join(' / ')}（ses/apis/index.ts:64-95），运行期会直接 ReferenceError。` +
          '改用 import/export；确实要保留 CommonJS 老脚本时显式传 dialect:"cjs"，或把类型门降到 mode:"off"。',
      })
    }
    for (const specifier of collectImports(content)) {
      if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) continue
      findings.push({
        severity: 'warning',
        code: 'BARE_IMPORT_SPECIFIER_UNVERIFIED',
        symbol: `import '${specifier}'`,
        message:
          `import '${specifier}' 是裸标识符：客户端 Import Map 只登记本图自己的模块（ses-client.ts:318-353），` +
          '裸标识符解析不到就是运行期 TypeError，运行期验收回路（acceptance）会抓到它。',
      })
    }
  }
  return findings
}

async function resolveTypeScript(config) {
  if (config.typescriptEntry) {
    return pathToFileURL(path.resolve(config.typescriptEntry)).href
  }
  const requireFrom = createRequire(import.meta.url)
  for (const base of [config.repoRoot, path.join(config.repoRoot, 'services/game-server'), config.packageRoot]) {
    try {
      return pathToFileURL(requireFrom.resolve('typescript', { paths: [base] })).href
    } catch {
      // try the next base
    }
  }
  return ''
}

const languageServices = new Map()

async function getLanguageService(config, side) {
  const cached = languageServices.get(side)
  if (cached) return cached
  const tsUrl = await resolveTypeScript(config)
  if (!tsUrl) return undefined
  const module = await import(tsUrl)
  const ts = module.default ?? module
  if (!ts || typeof ts.createLanguageService !== 'function') return undefined

  const files = {}
  const missing = []
  const wanted =
    side === 'client'
      ? [['client-api.d.ts', declarationFiles.client[0]]]
      : [
          ['api.d.ts', 'apps/game/src/resource/api-declarations.dts'],
          ['server-api.d.ts', 'packages/script-api/dts/server-api-types.dts'],
        ]
  for (const [virtualName, relative] of wanted) {
    const absolute = path.join(config.repoRoot, relative)
    if (!fs.existsSync(absolute)) {
      missing.push(relative)
      continue
    }
    files[path.join(config.repoRoot, virtualName)] = fs.readFileSync(absolute, 'utf8')
  }
  if (missing.length || !Object.keys(files).length) {
    return { unavailable: `声明文件缺失：${missing.join(', ')}` }
  }

  let source = ''
  let version = 0
  // The probe file has to be parsed in the same module context the sandbox uses,
  // otherwise the language service reports every real `clientIndex.js` as
  // "Cannot use import statement outside a module". `.mjs` is the ESM probe.
  const scriptPath = path.join(
    config.repoRoot,
    side === 'client' ? '__box3_map_mcp_probe__.mjs' : '__box3_map_mcp_probe__.js',
  )
  const options = {
    target: ts.ScriptTarget.ES2020,
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    // Without this, `module` defaults to CommonJS and every legal `clientIndex.js`
    // is reported as "Cannot use import statement outside a module".
    module: ts.ModuleKind.ESNext,
  }
  const service = ts.createLanguageService({
    getCompilationSettings: () => options,
    getScriptFileNames: () => [scriptPath, ...Object.keys(files)],
    getScriptVersion: (file) => (file === scriptPath ? String(version) : '1'),
    getScriptSnapshot: (file) => {
      const text = file === scriptPath ? source : files[file] ?? ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => config.repoRoot,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (file) => file === scriptPath || file in files || ts.sys.fileExists(file),
    readFile: (file) => files[file] ?? ts.sys.readFile(file),
    readDirectory: ts.sys.readDirectory,
  })
  const handle = {
    ts,
    service,
    scriptPath,
    setSource(code) {
      source = code
      version += 1
    },
    check(code) {
      handle.setSource(code)
      const report = []
      for (const diagnostic of [
        ...service.getSyntacticDiagnostics(scriptPath),
        ...service.getSemanticDiagnostics(scriptPath),
      ]) {
        const { line, character } = service
          .getProgram()
          .getSourceFile(scriptPath)
          .getLineAndCharacterOfPosition(diagnostic.start ?? 0)
        report.push({
          severity: diagnostic.category === 0 ? 'warning' : 'error',
          code: `TS${diagnostic.code}`,
          line: line + 1,
          column: character + 1,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        })
      }
      return report
    },
    completions(expression) {
      handle.setSource(expression)
      return (
        service.getCompletionsAtPosition(scriptPath, expression.length, {})?.entries.map((e) => e.name) || []
      )
    },
  }
  languageServices.set(side, handle)
  return handle
}

/** The loader each side actually uses decides the default dialect. */
export function defaultDialect(side) {
  return side === 'client' ? 'esm' : 'cjs'
}

/**
 * @param {{content:string, side:'server'|'client', dialect?:'cjs'|'esm',
 *   mode?:'auto'|'language-service'|'syntax'|'off'}} args
 */
export async function checkScript(args, config) {
  const side = args.side === 'client' ? 'client' : 'server'
  const dialect = args.dialect === 'esm' || args.dialect === 'cjs' ? args.dialect : defaultDialect(side)
  const dialectSource = args.dialect === 'esm' || args.dialect === 'cjs' ? 'explicit' : `side=${side} 默认`
  const requested = args.mode || config.typeGate
  const notes = [`dialect=${dialect}（${dialectSource}）：服务端 index.js 走 CommonJS 沙箱，客户端 clientIndex.js 走 import-map ES Module 沙箱。`]

  if (requested === 'off') {
    return {
      satisfied: true,
      mode: 'off',
      blocking: false,
      dialect,
      dialectSource,
      errors: [],
      warnings: [],
      notes: ['typeGate=off：本次没有做任何落盘前校验，兼容性完全靠运行期验收回路兜底。'],
    }
  }

  const structural = parseScript(args.content, dialect)
  const errors = [...structural.errors]
  const warnings = []
  notes.push(`解析器：${structural.parser}`)
  if (structural.parserNote) notes.push(structural.parserNote)
  if (structural.stripped) {
    notes.push('dialect=esm 且 node --check 不可用：解析前注释掉了顶层 import/export 行，解析结论只覆盖其余语句。')
  }
  errors.push(...scanSensitiveContent(args.content))
  const moduleFindings = auditModuleDialect(args.content, dialect)
  errors.push(...moduleFindings.filter((item) => item.severity === 'error'))
  warnings.push(...auditRequires(collectRequires(args.content)))
  warnings.push(...moduleFindings.filter((item) => item.severity !== 'error'))

  if (requested !== 'language-service') {
    const contract = loadContract(config.repoRoot, side)
    if (contract.files.length) {
      warnings.push(...auditSurface(contract, args.content))
      notes.push(`未声明成员比对依据：${contract.files.join(', ')}`)
    } else {
      notes.push(
        `仓库声明文件不可读（${declarationFiles[side].join(', ')}），未做未声明成员比对；请设置 BOX_ENGINE_REPO_ROOT。`,
      )
    }
  }

  if (requested === 'syntax') {
    return { satisfied: !errors.length, mode: 'syntax', blocking: true, dialect, dialectSource, errors, warnings, notes }
  }

  const handle = await getLanguageService(config, side)
  if (!handle || handle.unavailable) {
    if (requested === 'language-service') {
      return {
        satisfied: false,
        mode: 'language-service',
        blocking: true,
        dialect,
        dialectSource,
        errors: [
          {
            severity: 'error',
            code: 'TYPESCRIPT_UNAVAILABLE',
            message:
              handle && handle.unavailable
                ? handle.unavailable
                : '无法解析 typescript 模块：它是 devDependency，部署树里没有。请设 BOX_TYPESCRIPT_ENTRY 指向一个 typescript/lib/typescript.js，或改用 BOX_MCP_TYPEGATE=syntax。',
          },
        ],
        warnings,
        notes,
      }
    }
    notes.push(
      'typescript 不可解析，已降级到 syntax 层（node --check / node:vm 解析 + 声明文件未声明成员提示）。这一层不含语义类型检查。',
    )
    return {
      satisfied: !errors.length,
      mode: 'syntax-fallback',
      blocking: true,
      dialect,
      dialectSource,
      errors,
      warnings,
      notes,
    }
  }

  const diagnostics = handle.check(args.content)
  const typeErrors = diagnostics.filter((item) => item.severity === 'error')
  return {
    satisfied: !typeErrors.length && !errors.length,
    mode: 'language-service',
    blocking: true,
    dialect,
    dialectSource,
    errors: [...errors, ...typeErrors],
    warnings: [...warnings, ...diagnostics.filter((item) => item.severity === 'warning')],
    notes: ['类型门使用 ts.createLanguageService + 编辑器同款声明文件（check-editor-types.ts 同一机制）。', ...notes],
  }
}

/** `contract_describe`-style lookup used by the read tools. */
export function describeContract(config, side, filter) {
  const contract = loadContract(config.repoRoot, side)
  const entries = Object.entries(contract.globals)
  const selected = filter
    ? entries.filter(([name, entry]) => name === filter || entry.members.includes(filter))
    : entries
  return {
    side,
    declarationFiles: contract.files,
    missingDeclarationFiles: contract.missing,
    globals: selected.map(([name, entry]) => ({ name, type: entry.type, members: entry.members })),
  }
}

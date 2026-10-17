/**
 * Authoritative-API surface reader.
 *
 * Parses the shipped declaration files into "global name -> set of member
 * names" so the MCP can tell an AI "world.foo is not declared" without ever
 * guessing the API from memory (plan/N2 5.1 #4).
 *
 * IMPORTANT (O1 M1 / O2 地雷 1): the result is ADVISORY only. Real maps attach
 * undeclared custom properties to `world` / `player` / `entity` (G3 2.4 counts
 * 86 of them), so an undeclared member is never a hard failure here and the
 * MCP must not freeze, seal or whitelist-gate anything it hands to a script.
 */
import fs from 'node:fs'
import path from 'node:path'

const declarationFiles = {
  server: [
    'apps/game/src/resource/api-declarations.dts',
    'packages/script-api/dts/box3-server-api.d.ts',
    'packages/script-api/dts/server-api-types.dts',
  ],
  client: ['packages/script-api/dts/client-api-types.dts'],
}

const memberPrefixes = new Set(['get', 'set', 'static', 'readonly', 'abstract', 'async', 'declare'])

/** Return the text between the first `{` at `start` and its matching brace. */
function blockAt(source, openIndex) {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, index)
    }
  }
  return source.slice(openIndex + 1)
}

function memberNames(body) {
  const names = new Set()
  let depth = 0
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    const before = depth
    const opens = (line.match(/[{([]/g) || []).length
    const closes = (line.match(/[})\]]/g) || []).length
    if (before === 0) {
      const match = /^(?:public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*[<(:?]/.exec(line)
      if (match) {
        const head = match[1]
        if (!memberPrefixes.has(head)) names.add(head)
        else {
          const second = new RegExp(`^${head}\\s+([A-Za-z_$][\\w$]*)`).exec(line)
          if (second) names.add(second[1])
        }
      } else {
        const indexSig = /^\[/.test(line)
        if (indexSig) names.add('[index]')
      }
    }
    depth += opens - closes
    if (depth < 0) depth = 0
  }
  return names
}

function parseDeclarations(source) {
  const globals = new Map()
  const types = new Map()

  const typeBlock = /(?:declare\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_$][\w$]*)([^{]*)\{/g
  for (const match of source.matchAll(typeBlock)) {
    const name = match[1]
    const clause = match[2] || ''
    const brace = source.indexOf('{', match.index + match[0].length - 1)
    const body = blockAt(source, brace)
    const own = memberNames(body)
    const related = []
    const heritage = /(?:extends|implements)\s+([A-Za-z_$][\w$<>,\s.]*)/.exec(clause)
    if (heritage) {
      for (const token of heritage[1].split(',')) {
        const base = /([A-Za-z_$][\w$]*)/.exec(String(token).trim())
        if (base && base[1] !== name) related.push(base[1])
      }
    }
    types.set(name, { own, related })
  }

  const constDecl = /declare\s+const\s+([A-Za-z_$][\w$]*)\s*:\s*(\{|[A-Za-z_$][\w$<>.]*)/g
  for (const match of source.matchAll(constDecl)) {
    const [, globalName, rawType] = match
    const typeName = String(rawType || '').trim()
    if (typeName === '{') {
      const brace = source.indexOf('{', match.index + match[0].length - 1)
      globals.set(globalName, { type: '(inline)', members: memberNames(blockAt(source, brace)) })
    } else {
      globals.set(globalName, { type: typeName.replace(/<.*>$/, ''), members: undefined })
    }
  }

  const fnDecl = /declare\s+(?:function|var)\s+([A-Za-z_$][\w$]*)/g
  for (const match of source.matchAll(fnDecl)) {
    if (!globals.has(match[1])) globals.set(match[1], { type: 'function', members: new Set() })
  }

  return { globals, types }
}

function resolveMembers(parsed, typeName, seen = new Set()) {
  if (!typeName || seen.has(typeName)) return new Set()
  seen.add(typeName)
  const entry = parsed.types.get(typeName)
  if (!entry) return new Set()
  const names = new Set(entry.own)
  for (const related of entry.related) {
    for (const name of resolveMembers(parsed, related, seen)) names.add(name)
  }
  return names
}

/**
 * @returns {{side:string, files:string[], missing:string[], globals:Object<string,
 *   {type:string, members:string[]}>, declaredGlobalNames:string[]}}
 */
export function loadContract(repoRoot, side) {
  const files = []
  const missing = []
  const parsed = { globals: new Map(), types: new Map() }
  for (const relative of declarationFiles[side] || declarationFiles.server) {
    const absolute = path.join(repoRoot, relative)
    if (!fs.existsSync(absolute)) {
      missing.push(relative)
      continue
    }
    files.push(relative)
    const local = parseDeclarations(fs.readFileSync(absolute, 'utf8'))
    for (const [name, value] of local.globals) if (!parsed.globals.has(name)) parsed.globals.set(name, value)
    for (const [name, value] of local.types) if (!parsed.types.has(name)) parsed.types.set(name, value)
  }
  const globals = {}
  for (const [name, entry] of parsed.globals) {
    globals[name] = {
      type: entry.type,
      members: entry.members ? [...entry.members].sort() : [...resolveMembers(parsed, entry.type)].sort(),
    }
  }
  return {
    side,
    files,
    missing,
    globals,
    declaredGlobalNames: Object.keys(globals).sort(),
  }
}

/**
 * Undeclared member / global usage as warnings. Deliberately conservative:
 * only `world.x`, `storage.x`, `gui.x`, … (identifier immediately after a
 * known API global) is reported, and never as an error.
 */
export function auditSurface(contract, content) {
  const findings = []
  const globals = contract.globals || {}
  for (const [name, entry] of Object.entries(globals)) {
    if (!entry.members || !entry.members.length) continue
    const known = new Set(entry.members)
    const pattern = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g')
    for (const match of content.matchAll(pattern)) {
      if (!known.has(match[1])) {
        findings.push({
          severity: 'warning',
          code: 'UNDECLARED_API_MEMBER',
          symbol: `${name}.${match[1]}`,
          message: `${name}.${match[1]} 不在 ${contract.side} 声明文件里。已知地图会在 API 对象上挂自定义属性（G3 2.4 计 86 个），所以这只是提示，不阻止落盘；若这不是本图自定义挂载，请到声明文件（${(declarationFiles[contract.side] || []).join(', ')}）核对真实签名。`,
        })
      }
    }
  }
  return findings
}

export { declarationFiles }

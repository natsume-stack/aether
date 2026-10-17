/**
 * MCP over stdio: newline-delimited JSON-RPC 2.0, minimal face
 * (initialize / initialized / ping / tools/list / tools/call).
 *
 * Deliberately NOT a dependency on an MCP SDK: this deployment has no package
 * manager access, and the protocol surface a client needs for a tool server is
 * four methods. Framing follows the stdio transport rule "one JSON-RPC message
 * per line, no embedded newlines".
 */
import process from 'node:process'
import { buildTools } from './tools.js'

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'box3-map-mcp', title: 'BOX3 地图创作 MCP（切片 A）', version: '0.1.0' }

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    _meta: { 'box3-map-mcp/scope': tool.scope },
  }
}

/** Validate a tool call against the advertised JSON Schema (small local subset). */
export function validateArgs(schema, args) {
  const problems = []
  const value = args === undefined || args === null ? {} : args
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: '', message: 'arguments 必须是一个对象' }]
  }
  for (const required of schema.required || []) {
    if (value[required] === undefined) problems.push({ path: required, message: `缺少必填参数 ${required}` })
  }
  for (const [key, current] of Object.entries(value)) {
    const spec = (schema.properties || {})[key]
    if (!spec) {
      if (schema.additionalProperties === false) problems.push({ path: key, message: `未声明的参数 ${key}` })
      continue
    }
    if (spec.type === 'string' && typeof current !== 'string') problems.push({ path: key, message: `${key} 必须是字符串` })
    if (spec.type === 'integer' && !(Number.isInteger(current) || (typeof current === 'string' && /^\d+$/.test(current)))) {
      problems.push({ path: key, message: `${key} 必须是整数` })
    }
    if (spec.type === 'boolean' && typeof current !== 'boolean') problems.push({ path: key, message: `${key} 必须是布尔` })
    if (spec.enum && !spec.enum.includes(current)) problems.push({ path: key, message: `${key} 只能是 ${spec.enum.join(' | ')}` })
    if (spec.pattern && typeof current === 'string' && !new RegExp(spec.pattern).test(current)) {
      problems.push({ path: key, message: `${key} 不符合格式 ${spec.pattern}` })
    }
    if (spec.minimum !== undefined && typeof current === 'number' && current < spec.minimum) {
      problems.push({ path: key, message: `${key} 不能小于 ${spec.minimum}` })
    }
    if (spec.maxLength !== undefined && typeof current === 'string' && current.length > spec.maxLength) {
      problems.push({ path: key, message: `${key} 长度超过 ${spec.maxLength}` })
    }
  }
  return problems
}

export function createHandler(ctx) {
  const tools = buildTools(ctx)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0') {
      return rpcError(message && message.id, -32600, 'Invalid Request：缺少 jsonrpc:"2.0"')
    }
    const { id, method, params } = message
    const isNotification = id === undefined || id === null

    if (method === 'initialize') {
      const requested = params && params.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0]
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '只读工具映射到 creator/v1 现有 scope；唯一写工具 script_write 默认 dry-run，' +
          '真写必须带 expectedRevision（引擎 scripts.update 无 CAS）。' +
          '改代码的固定顺序：script_write(dry-run 取 revision) → script_write(confirm) → ' +
          'script_read 读回 → runtime_events_tail 断言无 exception / 无 MODULE_NOT_FOUND。',
      })
    }
    if (method === 'notifications/initialized' || method === 'initialized') return undefined
    if (method === 'ping') return isNotification ? undefined : rpcResult(id, {})
    if (method === 'logging/setLogLevels') return rpcResult(id, {})
    if (method === 'tools/list') {
      return rpcResult(id, {
        tools: tools.map(publicTool),
        ...(ctx.config.cliToken ? {} : { degraded: '未设置 BOX_CREATOR_CLI_TOKEN：除 engine_health 外的引擎类工具会返回 CLI_TOKEN_MISSING' }),
      })
    }
    if (method === 'tools/call') {
      const name = params && params.name
      const tool = byName.get(name)
      if (!tool) return rpcError(id, -32602, `未知工具：${name}`)
      const args = (params && params.arguments) || {}
      const problems = validateArgs(tool.inputSchema, args)
      if (problems.length) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `参数校验未通过：${JSON.stringify(problems)}` }],
          structuredContent: { error: { code: 'INVALID_ARGS', problems } },
        })
      }
      try {
        const result = await tool.handler(args, ctx)
        return rpcResult(id, {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        })
      } catch (error) {
        const payload = {
          code: error.code || 'TOOL_FAILED',
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
        }
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: { error: payload },
        })
      }
    }
    if (isNotification) return undefined
    return rpcError(id, -32601, `方法未实现：${method}`)
  }
}

export function startStdioServer(ctx, stream = process.stdin, sink = process.stdout) {
  const handle = createHandler(ctx)
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        write(sink, rpcError(null, -32700, `JSON 解析失败：${error.message}`))
        continue
      }
      Promise.resolve(handle(message)).then((response) => {
        if (response !== undefined) write(sink, response)
      }, (error) => {
        write(sink, rpcError(message.id ?? null, -32603, `内部错误：${error.message}`))
      })
    }
  })
  stream.on('end', () => {
    // stdout is the control plane; diagnostics must never corrupt it.
    process.stderr.write('[box3-map-mcp] stdin closed\n')
  })
}

function write(sink, message) {
  sink.write(`${JSON.stringify(message)}\n`)
}

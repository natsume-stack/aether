/**
 * MCP stdio server for the live agent surface. The protocol face is the same
 * minimal four methods used by box3-map-mcp: initialize / ping / tools/list /
 * tools/call. No SDK dependency, one JSON-RPC message per line.
 */
import process from 'node:process';

import { errorPayload } from './errors.js';
import { buildTools } from './tools.js';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {
  name: 'box3-agent-mcp',
  title: 'BOX3 活体创作 MCP（编辑器内执行）',
  version: '0.1.0',
};

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

export function validateArgs(schema, args) {
  const problems = [];
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: '', message: 'arguments 必须是一个对象' }];
  }
  for (const required of schema.required || []) {
    if (value[required] === undefined) problems.push({ path: required, message: `缺少必填参数 ${required}` });
  }
  for (const [key, current] of Object.entries(value)) {
    const spec = (schema.properties || {})[key];
    if (!spec) {
      if (schema.additionalProperties === false) problems.push({ path: key, message: `未声明的参数 ${key}` });
      continue;
    }
    if (spec.type === 'string' && typeof current !== 'string') problems.push({ path: key, message: `${key} 必须是字符串` });
    if (spec.type === 'integer' && !(Number.isInteger(current) || (typeof current === 'string' && /^\d+$/.test(current)))) {
      problems.push({ path: key, message: `${key} 必须是整数` });
    }
    if (spec.type === 'number' && typeof current !== 'number') problems.push({ path: key, message: `${key} 必须是数字` });
    if (spec.type === 'boolean' && typeof current !== 'boolean') problems.push({ path: key, message: `${key} 必须是布尔` });
    if (spec.type === 'array' && !Array.isArray(current)) problems.push({ path: key, message: `${key} 必须是数组` });
    if (spec.enum && !spec.enum.includes(current)) problems.push({ path: key, message: `${key} 只能是 ${spec.enum.join(' | ')}` });
    if (spec.minimum !== undefined && typeof current === 'number' && current < spec.minimum) {
      problems.push({ path: key, message: `${key} 不能小于 ${spec.minimum}` });
    }
    if (spec.maximum !== undefined && typeof current === 'number' && current > spec.maximum) {
      problems.push({ path: key, message: `${key} 不能大于 ${spec.maximum}` });
    }
    if (spec.maxLength !== undefined && typeof current === 'string' && current.length > spec.maxLength) {
      problems.push({ path: key, message: `${key} 长度超过 ${spec.maxLength}` });
    }
    if (spec.type === 'array' && spec.minItems !== undefined && current.length < spec.minItems) {
      problems.push({ path: key, message: `${key} 至少需要 ${spec.minItems} 项` });
    }
    if (spec.type === 'array' && spec.maxItems !== undefined && current.length > spec.maxItems) {
      problems.push({ path: key, message: `${key} 最多 ${spec.maxItems} 项` });
    }
  }
  return problems;
}

export function createHandler(context) {
  const { client, config } = context;
  const tools = buildTools(client, config);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length) {
    const names = tools.map((tool) => tool.name);
    const doubled = names.filter((name, index) => names.indexOf(name) !== index);
    throw new Error(`重名注册：${[...new Set(doubled)].join(', ')}`);
  }

  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0') {
      return rpcError(message && message.id, -32600, 'Invalid Request：缺少 jsonrpc:"2.0"');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '这是“活体”创作通道：命令由当前打开的编辑器标签页执行，人类能实时看到镜头、光标和每一次搭建。' +
          '先 agent_status / voxa_status 确认已接入，再 observe，然后 look → cursor → place/paint，一次一步。' +
          '每个写命令都会等待编辑器回执；失败回 {code, retryable, hint}，按 hint 处理，不要盲目重放写操作。' +
          '编辑器未打开时返回 EDITOR_NOT_ATTACHED——先让人打开地图/VOXA，不要绕过去直接改盘。' +
          '人点击或滚动画面会交还视角；需要继续时重新 look。',
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return undefined;
    if (method === 'ping') return isNotification ? undefined : rpcResult(id, {});
    if (method === 'logging/setLogLevels') return rpcResult(id, {});
    if (method === 'tools/list') {
      return rpcResult(id, { tools: tools.map(publicTool) });
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      const tool = byName.get(name);
      if (!tool) return rpcError(id, -32602, `未知工具：${name}`);
      const args = (params && params.arguments) || {};
      const problems = validateArgs(tool.inputSchema, args);
      if (problems.length) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(problems, null, 2) }],
          structuredContent: {
            error: errorPayload(Object.assign(new Error('参数校验未通过'), { code: 'INVALID_ARGS' }), { problems }),
          },
        });
      }
      try {
        const output = await tool.handler(args, context);
        return rpcResult(id, toToolResult(output));
      } catch (error) {
        return rpcResult(id, inBandError(error));
      }
    }
    if (isNotification) return undefined;
    return rpcError(id, -32601, `方法未实现：${method}`);
  };
}

function toToolResult(output) {
  const summary = output?.summary;
  const data = output?.data === undefined ? output : output.data;
  const structured = {
    ...(summary ? { summary } : {}),
    ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { data }),
  };
  const content = [];
  if (output?.image?.data) {
    content.push({ type: 'image', mimeType: output.image.mimeType || 'image/jpeg', data: output.image.data });
  }
  content.push({ type: 'text', text: JSON.stringify(structured, null, 2) });
  return {
    isError: false,
    content,
    structuredContent: structured,
  };
}

function inBandError(error, extra) {
  const payload = errorPayload(error, extra);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: { error: payload },
  };
}

export function startStdioServer(context, stream = process.stdin, sink = process.stdout) {
  const handle = createHandler(context);
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        write(sink, rpcError(null, -32700, `JSON 解析失败：${error.message}`));
        continue;
      }
      Promise.resolve(handle(message)).then(
        (response) => {
          if (response !== undefined) write(sink, response);
        },
        (error) => {
          write(sink, rpcError(message.id ?? null, -32603, `内部错误：${error.message}`));
        },
      );
    }
  });
  stream.on('end', () => {
    process.stderr.write('[box3-agent-mcp] stdin closed\n');
  });
}

function write(sink, message) {
  sink.write(`${JSON.stringify(message)}\n`);
}

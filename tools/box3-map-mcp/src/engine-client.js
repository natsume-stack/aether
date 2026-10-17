/**
 * Minimal Creator `creator/v1` HTTP client. Node standard library only: the
 * deployment this ships into has no package manager access.
 *
 * The Creator guard (`apps/game/server/creator-api-security.ts:38-73`) accepts
 * a plain HTTP client as long as Host stays on the loopback allowlist and no
 * browser-only `Origin`/`Sec-Fetch-Site` header is invented, so this client
 * deliberately sends the smallest possible header set.
 */
import http from 'node:http'
import { URL } from 'node:url'

export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.status = extra.status
    this.detail = extra.detail
  }
}

function buildUrl(spec, config) {
  const url = new URL(spec.path, config.creatorBaseUrl)
  for (const [key, value] of Object.entries(spec.query || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

function requestHeaders(spec, config) {
  const headers = {
    Accept: spec.accept || 'application/json',
    'User-Agent': 'box3-map-mcp/0.1.0',
  }
  if (spec.capability && !config.cliToken) {
    throw new EngineError(
      'CLI_TOKEN_MISSING',
      `操作 "${spec.capability}" 需要 CLI Token：请设置环境变量 BOX_CREATOR_CLI_TOKEN（bxc_ 前缀，scope 必须包含 ${spec.capability}）`,
    )
  }
  if (spec.capability && config.cliToken) {
    headers.Authorization = `Bearer ${config.cliToken}`
  }
  if (spec.headers) Object.assign(headers, spec.headers)
  return headers
}

/** One JSON request/response round trip. Never leaks the bearer token. */
export function requestJson(spec, config) {
  const url = buildUrl(spec, config)
  const headers = requestHeaders(spec, config)
  const payload = spec.body === undefined ? null : Buffer.from(JSON.stringify(spec.body), 'utf8')
  if (payload) headers['Content-Type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: spec.method || 'GET',
        headers,
        timeout: spec.timeoutMs || config.timeoutMs,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = text
          if (text) {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = { raw: text }
            }
          }
          const result = {
            httpStatus: response.statusCode || 0,
            ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
            data: parsed,
          }
          if (!result.ok) {
            const body = parsed && typeof parsed === 'object' ? parsed : {}
            reject(
              new EngineError(body.code || `HTTP_${result.httpStatus}`, body.message || `引擎返回 HTTP ${result.httpStatus}`, {
                status: result.httpStatus,
                detail: body,
              }),
            )
            return
          }
          resolve(result)
        })
      },
    )
    request.on('timeout', () => {
      request.destroy(new EngineError('ENGINE_TIMEOUT', `Creator API 超时：${url.pathname}`))
    })
    request.on('error', (error) => {
      if (error instanceof EngineError) reject(error)
      else reject(new EngineError('ENGINE_UNREACHABLE', `无法连接 Creator API（${url.origin}）：${error.message}`))
    })
    if (payload) request.end(payload)
    else request.end()
  })
}

/**
 * Consume `text/event-stream` from the authorized Creator events route and
 * return a bounded tail. The upstream never closes (keep-alive 15 s), so the
 * reader stops itself: after `idleMs` of silence once at least one frame was
 * seen, or at the hard deadline.
 */
export function tailEvents(spec, config) {
  const url = buildUrl(spec, config)
  const headers = requestHeaders(spec, config)
  headers.Accept = 'text/event-stream'
  if (spec.lastEventId !== undefined && spec.lastEventId !== null) {
    headers['Last-Event-ID'] = String(spec.lastEventId)
  }
  const maxEvents = spec.maxEvents ?? 50
  const idleMs = spec.idleMs ?? config.sseIdleMs
  const deadlineAt = Date.now() + (spec.timeoutMs || config.sseTimeoutMs)

  return new Promise((resolve, reject) => {
    const collected = []
    let pending = ''
    let idleTimer
    let hardTimer
    let settled = false

    const finish = (reason) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      request.destroy()
      resolve({
        events: collected,
        stopReason: reason,
        lastEventId: collected.length ? collected[collected.length - 1].id : undefined,
      })
    }

    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish('idle'), idleMs)
      idleTimer.unref?.()
    }

    const request = http.request(url, { method: 'GET', headers }, (response) => {
      if ((response.statusCode || 0) >= 400) {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body = {}
          try {
            body = JSON.parse(text)
          } catch {
            body = { raw: text }
          }
          reject(
            new EngineError(body.code || `HTTP_${response.statusCode}`, body.message || `事件流返回 HTTP ${response.statusCode}`, {
              status: response.statusCode,
              detail: body,
            }),
          )
        })
        return
      }
      armIdle()
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        pending += chunk
        let match
        const separator = /\r?\n\r?\n/
        // SSE frame separators are a blank line, LF or CRLF.
        while ((match = separator.exec(pending))) {
          const frame = pending.slice(0, match.index)
          pending = pending.slice(match.index + match[0].length)
          const event = parseFrame(frame)
          if (event) {
            collected.push(event)
            armIdle()
            if (collected.length >= maxEvents) finish('max-events')
          }
        }
        if (Date.now() > deadlineAt) finish('timeout')
      })
      response.on('end', () => finish('stream-end'))
      response.on('error', () => finish('stream-error'))
    })
    request.on('timeout', () => finish('timeout'))
    request.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(hardTimer)
      reject(
        error instanceof EngineError
          ? error
          : new EngineError('ENGINE_UNREACHABLE', `无法连接 Creator 事件流（${url.origin}）：${error.message}`),
      )
    })
    hardTimer = setTimeout(() => finish('timeout'), Math.max(1, deadlineAt - Date.now()))
    hardTimer.unref?.()
    request.end()
  })
}

function parseFrame(frame) {
  let id
  let type
  const dataLines = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') type = value
    else if (field === 'data') dataLines.push(value)
  }
  if (!dataLines.length) return undefined
  const raw = dataLines.join('\n')
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = { message: raw }
  }
  return {
    id: Number.isNaN(Number(id)) ? id : Number(id),
    type: type || payload.type || 'message',
    ...payload,
  }
}

/** Health is the one Creator route with no identity gate at all. */
export function health(config) {
  return requestJson({ path: '/api/creator/v1/health', method: 'GET' }, config)
}

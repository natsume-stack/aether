/**
 * Machine-checkable acceptance verdict over the Creator runtime event stream
 * (plan/N2 4.1 V2). This is the piece that turns "AI wrote a script" into
 * "AI knows whether the map actually loads".
 *
 * Event shapes come from `services/game-server/src/edit/debugger/debugger-server.ts:8-11`
 * and `edit/creator-preview-runtime.ts:8-19`:
 *   {type:'log',       side, level, message, at, id}
 *   {type:'exception', side, level, message, stack, at, id}
 *   {type:'clear',     side, at, id}
 *   {type:'status',    phase, running, message, at, id}
 */

const moduleNotFoundSignals = ['MODULE_NOT_FOUND', 'Cannot find module']

function textify(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Pull "file:line" style hints out of a structured stack so the model gets a location. */
function extractLocations(stack) {
  const text = textify(stack)
  const locations = new Set()
  for (const match of text.matchAll(/[\w./-]+\.js[^"',}\s]{0,40}/g)) locations.add(match[0])
  return [...locations].slice(0, 12)
}

export function judgeEvents(events, options = {}) {
  const sinceId = options.sinceId
  const scoped =
    typeof sinceId === 'number' && Number.isFinite(sinceId)
      ? events.filter((event) => !(typeof event.id === 'number' && event.id <= sinceId))
      : events
  const exceptions = scoped.filter((event) => event.type === 'exception')
  const moduleFailures = scoped.filter((event) => {
    const haystack = `${textify(event.message)} ${textify(event.stack)}`
    return moduleNotFoundSignals.some((signal) => haystack.includes(signal))
  })

  if (!scoped.length) {
    return {
      verdict: 'NO_EVENTS',
      passed: false,
      checked: 0,
      exceptions: [],
      moduleFailures: [],
      findings: [
        {
          severity: 'error',
          code: 'NO_RUNTIME_EVENTS',
          message:
            '窗口内一条运行期事件都没有。这不是"通过"：要么预览运行时没在跑，要么脚本从未被加载。' +
            '先用 runtime_status 确认 running=true，再考虑 runtime_events_tail 的 sinceEventId 起点。',
        },
      ],
    }
  }

  // A window that only contains `status` frames proves the subscription
  // connected and nothing else: it is not evidence that the script loaded.
  const substantive = scoped.filter((event) => event.type !== 'status')
  if (!substantive.length) {
    return {
      verdict: 'NO_EVENTS',
      passed: false,
      checked: scoped.length,
      exceptions: [],
      moduleFailures: [],
      findings: [
        {
          severity: 'error',
          code: 'NO_RUNTIME_EVIDENCE',
          message:
            `窗口里只有 ${scoped.length} 条 status 帧，没有任何 log/exception。这不是"通过"：` +
            '要么预览刚启动还没跑脚本，要么 sinceEventId 起点跳过了真实日志。' +
            '正确顺序是 preview 起来 -> 触发脚本加载 -> 再取事件尾。',
        },
      ],
    }
  }

  const findings = exceptions.map((event) => ({
    severity: 'error',
    code: 'RUNTIME_EXCEPTION',
    eventId: event.id,
    side: event.side,
    message: event.message,
    locations: extractLocations(event.stack),
    stack: event.stack,
    at: event.at,
    hint:
      '把 message + locations 原样回喂模型修脚本；若 locations 指向别的 entry，说明是 require 图里的另一份脚本在炸。',
  }))
  for (const event of moduleFailures) {
    findings.push({
      severity: 'error',
      code: 'MODULE_NOT_FOUND',
      eventId: event.id,
      side: event.side,
      message: event.message,
      locations: extractLocations(event.stack),
      at: event.at,
      hint:
        '模块解析失败：确认被 require 的脚本已作为共享脚本存在（script_list 能看到），' +
        '注意 index.js / clientIndex.js 是 map-local、不进共享脚本表。',
    })
  }

  return {
    verdict: findings.length ? 'FAIL' : 'PASS',
    passed: !findings.length,
    checked: scoped.length,
    lastEventId: scoped[scoped.length - 1]?.id,
    exceptions,
    moduleFailures,
    findings,
  }
}

export function skippedBecauseRuntimeIdle(status) {
  const running = Boolean(status && (status.running || status.phase === 'ready'))
  if (running) return undefined
  return {
    verdict: 'SKIPPED_RUNTIME_NOT_RUNNING',
    passed: false,
    checked: 0,
    exceptions: [],
    moduleFailures: [],
    findings: [
      {
        severity: 'warning',
        code: 'RUNTIME_IDLE',
        message:
          `预览运行时未处于 running 状态（phase=${status && status.phase}），V2 验收回路无法取证。` +
          '本结果不等于通过；启动预览需要 runtime.control，切片 A 未暴露该工具。',
      },
    ],
  }
}

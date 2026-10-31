/** Uniform in-band error contract: {code, retryable, hint, message, status?, detail?}. */
export function errorPayload(error, extra = {}) {
  const raw = error || {};
  const code = raw.code || 'AGENT_ERROR';
  const retryable =
    raw.retryable ??
    ['EDITOR_TIMEOUT', 'EDITOR_NOT_ATTACHED', 'EDITOR_STALE', 'ENGINE_UNREACHABLE', 'NETWORK_ERROR'].includes(code);
  return {
    code,
    message: raw.message || String(error),
    retryable,
    hint: raw.hint || defaultHint(code),
    ...(raw.status === undefined ? {} : { status: raw.status }),
    ...(extra.problems ? { problems: extra.problems } : {}),
  };
}

function defaultHint(code) {
  switch (code) {
    case 'JOIN_CODE_REQUIRED':
      return '打开编辑器 Agent 面板，复制 MCP 配置（含识别码）后重启客户端';
    case 'PROJECT_REQUIRED':
      return '填 BOX_MAP_PROJECT（面板配置里已有），或调用时传 projectId';
    case 'EDITOR_NOT_ATTACHED':
      return '先让人打开地图/VOXA 并保持标签页可见，再 status/observe';
    case 'EDITOR_TIMEOUT':
      return '先 observe 确认这一步是否已生效，再决定是否重试；不要盲目重放写操作';
    case 'WRITE_DISABLED':
      return '本实例是只读模式；去掉 BOX_AGENT_ALLOW_WRITE=0 或换 authoring 实例';
    default:
      return '按错误信息修正参数或环境；如果是识别码问题，重新从面板复制配置';
  }
}

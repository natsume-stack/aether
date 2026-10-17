import { randomUUID } from 'node:crypto';

const SESSION_TTL_MS = 15 * 60_000;
const REQUEST_TTL_MS = 25_000;
const MAX_CAPTURE_BYTES = 6 * 1024 * 1024;

export type CreatorSceneCaptureView = 'full' | '3d' | '2d';

type CaptureRequest = {
  id: string;
  view: CreatorSceneCaptureView;
  resolve: (value: { content: Buffer; contentType: 'image/png' }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SceneSession = {
  id: string;
  ownerSubjectId: string;
  expiresAt: number;
  capture?: CaptureRequest;
  socketToken?: string;
  originHost?: string;
  push?: (action: NonNullable<ReturnType<typeof nextCreatorSceneAction>>) => void;
  closeSocket?: () => void;
};

// Next API routes and development reloads must share the same session registry.
const registry = globalThis as typeof globalThis & { __boxCreatorSceneSessions?: Map<string, SceneSession> };
const sessions = registry.__boxCreatorSceneSessions ||= new Map<string, SceneSession>();

function rejectCapture(session: SceneSession, error: Error) {
  if (!session.capture) return;
  clearTimeout(session.capture.timer);
  session.capture.reject(error);
  session.capture = undefined;
}

function activeSession(projectId: string) {
  const session = sessions.get(projectId);
  if (session && session.expiresAt <= Date.now()) {
    rejectCapture(session, new Error('编辑场景控制会话已过期'));
    sessions.delete(projectId);
    session.closeSocket?.();
    return undefined;
  }
  return session;
}

export function enableCreatorSceneSession(projectId: string, ownerSubjectId: string, originHost?: string) {
  const previous = sessions.get(projectId);
  if (previous) {
    rejectCapture(previous, new Error('编辑场景控制会话已被替换'));
    previous.closeSocket?.();
  }
  const session: SceneSession = { id: randomUUID(), ownerSubjectId, expiresAt: Date.now() + SESSION_TTL_MS,
    socketToken: randomUUID(), originHost };
  sessions.set(projectId, session);
  return { sessionId: session.id, socketToken: session.socketToken, expiresAt: new Date(session.expiresAt).toISOString() };
}

export function disableCreatorSceneSession(projectId: string, sessionId: string, ownerSubjectId: string) {
  const session = activeSession(projectId);
  if (!session || session.id !== sessionId || session.ownerSubjectId !== ownerSubjectId) return false;
  rejectCapture(session, new Error('编辑场景控制会话已关闭'));
  sessions.delete(projectId);
  session.closeSocket?.();
  return true;
}

/** A one-use credential issued by the authenticated HTTP bootstrap; never put it in a URL. */
export function attachCreatorSceneSocket(projectId: string, sessionId: string, socketToken: string,
  originHost: string, push: NonNullable<SceneSession['push']>, closeSocket: () => void) {
  const session = activeSession(projectId);
  if (!session || session.id !== sessionId || !session.socketToken || session.socketToken !== socketToken ||
    !session.originHost || session.originHost !== originHost) throw new Error('编辑场景控制连接未授权');
  session.socketToken = undefined;
  session.push = push;
  session.closeSocket = closeSocket;
  const expiry = setTimeout(() => disableCreatorSceneSession(projectId, sessionId, session.ownerSubjectId),
    Math.max(0, session.expiresAt - Date.now()));
  expiry.unref?.();
  if (session.capture) push({ id: session.capture.id, type: 'capture', view: session.capture.view });
  return {
    complete: (requestId: string, contentBase64: string) =>
      completeCreatorSceneCapture(projectId, sessionId, requestId, session.ownerSubjectId, contentBase64),
    fail: (requestId: string) => {
      if (activeSession(projectId) === session && session.capture?.id === requestId) {
        rejectCapture(session, new Error('编辑器截图失败，请确认当前场景已准备好'));
      }
    },
    detach: () => {
      clearTimeout(expiry);
      disableCreatorSceneSession(projectId, sessionId, session.ownerSubjectId);
    },
  };
}

export function creatorSceneSessionStatus(projectId: string, sessionId: string, ownerSubjectId: string) {
  const session = activeSession(projectId);
  return Boolean(session && session.id === sessionId && session.ownerSubjectId === ownerSubjectId);
}

export function nextCreatorSceneAction(projectId: string, sessionId: string, ownerSubjectId: string) {
  const session = activeSession(projectId);
  if (!session || session.id !== sessionId || session.ownerSubjectId !== ownerSubjectId) throw new Error('编辑场景控制会话不可用');
  if (!session.capture) return null;
  return { id: session.capture.id, type: 'capture' as const, view: session.capture.view };
}

export function requestCreatorSceneCapture(projectId: string, view: CreatorSceneCaptureView = 'full') {
  const session = activeSession(projectId);
  if (!session) throw Object.assign(new Error('地图当前没有已授权的编辑场景控制会话'), { statusCode: 409 });
  if (session.capture) throw Object.assign(new Error('已有截图请求正在等待编辑器响应'), { statusCode: 409 });
  return new Promise<{ content: Buffer; contentType: 'image/png' }>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (session.capture?.id === id) session.capture = undefined;
      reject(Object.assign(new Error('等待编辑器截图超时，请确认地图已打开且已允许 CLI 场景控制'), { statusCode: 504 }));
    }, REQUEST_TTL_MS);
    session.capture = { id, view, resolve, reject, timer };
    try { session.push?.({ id, type: 'capture', view }); }
    catch { rejectCapture(session, new Error('编辑场景控制连接不可用')); }
  });
}

export function completeCreatorSceneCapture(
  projectId: string,
  sessionId: string,
  requestId: string,
  ownerSubjectId: string,
  contentBase64: string,
) {
  const session = activeSession(projectId);
  if (!session || session.id !== sessionId || session.ownerSubjectId !== ownerSubjectId || session.capture?.id !== requestId) {
    throw new Error('截图请求已失效');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new Error('截图编码无效');
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (!content.length || content.length > MAX_CAPTURE_BYTES || content.toString('base64') !== contentBase64) {
    throw new Error('截图内容无效或超过 6 MiB 限制');
  }
  clearTimeout(session.capture.timer);
  const request = session.capture;
  session.capture = undefined;
  request.resolve({ content, contentType: 'image/png' });
}

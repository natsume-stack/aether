import { describe, expect, test } from '@jest/globals';
import {
  completeCreatorSceneCapture,
  creatorSceneSessionStatus,
  disableCreatorSceneSession,
  enableCreatorSceneSession,
  nextCreatorSceneAction,
  requestCreatorSceneCapture,
} from './creator-scene-session';

const owner = '0123456789abcdef0123456789abcdef';
const anotherOwner = 'fedcba9876543210fedcba9876543210';

describe('Creator scene session', () => {
  test('binds browser actions to the creator who opened the session', () => {
    const projectId = 'scene-owner-test';
    const session = enableCreatorSceneSession(projectId, owner);

    expect(creatorSceneSessionStatus(projectId, session.sessionId, owner)).toBe(true);
    expect(creatorSceneSessionStatus(projectId, session.sessionId, anotherOwner)).toBe(false);
    expect(() => nextCreatorSceneAction(projectId, session.sessionId, anotherOwner)).toThrow('不可用');
    expect(disableCreatorSceneSession(projectId, session.sessionId, anotherOwner)).toBe(false);
    expect(disableCreatorSceneSession(projectId, session.sessionId, owner)).toBe(true);
  });

  test('returns only a valid PNG payload for the pending capture', async () => {
    const projectId = 'scene-capture-test';
    const session = enableCreatorSceneSession(projectId, owner);
    const pending = requestCreatorSceneCapture(projectId);
    const action = nextCreatorSceneAction(projectId, session.sessionId, owner);
    expect(action?.type).toBe('capture');
    expect(action?.view).toBe('full');

    expect(() => completeCreatorSceneCapture(projectId, session.sessionId, action!.id, owner, 'not base64!')).toThrow('编码无效');
    const payload = Buffer.from('png-smoke').toString('base64');
    completeCreatorSceneCapture(projectId, session.sessionId, action!.id, owner, payload);

    await expect(pending).resolves.toEqual({
      content: Buffer.from('png-smoke'),
      contentType: 'image/png',
    });
    expect(disableCreatorSceneSession(projectId, session.sessionId, owner)).toBe(true);
  });
});

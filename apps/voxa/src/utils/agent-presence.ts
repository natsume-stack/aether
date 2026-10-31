import { useSyncExternalStore } from 'react';

/**
 * VOXA-side presence for the live agent.
 *
 * Same design as the map editor's `presence.ts`: a tiny external store updated
 * at animation frequency, consumed by thin overlays. The native voxel pointer
 * is the cursor, so this only carries the narration and the camera intent.
 */

export type VoxaAgentActionStatus = 'running' | 'done' | 'error';

export type VoxaAgentPresence = {
  phase: 'idle' | 'connecting' | 'attached' | 'error' | 'detached';
  sessionId?: string;
  agentName?: string;
  error?: string;
  note?: string;
  action?: {
    kind: string;
    label: string;
    status: VoxaAgentActionStatus;
    detail?: string;
    operationId?: string;
    at: number;
  };
  /** Human-readable camera intent, so the panel can show what the AI is framing. */
  lookTarget?: [number, number, number];
  updatedAt: number;
};

const initialState: VoxaAgentPresence = { phase: 'idle', updatedAt: 0 };

let state: VoxaAgentPresence = initialState;
const listeners = new Set<() => void>();

export function getVoxaAgentPresence(): VoxaAgentPresence {
  return state;
}

export function subscribeVoxaAgentPresence(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setVoxaAgentPresence(
  patch: Partial<VoxaAgentPresence> | ((current: VoxaAgentPresence) => VoxaAgentPresence),
) {
  const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
  next.updatedAt = Date.now();
  state = next;
  for (const listener of listeners) listener();
}

export function resetVoxaAgentPresence() {
  setVoxaAgentPresence(initialState);
}

export function useVoxaAgentPresence(): VoxaAgentPresence {
  return useSyncExternalStore(
    subscribeVoxaAgentPresence,
    getVoxaAgentPresence,
    getVoxaAgentPresence,
  );
}

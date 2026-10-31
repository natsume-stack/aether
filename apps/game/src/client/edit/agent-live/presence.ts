import { useSyncExternalStore } from 'react';

/**
 * Editor-side presence for the live agent. This is deliberately a tiny external
 * store instead of Redux: it updates at animation frequency, and every consumer
 * is a thin overlay that should not re-render the editor tree.
 */

export type AgentCursor = {
  /** Voxel cell the agent is pointing at. */
  voxel: [number, number, number];
  /** Face normal returned by the last raycast, when known. */
  face?: [number, number, number];
  /** Block id at the cell (0 = air). */
  block?: number;
  blockName?: string;
  visible: boolean;
};

export type AgentPresencePhase = 'idle' | 'connecting' | 'attached' | 'error' | 'detached';

export type AgentPresenceState = {
  phase: AgentPresencePhase;
  sessionId?: string;
  agentName?: string;
  error?: string;
  note?: string;
  cursor?: AgentCursor;
  lookTarget?: [number, number, number];
  action?: {
    kind: string;
    label: string;
    status: 'running' | 'done' | 'error';
    detail?: string;
    operationId?: string;
    at: number;
  };
  updatedAt: number;
};

const initialState: AgentPresenceState = {
  phase: 'idle',
  updatedAt: 0,
};

let state: AgentPresenceState = initialState;
const listeners = new Set<() => void>();

export function getAgentPresence(): AgentPresenceState {
  return state;
}

export function subscribeAgentPresence(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAgentPresence(
  patch: Partial<AgentPresenceState> | ((current: AgentPresenceState) => AgentPresenceState),
) {
  const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
  next.updatedAt = Date.now();
  state = next;
  for (const listener of listeners) listener();
}

export function resetAgentPresence() {
  setAgentPresence(initialState);
}

export function useAgentPresence(): AgentPresenceState {
  return useSyncExternalStore(subscribeAgentPresence, getAgentPresence, getAgentPresence);
}

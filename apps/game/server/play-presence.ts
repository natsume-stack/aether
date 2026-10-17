const PRESENCE_TTL_MS = 75_000

const registry = globalThis as typeof globalThis & { __boxPresence?: {
  legacy: Map<string, Map<string, number>>;
  connections: Map<string, Map<string, Set<string>>>;
  listeners: Set<() => void>;
  expiry?: ReturnType<typeof setTimeout>;
} };
const state: NonNullable<typeof registry.__boxPresence> = registry.__boxPresence ||= { legacy: new Map(), connections: new Map(), listeners: new Set() };
const presenceByMap = state.legacy;
function notify() { for (const listener of [...state.listeners]) listener(); }
export function onPlayPresenceChange(listener: () => void) {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}
export function connectPlayPresence(mapId: string, playerId: string, connectionId: string) {
  const players = state.connections.get(mapId) || new Map<string, Set<string>>();
  const connections = players.get(playerId) || new Set<string>();
  connections.add(connectionId); players.set(playerId, connections); state.connections.set(mapId, players); notify();
  return () => {
    connections.delete(connectionId);
    if (!connections.size) players.delete(playerId);
    if (!players.size) state.connections.delete(mapId);
    notify();
  };
}
function scheduleExpiry() {
  if (state.expiry) return;
  state.expiry = setTimeout(() => { state.expiry = undefined; clearExpired(); if (presenceByMap.size) scheduleExpiry(); }, PRESENCE_TTL_MS);
  state.expiry.unref?.();
}

function clearExpired(now = Date.now()) {
  let changed = false
  for (const [mapId, players] of presenceByMap) {
    for (const [playerId, expiresAt] of players) {
      if (expiresAt <= now) { players.delete(playerId); changed = true }
    }
    if (!players.size) presenceByMap.delete(mapId)
  }
  if (changed) notify()
}

export function touchPlayPresence(mapId: string, playerId: string) {
  clearExpired()
  const players = presenceByMap.get(mapId) || new Map<string, number>()
  players.set(playerId, Date.now() + PRESENCE_TTL_MS)
  presenceByMap.set(mapId, players)
  scheduleExpiry(); notify()
}

export function removePlayPresence(mapId: string, playerId: string) {
  const players = presenceByMap.get(mapId)
  if (!players) return
  players.delete(playerId)
  if (!players.size) presenceByMap.delete(mapId)
  notify()
}

export function getPlayPresenceCounts(
  mapIds: string[],
  groupByMap: Record<string, string> = {},
) {
  clearExpired()
  const requestedGroups = new Map(mapIds.map((mapId) => [mapId, groupByMap[mapId] || mapId]))
  const requestedGroupIds = new Set(requestedGroups.values())
  const playersByGroup = new Map<string, Set<string>>()
  for (const [mapId, players] of presenceByMap) {
    const groupId = groupByMap[mapId] || mapId
    if (!requestedGroupIds.has(groupId)) continue
    const groupPlayers = playersByGroup.get(groupId) || new Set<string>()
    for (const playerId of players.keys()) groupPlayers.add(playerId)
    playersByGroup.set(groupId, groupPlayers)
  }
  for (const [mapId, players] of state.connections) {
    const groupId = groupByMap[mapId] || mapId;
    if (!requestedGroupIds.has(groupId)) continue;
    const groupPlayers = playersByGroup.get(groupId) || new Set<string>();
    for (const playerId of players.keys()) groupPlayers.add(playerId);
    playersByGroup.set(groupId, groupPlayers);
  }
  return Object.fromEntries(
    mapIds.map((mapId) => [
      mapId,
      { onlineCount: playersByGroup.get(requestedGroups.get(mapId) || mapId)?.size || 0 },
    ]),
  )
}

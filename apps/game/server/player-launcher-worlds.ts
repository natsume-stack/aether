import { getPlayWorlds, type PlayWorld } from './play-worlds'

/** Public launcher discovery returns enabled top-level maps; submaps stay in their parent package. */
export function getPlayerLauncherWorlds(): PlayWorld[] {
  return getPlayWorlds().filter((world) => world.playEnabled && world.mapRole !== 'submap')
}

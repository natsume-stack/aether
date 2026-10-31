import type { components } from '@box/apis';
import type { PlayWorld } from '../../types';

type LibraryEntry = components['schemas']['PlayerMapLibraryEntry'];

/** Play's webpage library uses public access IDs, not permanent cache IDs. */
export function mapLibraryCollections(worlds:PlayWorld[], entries:LibraryEntry[]) {
    const worldById = new Map(worlds.map((world) => [world.publicId || world.id, world]));
    const recent = entries
        .filter((entry) => entry.lastPlayedAt && Number.isFinite(Date.parse(entry.lastPlayedAt)))
        .sort((left, right) => Date.parse(right.lastPlayedAt!) - Date.parse(left.lastPlayedAt!));
    return {
        favoriteMapIds: entries.filter((entry) => entry.favorite).map((entry) => entry.mapId),
        recentWorlds: recent.flatMap((entry) => {
            const world = worldById.get(entry.mapId);
            return world ? [world] : [];
        }),
    };
}

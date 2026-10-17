import type { PlayMap, PlayMapResourceStatus, PlayMapTableRow } from '../../player-admin-types';

export type PlayMapGroup = {
    id:string;
    main:PlayMap;
    submaps:PlayMap[];
};

/**
 * Normalizes a flat library response into the map-group hierarchy used by the
 * management table. A malformed group still remains manageable: its first
 * member is used as the visible root instead of silently dropping the map.
 */
export function groupPlayMaps(worlds:readonly PlayMap[]):PlayMapGroup[] {
    const grouped = new Map<string, PlayMap[]>();
    for (const world of worlds) {
        const id = world.mapGroupId || world.mainProjectId || world.id;
        grouped.set(id, [...(grouped.get(id) || []), world]);
    }
    return [...grouped.entries()].map(([id, members]) => {
        const main =
            members.find((item) => item.id === members[0].mainProjectId) ||
            members.find((item) => item.mapRole === 'main') ||
            members[0];
        return { id, main, submaps: members.filter((item) => item.id !== main.id) };
    });
}

export function buildPlayMapTableRows(
    groups:readonly PlayMapGroup[],
    statuses:Readonly<Record<string, PlayMapResourceStatus>>,
):PlayMapTableRow[] {
    return groups.map(({ id, main, submaps }) => ({
        key: id,
        kind: 'group',
        map: main,
        mapCount: 1 + submaps.length,
        resourceBytes: [main, ...submaps].reduce(
            (total, item) => total + (statuses[item.id]?.bytes || 0),
            0,
        ),
        ...(submaps.length
            ? { children: submaps.map((map) => ({ key: map.id, kind: 'submap' as const, map })) }
            : {}),
    }));
}

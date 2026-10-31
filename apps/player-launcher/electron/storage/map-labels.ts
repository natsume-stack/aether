import * as fs from 'node:fs';
import * as path from 'node:path';

type MapNames = Record<string, { name:string }>;
interface ServerLabels {
    maps:MapNames;
    [legacyField:string]:unknown;
}

const validMapId = (value:unknown):value is string =>
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
const safeName = (value:unknown):string =>
    typeof value === 'string'
        ? value
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 80)
        : '';

/** Cache display names only. Favorites/recent play are managed by Play's player library. */
export function createMapLabels(filename:string) {
    const labels:Record<string, ServerLabels> = Object.create(null);
    let legacyFields:Record<string, unknown> = {};
    try {
        const stored = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, unknown>;
        const versioned =
            stored.version === 2 && stored.servers && typeof stored.servers === 'object';
        const servers = (versioned ? stored.servers : stored) as Record<string, unknown>;
        if (versioned) {
            const { servers: _servers, ...fields } = stored;
            legacyFields = fields;
        }
        for (const [serverId, value] of Object.entries(servers)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                continue;
            }
            const entry = value as Record<string, unknown>;
            const maps:MapNames = Object.create(null);
            const source = entry.maps && typeof entry.maps === 'object' ? entry.maps : entry;
            for (const [mapId, record] of Object.entries(source)) {
                if (!validMapId(mapId)) {
                    continue;
                }
                const name = safeName(typeof record === 'string' ? record : record?.name);
                if (name) {
                    maps[mapId] = { name };
                }
            }
            // Preserve legacy local preferences on disk, without using them as player data
            // or importing them into an account whose ownership cannot be established.
            labels[serverId] = { ...(entry.maps ? entry : {}), maps };
        }
    } catch {
        /* A public-name index is optional and older caches may not have one. */
    }

    function persist():void {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(
            filename,
            JSON.stringify({ ...legacyFields, version: 2, servers: labels }),
            {
                mode: 0o600,
            },
        );
    }

    return {
        remember(serverId:string, worlds:Array<{ permanentMapId?:string; name?:string }>):void {
            const maps = labels[serverId]?.maps || Object.create(null);
            for (const world of worlds.slice(0, 1000)) {
                if (!world || !validMapId(world.permanentMapId)) {
                    continue;
                }
                const name = safeName(world.name);
                if (name) {
                    maps[world.permanentMapId] = { name };
                }
            }
            labels[serverId] = { ...labels[serverId], maps };
            persist();
        },
        forget(serverId:string):void {
            delete labels[serverId];
            try {
                persist();
            } catch {
                /* Cache names must not prevent server removal. */
            }
        },
        name(serverId:string, mapId:string):string {
            return labels[serverId]?.maps[mapId]?.name || `地图 ${mapId}`;
        },
    };
}

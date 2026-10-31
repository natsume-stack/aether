import { promises as fs } from 'fs'
import path from 'path'
import { ApiClient } from '@box/apis'

/** Shared source for container management and map authorizations. */
export type AdminMapReference = {
  /** Engineering/library directory ID, used by runtime control. */
  id: string
  /** Immutable map identity, used by permissions and player-facing references. */
  permanentMapId: string
  name: string
  version?: string
  publicId?: string
  description?: string
  permanentMapGroupId?: string
  mapGroupId?: string
  mapRole?: 'main' | 'submap'
  mainProjectId?: string
}
const mapIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/

function creatorProjectsPath() {
  return (
    process.env.BOX_CREATOR_PROJECTS_PATH || path.resolve(process.cwd(), '../local-engine/projects')
  )
}

async function creatorMaps(): Promise<AdminMapReference[]> {
  try {
    const entries = await fs.readdir(creatorProjectsPath(), { withFileTypes: true })
    const maps = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && mapIdPattern.test(entry.name))
        .map(async (entry): Promise<AdminMapReference | null> => {
          try {
            const project = JSON.parse(
              await fs.readFile(
                path.join(creatorProjectsPath(), entry.name, 'project.json'),
                'utf8',
              ),
            )
            return {
              id: entry.name,
              permanentMapId: String(project.permanentMapId || entry.name),
              name: String(project.name || entry.name),
              version: String(project.version || ''),
              description: String(project.description || ''),
              permanentMapGroupId: project.permanentMapGroupId,
              mapGroupId: project.mapGroupId,
              mapRole: project.mapRole === 'submap' ? 'submap' : 'main',
              mainProjectId: String(project.mainProjectId || entry.name),
            }
          } catch {
            return null
          }
        }),
    )
    return maps.filter((map): map is AdminMapReference => map !== null)
  } catch {
    return []
  }
}

async function playMaps() {
  const token = String(process.env.BOX_PLAY_ADMIN_TOKEN || '').trim()
  if (!token) return []
  try {
    const result = (await new ApiClient({
      baseUrl: String(
        process.env.BOX_PLAY_INTERNAL_URL || process.env.BOX_PLAY_PUBLIC_URL || '',
      ).replace(/\/$/, ''),
      headers: { Authorization: `Bearer ${token}` },
      defaultErrorMessage: '读取游玩地图失败',
    }).getApiPlayAdminWorlds({ signal: AbortSignal.timeout(5000) })) as {
      worlds: AdminMapReference[]
    }
    return Array.isArray(result.worlds) ? result.worlds : []
  } catch {
    return []
  }
}

/** Missing/offline catalogs return no entries; callers retain their stored metadata. */
export async function readAdminMapCatalog(mode: 'creator' | 'play'): Promise<AdminMapReference[]> {
  return mode === 'creator' ? creatorMaps() : playMaps()
}

/** Resolve directory relationships to immutable group identities for authorizations. */
export function adminAuthorizationMaps(maps: readonly AdminMapReference[], mode: 'edit' | 'play') {
  return maps.flatMap(map => {
    const main = maps.find(candidate => candidate.id === (map.mainProjectId || map.mapGroupId))
    const groupId = map.permanentMapGroupId || main?.permanentMapId ||
      (map.mapRole !== 'submap' ? map.permanentMapId : undefined)
    if (!groupId) return []
    return [{ mapId: map.permanentMapId, groupId, name: map.name,
      projectId: map.permanentMapId, publicId: map.publicId || '',
      description: map.description || '', version: map.version || '', mode }]
  })
}

import { expect, test } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { readAdminMapCatalog, adminAuthorizationMaps } from './admin-map-catalog'

test('creator catalog preserves names, immutable IDs and parent relationships while skipping damaged projects', async () => {
  const projects = await mkdtemp(path.join(os.tmpdir(), 'admin-map-catalog-'))
  const original = process.env.BOX_CREATOR_PROJECTS_PATH
  process.env.BOX_CREATOR_PROJECTS_PATH = projects
  try {
    for (const [directory, project] of [
      ['main-project', { name: '星梦小镇', permanentMapId: 'cd01b25f83bfcecde0bf' }],
      [
        'sub-project',
        {
          name: '副地图',
          permanentMapId: 'sub-map',
          mapRole: 'submap',
          mainProjectId: 'main-project',
        },
      ],
    ] as const) {
      await mkdir(path.join(projects, directory))
      await writeFile(path.join(projects, directory, 'project.json'), JSON.stringify(project))
    }
    await mkdir(path.join(projects, 'damaged-project'))
    await writeFile(path.join(projects, 'damaged-project', 'project.json'), '{')
    const maps = await readAdminMapCatalog('creator')
    expect(maps).toHaveLength(2)
    expect(maps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'main-project',
          name: '星梦小镇',
          permanentMapId: 'cd01b25f83bfcecde0bf',
          mapRole: 'main',
        }),
        expect.objectContaining({
          id: 'sub-project',
          permanentMapId: 'sub-map',
          mapRole: 'submap',
          mainProjectId: 'main-project',
        }),
      ]),
    )
    process.env.BOX_CREATOR_PROJECTS_PATH = path.join(projects, 'missing')
    await expect(readAdminMapCatalog('creator')).resolves.toEqual([])
  } finally {
    if (original === undefined) delete process.env.BOX_CREATOR_PROJECTS_PATH
    else process.env.BOX_CREATOR_PROJECTS_PATH = original
    await rm(projects, { recursive: true, force: true })
  }
})

test('authorization catalogs resolve main and submap directory references to immutable group IDs on both ends', () => {
  const maps = [
    { id: 'export-main', permanentMapId: '11111111111111111111', name: '地图组', mapRole: 'main' as const, mainProjectId: 'export-main' },
    { id: 'export-sub', permanentMapId: '22222222222222222222', name: '副地图', mapRole: 'submap' as const, mainProjectId: 'export-main' },
  ]
  for (const mode of ['edit', 'play'] as const) {
    expect(adminAuthorizationMaps(maps, mode)).toEqual(expect.arrayContaining([
      expect.objectContaining({mapId:'11111111111111111111',groupId:'11111111111111111111',mode}),
      expect.objectContaining({mapId:'22222222222222222222',groupId:'11111111111111111111',mode}),
    ]))
  }
})

import { subscribeRealtime } from '@box/realtime-client'
import type { GetServerSideProps } from 'next'
import { apiOperations } from '@box/apis'
import Head from 'next/head'
import Link from 'next/link'
import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IntlProvider, useIntl } from 'react-intl'
import zhMessages from '../i18n/zh.json'
import {
  AlertTriangle,
  ArrowUpRight,
  Box,
  FileCode2,
  Image as ImageIcon,
  LogOut,
  Music2,
  Settings,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import {
  PlayerAccount,
  type PlayerProfileChanges,
} from '../components/player-account/player-account'
import type { PlayWorld } from '../server/play-worlds'
import { getPlayWorlds } from '../server/play-worlds'
import { getPlayPresenceCounts } from '../server/play-presence'
import { getPublicPlaySiteConfig } from '../server/play-site-config'
import {
  filterGroupsByPlaySiteTab,
  hasPlaySiteHero,
  loadPlaySiteConfig,
  normalizePlaySiteConfig,
  type PlaySiteConfig,
} from '../components/play-home/site-config'
import { readPlayWorldMeta } from '../components/play-home/map-card-meta'
import { PlayBannerCarousel } from '../components/play-home/banner-carousel'
import {
  importResponseError,
  type DetailedImportError,
  type ImportDiagnostic,
} from '../server/import-diagnostics'
import { apiClient } from '../src/apis/client'

const TOKEN_KEY = 'box-play-admin-token'
const DEFAULT_MAP_COVER = '/map-templates/blank-template.png'

type MapDiscoveryStats = {
  onlineCount: number
}

type MapResourceStatus = {
  bytes: number
  importedAt: string
}

// 仅供 BOX_UI_PREVIEW 开发服务展示首页布局；生产路径不会使用这些数据。
const previewWorlds: PlayWorld[] = [
  {
    id: 'preview-arena', permanentMapId: '20000000000000000001', publicId: 'preview-arena', name: '竞技场：破晓行动', author: 'BOX3 Studio', description: '在立体竞技场中完成一场快速对战。', cover: '/map-templates/arena-template.png', version: 'v1.2.0', mapGroupId: 'preview-arena', mapRole: 'main', mainProjectId: 'preview-arena', playEnabled: true,
  },
  {
    id: 'preview-race', permanentMapId: '20000000000000000002', publicId: 'preview-race', name: '极速赛道', author: 'BOX3 Studio', description: '穿过弯道与加速带，第一个冲过终点。', cover: '/map-templates/raceway-template.png', version: 'v1.0.4', mapGroupId: 'preview-race', mapRole: 'main', mainProjectId: 'preview-race', playEnabled: true,
  },
  {
    id: 'preview-explore', permanentMapId: '20000000000000000003', publicId: 'preview-explore', name: '空岛探索', author: 'BOX3 Studio', description: '从一座空岛开始，探索属于你的世界。', cover: '/map-templates/blank-template.png', version: 'v1.0.0', mapGroupId: 'preview-explore', mapRole: 'main', mainProjectId: 'preview-explore', playEnabled: true,
  },
  {
    id: 'preview-build', permanentMapId: '20000000000000000004', publicId: 'preview-build', name: '方块工坊', author: 'BOX3 Studio', description: '自由搭建、分享与协作的创造空间。', cover: '/map-templates/blank-template.png', version: 'v1.1.1', mapGroupId: 'preview-build', mapRole: 'main', mainProjectId: 'preview-build', playEnabled: true,
  },
  {
    id: 'preview-chase', permanentMapId: '20000000000000000005', publicId: 'preview-chase', name: '追逐时刻', author: 'BOX3 Studio', description: '一场考验反应与路线判断的限时挑战。', cover: '/map-templates/arena-template.png', version: 'v1.0.2', mapGroupId: 'preview-chase', mapRole: 'main', mainProjectId: 'preview-chase', playEnabled: true,
  },
]

const previewMapStats: Record<string, MapDiscoveryStats> = {
  'preview-arena': { onlineCount: 24 },
  'preview-race': { onlineCount: 12 },
  'preview-explore': { onlineCount: 8 },
  'preview-build': { onlineCount: 4 },
  'preview-chase': { onlineCount: 17 },
}

const previewResourceStatuses: Record<string, MapResourceStatus> = {
  'preview-arena': { bytes: 48 * 1024 * 1024, importedAt: '2026-08-27T08:30:00.000Z' },
  'preview-race': { bytes: 36 * 1024 * 1024, importedAt: '2026-08-26T04:15:00.000Z' },
  'preview-explore': { bytes: 22 * 1024 * 1024, importedAt: '2026-08-25T11:00:00.000Z' },
  'preview-build': { bytes: 31 * 1024 * 1024, importedAt: '2026-08-24T06:45:00.000Z' },
  'preview-chase': { bytes: 27 * 1024 * 1024, importedAt: '2026-08-23T02:20:00.000Z' },
}

// 仅供 BOX_UI_PREVIEW 开发服务预览改版后的首页壳层；生产路径只会用接口返回的配置。
const previewSiteConfig: PlaySiteConfig = {
  schema: 1,
  banner: {
    images: [
      { src: '/map-templates/arena-template.png', href: '/p/preview-arena', title: '竞技场：破晓行动 重磅来袭', subtitle: '在立体竞技场中完成一场快速对战' },
      { src: '/map-templates/raceway-template.png', href: '/p/preview-race', title: '极速赛道 现已开放', subtitle: '穿过弯道与加速带，第一个冲过终点' },
    ],
    heightPx: 320,
    autoplayMs: 6000,
  },
  announcement: { text: '本地部署演示站：地图由服主自行上传与维护', href: '' },
  tabs: [
    { key: 'all', label: '地图展厅', match: {} },
    { key: 'race', label: '潜力新作', match: { publicId: 'preview-race' } },
  ],
  footer: { text: 'BOX3 Engine 本地部署演示' },
}

type ImportProgress = {
  filename: string
  phase: 'uploading' | 'processing' | 'done' | 'error'
  percent: number
  sent: number
  total: number
  elapsedSeconds: number
  worldName?: string
  mapCount?: number
  message?: string
  details?: ImportDiagnostic[]
}

type PlayBundleReviewResource = {
  id: string
  worldId: string
  name: string
  kind: 'script' | 'image' | 'audio' | 'model' | 'other'
  scriptTarget?: 'server' | 'client'
  mimeType: string
  bytes: number
  previewable: boolean
}

type PlayBundleReview = {
  id: string
  expiresAt: string
  mapCount: number
  totalBytes: number
  blobCount: number
  unindexedBlobCount: number
  worlds: Array<{
    id: string
    name: string
    author: string
    description: string
    version: string
    mapRole: 'main' | 'submap'
    mainProjectId: string
  }>
  resources: PlayBundleReviewResource[]
  warnings: string[]
}

const reviewCategories = [
  { kind: 'script', label: 'playHome.reviewCode', icon: FileCode2 },
  { kind: 'image', label: 'playHome.reviewImages', icon: ImageIcon },
  { kind: 'audio', label: 'playHome.reviewAudio', icon: Music2 },
] as const

type ReviewCategory = (typeof reviewCategories)[number]['kind']
type ReviewScriptTarget = 'server' | 'client'

function isPlayEnabled(world: PlayWorld) {
  // 老游玩包的 manifest 没有该字段时，保持历史行为：默认允许进入。
  return world.playEnabled !== false
}

function formatBytes(value: number) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`
}

function formatImportedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

// 站级配置只影响 banner/公告/tab：SSR 读失败时给 null，首页照常出地图列表，
// 客户端还会再试一次 GET /api/play-site-config（见 components/play-home/site-config.ts）。
function readSiteConfigSafely(): unknown {
  try {
    return getPublicPlaySiteConfig()
  } catch {
    return null
  }
}

type HomePageProps = {
  worlds: PlayWorld[]
  uiPreview: boolean
  mapStats: Record<string, MapDiscoveryStats>
  /** 服务端读到的站级配置原始响应体；一律经 normalizePlaySiteConfig 过滤后才使用。 */
  siteConfig: unknown
}

export default function HomePage(props: HomePageProps) {
  return (
    <IntlProvider locale="zh-CN" messages={zhMessages}>
      <HomePageContent {...props} />
    </IntlProvider>
  )
}

function HomePageContent({
  worlds,
  uiPreview,
  mapStats,
  siteConfig: rawSiteConfig,
}: HomePageProps) {
  const intl = useIntl()
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values)
  const importInput = useRef<HTMLInputElement>(null)
  const [worldList, setWorldList] = useState(worlds)
  const [liveMapStats, setLiveMapStats] = useState(mapStats)
  const [resourceStatuses, setResourceStatuses] = useState<Record<string, MapResourceStatus>>({})
  const [adminToken, setAdminToken] = useState('')
  const [verified, setVerified] = useState(false)
  const [playerName, setPlayerName] = useState('')
  const [playerUsername, setPlayerUsername] = useState('')
  const [playerUserId, setPlayerUserId] = useState('')
  const [playerBoxId, setPlayerBoxId] = useState('')
  const [playerSkinId, setPlayerSkinId] = useState('explorer')
  const [previewSignedIn, setPreviewSignedIn] = useState(false)
  const [favoriteCount, setFavoriteCount] = useState(0)
  const [recentCount, setRecentCount] = useState(0)
  const [libraryEnabled, setLibraryEnabled] = useState(false)
  const [collectionView, setCollectionView] = useState<'all' | 'recent' | 'favorites'>('all')
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())
  const [recentIds, setRecentIds] = useState<string[]>([])
  const [loginOpen, setLoginOpen] = useState(false)
  const [deleteWorld, setDeleteWorld] = useState<PlayWorld | null>(null)
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [editWorld, setEditWorld] = useState<PlayWorld | null>(null)
  const [editPublicId, setEditPublicId] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  // 站级展示配置（banner / 公告 / 分区 tab）。null = 没有配置或读取失败，
  // 此时整页退回「无 banner、无 tab」的纯地图列表。
  // 首屏值来自 SSR（避免 banner 迟到把地图区往下顶），再过一次归一化。
  const [siteConfig, setSiteConfig] = useState<PlaySiteConfig | null>(() =>
    normalizePlaySiteConfig(rawSiteConfig),
  )
  const [activeTabKey, setActiveTabKey] = useState('')
  const [headerSolid, setHeaderSolid] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [bundleReview, setBundleReview] = useState<PlayBundleReview | null>(null)
  const [reviewFilename, setReviewFilename] = useState('')
  const [reviewWorldId, setReviewWorldId] = useState('')
  const [reviewCategory, setReviewCategory] = useState<ReviewCategory>('script')
  const [reviewScriptTarget, setReviewScriptTarget] = useState<ReviewScriptTarget>('server')
  const [selectedReviewResourceId, setSelectedReviewResourceId] = useState('')
  const [reviewResourceUrl, setReviewResourceUrl] = useState('')
  const [reviewText, setReviewText] = useState('')
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const worldGroups = useMemo(() => {
    const groups = new Map<string, PlayWorld[]>()
    for (const world of worldList) {
      const groupId = world.mapGroupId || world.mainProjectId || world.id
      const members = groups.get(groupId) || []
      members.push(world)
      groups.set(groupId, members)
    }
    return Array.from(groups, ([groupId, members]) => {
      const mainProjectId = members[0]?.mainProjectId || groupId
      const main =
        members.find((world) => world.id === mainProjectId) ||
        members.find((world) => world.mapRole === 'main') ||
        members[0]
      return {
        groupId,
        main,
        submaps: members.filter((world) => world.id !== main.id),
      }
    })
  }, [worldList])

  useEffect(() => {
    if (!bundleReview || !selectedReviewResourceId) {
      setReviewText('')
      setReviewResourceUrl('')
      setReviewError('')
      return
    }
    const resource = bundleReview.resources.find((item) => item.id === selectedReviewResourceId)
    setReviewText('')
    setReviewResourceUrl('')
    setReviewError('')
    if (!resource?.previewable) {
      setReviewLoading(false)
      return
    }
    const controller = new AbortController()
    let objectUrl = ''
    setReviewLoading(true)
    apiClient
      .getApiPlayAdminImportResourceRaw({
        params: {
          query: { reviewId: bundleReview.id, resourceId: resource.id },
        },
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: controller.signal,
      })
      .then(async ({ data, error, response }) => {
        if (!response.ok) {
          const details = error as { message?: string } | undefined
          throw new Error(details?.message || '资源预览加载失败')
        }
        if (resource.kind === 'script') {
          setReviewText(typeof data === 'string' ? data : '')
          return
        }
        if (!(data instanceof Blob)) throw new Error('资源预览响应格式无效')
        objectUrl = URL.createObjectURL(data)
        setReviewResourceUrl(objectUrl)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setReviewError(error instanceof Error ? error.message : '资源预览加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setReviewLoading(false)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [adminToken, bundleReview, selectedReviewResourceId])

  useEffect(() => {
    if (uiPreview) return
    const mapIds = worldList.map((world) => world.publicId).filter(Boolean)
    if (!mapIds.length) return
    return subscribeRealtime('play-presence', { body: { kind: 'presence-watch', maps: mapIds } }, event => {
      if (event.type === 'presence') setLiveMapStats(event.maps)
    })
  }, [uiPreview, worldList])

  useEffect(() => {
    if (!verified) {
      setResourceStatuses({})
      return
    }
    if (uiPreview) {
      setResourceStatuses(previewResourceStatuses)
      return
    }
    let cancelled = false
    apiClient
      .getApiPlayAdminWorldsStatus({ headers: { Authorization: `Bearer ${adminToken}` } })
      .then((data) => {
        const result = data as { worlds?: Array<{ id: string; bytes: number; importedAt: string }> }
        if (cancelled || !Array.isArray(result?.worlds)) return
        setResourceStatuses(
          Object.fromEntries(
            result.worlds.map((world) => [
              world.id,
              { bytes: world.bytes, importedAt: world.importedAt },
            ]),
          ),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [adminToken, uiPreview, verified])

  // 站级配置是纯装饰数据：SSR 没给到（老构建 / 服务端异常 / 非 play 模式）时，
  // 客户端再兜底一次 GET /api/play-site-config。404 / 非 JSON 一律保持 null，
  // 地图列表与进图链路完全不依赖它，也不允许因为它而变空。
  useEffect(() => {
    if (uiPreview || siteConfig) return
    const controller = new AbortController()
    let settled = false
    loadPlaySiteConfig(controller.signal)
      .then((config) => {
        if (!settled && config) setSiteConfig(config)
      })
      .catch(() => undefined)
    return () => {
      settled = true
      controller.abort()
    }
  }, [siteConfig, uiPreview])

  // hero 形态下顶栏是 sticky 浮层，压在 banner 之上；滚过 banner 后才填充实底色。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const sync = () => setHeaderSolid(window.scrollY > 8)
    sync()
    window.addEventListener('scroll', sync, { passive: true })
    return () => window.removeEventListener('scroll', sync)
  }, [])

  async function verifyToken(token: string, quiet = false) {
    try {
      await apiClient.postApiPlayAdminVerify({ headers: { Authorization: `Bearer ${token}` } })
    } catch (error) {
      if (!quiet) throw error
      return false
    }
    sessionStorage.setItem(TOKEN_KEY, token)
    setAdminToken(token)
    setVerified(true)
    setLoginOpen(false)
    return true
  }

  useEffect(() => {
    if (uiPreview) {
      setLibraryEnabled(true)
      return
    }
    apiClient
      .getApiPlayLibrary()
      .then((value) => {
        const data = value as Record<string, any>
        setPlayerName(data.player?.displayName || data.player?.username || '')
        setPlayerUsername(data.player?.username || '')
        setPlayerUserId(data.player?.userId || '')
        setPlayerBoxId(data.player?.boxId || '')
        const skinId = data.player?.avatarSkinId || 'explorer'
        setPlayerSkinId(skinId)
        setLibraryEnabled(data.libraryEnabled !== false)
        const entries = data.entries || []
        const favorites = entries.filter((entry: { favorite: boolean }) => entry.favorite)
        const recent = entries.filter(
          (entry: { lastPlayedAt: string | null }) => entry.lastPlayedAt,
        )
        setFavoriteCount(favorites.length)
        setRecentCount(recent.length)
        setFavoriteIds(new Set(favorites.map((entry: { mapId: string }) => entry.mapId)))
        setRecentIds(recent.map((entry: { mapId: string }) => entry.mapId))
      })
      .catch(() => undefined)
  }, [uiPreview])

  const updateLibrary = (mapId: string, changes: Record<string, boolean>) =>
    apiClient.patchApiPlayLibrary({ body: { mapId, ...changes } }).catch(() => undefined)
  const toggleFavorite = (mapId: string) => {
    const next = new Set(favoriteIds)
    next.has(mapId) ? next.delete(mapId) : next.add(mapId)
    setFavoriteIds(next)
    setFavoriteCount(next.size)
    void updateLibrary(mapId, { favorite: next.has(mapId) })
  }
  const recordRecent = (mapId: string) => {
    setRecentIds((current) => [mapId, ...current.filter((value) => value !== mapId)])
    void updateLibrary(mapId, { played: true })
  }
  // 关闭是面向玩家的下线状态：服主仍能在管理视图看到并重新开启，
  // 玩家首页、收藏和最近游玩中都不应暴露该地图组。
  const playableWorldGroups = worldGroups.filter(({ main }) => isPlayEnabled(main))
  const playerGroups =
    collectionView === 'favorites'
      ? playableWorldGroups.filter(({ main }) => favoriteIds.has(main.publicId))
      : collectionView === 'recent'
        ? [...playableWorldGroups]
            .sort((a, b) => recentIds.indexOf(a.main.publicId) - recentIds.indexOf(b.main.publicId))
            .filter(({ main }) => recentIds.includes(main.publicId))
        : playableWorldGroups
  const libraryGroups = playerGroups
  // 分区 tab 只来自站级配置；没有配置时 activeTab 为 null，
  // filterGroupsByPlaySiteTab 原样返回集合 —— 列表与改版前逐张一致。
  const siteTabs: PlaySiteConfig['tabs'] = siteConfig?.tabs?.length ? siteConfig.tabs : []
  const activeTab = siteTabs.find((tab) => tab.key === activeTabKey) || siteTabs[0] || null
  const visibleGroups = filterGroupsByPlaySiteTab(libraryGroups, activeTab)
  const heroEnabled = hasPlaySiteHero(siteConfig)
  const bannerImages = siteConfig?.banner?.images ?? []
  const bannerHeightPx = siteConfig?.banner?.heightPx ?? 320
  const bannerAutoplayMs = siteConfig?.banner?.autoplayMs ?? 6000
  const deleteTargets = deleteWorld
    ? deleteWorld.mapRole === 'main'
      ? worldList.filter(
          (world) =>
            (world.mapGroupId || world.mainProjectId || world.id) ===
            (deleteWorld.mapGroupId || deleteWorld.mainProjectId || deleteWorld.id),
        )
      : [deleteWorld]
    : []

  const previewSignIn = () => {
    setPreviewSignedIn(true)
    setPlayerName('测试玩家')
    setPlayerUsername('player-preview')
    setPlayerUserId('10001')
    setPlayerBoxId('')
    setLibraryEnabled(true)
  }

  const openAdminTools = () => {
    if (uiPreview) {
      setVerified(true)
      setLoginOpen(false)
      setNotice('')
      return
    }
    setLoginOpen(true)
  }

  async function importBundle(file: File) {
    if (importProgress && importProgress.phase !== 'done' && importProgress.phase !== 'error')
      return
    setBusy('import')
    setNotice('')
    const startedAt = Date.now()
    setImportProgress({
      filename: file.name,
      phase: 'uploading',
      percent: 0,
      sent: 0,
      total: file.size,
      elapsedSeconds: 0,
    })
    const timer = window.setInterval(() => {
      setImportProgress((current) => {
        if (!current || (current.phase !== 'uploading' && current.phase !== 'processing'))
          return current
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
        return {
          ...current,
          elapsedSeconds,
          percent:
            current.phase === 'processing'
              ? Math.min(95, Math.max(current.percent, 75 + elapsedSeconds * 2))
              : current.percent,
        }
      })
    }, 500)
    try {
      const data = await new Promise<{
        review?: PlayBundleReview
        message?: string
        details?: ImportDiagnostic[]
      }>((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('POST', `${apiOperations.postApiPlayAdminImport.path}?mode=preview`)
        request.setRequestHeader('Authorization', `Bearer ${adminToken}`)
        request.setRequestHeader('Content-Type', 'application/octet-stream')
        request.upload.onprogress = (event) => {
          const total = event.lengthComputable ? event.total : file.size
          setImportProgress((current) =>
            current
              ? {
                  ...current,
                  phase: 'uploading',
                  percent: total ? Math.min(70, (event.loaded / total) * 70) : 0,
                  sent: event.loaded,
                  total,
                  elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
                }
              : current,
          )
        }
        request.upload.onload = () => {
          setImportProgress((current) =>
            current
              ? {
                  ...current,
                  phase: 'processing',
                  percent: 75,
                  sent: file.size,
                  total: file.size,
                  elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
                }
              : current,
          )
        }
        request.onerror = () => reject(new Error('无法连接游玩端，游玩包上传失败'))
        request.onabort = () => reject(new Error('导入已取消'))
        request.onload = () => {
          let result: {
            review?: PlayBundleReview
            message?: string
            details?: ImportDiagnostic[]
          } = {}
          try {
            result = JSON.parse(request.responseText || '{}')
          } catch {
            /* handled below */
          }
          if (request.status >= 200 && request.status < 300) resolve(result)
          else reject(importResponseError(result, request.status, '导入游玩包失败'))
        }
        request.send(file)
      })
      if (!data.review) throw new Error('游玩包审查结果不完整')
      const initialWorld =
        data.review.worlds.find((world) => world.mapRole === 'main') || data.review.worlds[0]
      const initialWorldResources = data.review.resources.filter(
        (resource) => resource.worldId === initialWorld?.id,
      )
      const initialCategory = initialWorldResources.some((resource) => resource.kind === 'script')
        ? 'script'
        : initialWorldResources.some((resource) => resource.kind === 'image')
          ? 'image'
          : initialWorldResources.some((resource) => resource.kind === 'audio')
            ? 'audio'
            : 'script'
      setBundleReview(data.review)
      setReviewFilename(file.name)
      setReviewWorldId(initialWorld?.id || '')
      setReviewCategory(initialCategory)
      const initialScriptTarget: ReviewScriptTarget = initialWorldResources.some(
        (resource) => resource.kind === 'script' && resource.scriptTarget !== 'client',
      )
        ? 'server'
        : 'client'
      setReviewScriptTarget(initialScriptTarget)
      setSelectedReviewResourceId(
        initialWorldResources.find(
          (resource) =>
            resource.kind === initialCategory &&
            (initialCategory !== 'script' ||
              (resource.scriptTarget || 'server') === initialScriptTarget),
        )?.id || '',
      )
      setImportProgress(null)
    } catch (error) {
      setImportProgress((current) => ({
        filename: file.name,
        phase: 'error',
        percent: current?.percent || 0,
        sent: current?.sent || 0,
        total: current?.total || file.size,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        message: error instanceof Error ? error.message : '导入游玩包失败',
        details: (error as Partial<DetailedImportError>)?.details || [],
      }))
    } finally {
      window.clearInterval(timer)
      setBusy('')
    }
  }

  async function closeBundleReview() {
    const review = bundleReview
    setBundleReview(null)
    setSelectedReviewResourceId('')
    setReviewWorldId('')
    setReviewFilename('')
    if (!review || uiPreview) return
    await apiClient.deleteApiPlayAdminImport({
      params: { query: { reviewId: review.id } },
      headers: { Authorization: `Bearer ${adminToken}` },
    }).catch(() => undefined)
  }

  async function confirmBundleReview() {
    if (!bundleReview) return
    const review = bundleReview
    const startedAt = Date.now()
    setBusy('import-confirm')
    setBundleReview(null)
    setImportProgress({
      filename: reviewFilename,
      phase: 'processing',
      percent: 82,
      sent: review.totalBytes,
      total: review.totalBytes,
      elapsedSeconds: 0,
    })
    try {
      const result = await apiClient.postApiPlayAdminImportRaw({
        params: { query: { mode: 'confirm', reviewId: review.id } },
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      const data = (result.data || result.error || {}) as Record<string, any>
      if (!result.response.ok) {
        throw importResponseError(data, result.response.status, '导入游玩包失败')
      }
      const importedWorlds: PlayWorld[] = data.worlds?.length ? data.worlds : data.world ? [data.world] : []
      if (importedWorlds.length) {
        const importedIds = new Set(importedWorlds.map((world) => world.id))
        setWorldList((current) => [
          ...importedWorlds,
          ...current.filter((world) => !importedIds.has(world.id)),
        ])
      }
      setImportProgress({
        filename: reviewFilename,
        phase: 'done',
        percent: 100,
        sent: review.totalBytes,
        total: review.totalBytes,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        worldName: data.world?.name,
        mapCount: data.mapCount || importedWorlds.length || review.mapCount,
      })
    } catch (error) {
      setImportProgress({
        filename: reviewFilename,
        phase: 'error',
        percent: 82,
        sent: review.totalBytes,
        total: review.totalBytes,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        message: error instanceof Error ? error.message : '导入游玩包失败',
        details: (error as Partial<DetailedImportError>)?.details || [],
      })
    } finally {
      setSelectedReviewResourceId('')
      setReviewFilename('')
      setBusy('')
    }
  }

  async function confirmDelete() {
    if (!deleteWorld || !deleteConfirmed) return
    if (uiPreview) {
      const deletedIds = new Set(deleteTargets.map((world) => world.id))
      setWorldList((current) => current.filter((world) => !deletedIds.has(world.id)))
      setDeleteConfirmed(false)
      setDeleteWorld(null)
      setNotice('')
      return
    }
    setBusy(`delete:${deleteWorld.id}`)
    setNotice('')
    try {
      await apiClient.deleteApiPlayAdminWorldsId({
        params: { path: { id: deleteWorld.id } },
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      window.location.reload()
    } catch (error) {
      setNotice((error as Error).message)
      setBusy('')
      setDeleteWorld(null)
    }
  }

  function requestDelete(world: PlayWorld) {
    setDeleteConfirmed(false)
    setDeleteWorld(world)
  }

  async function toggleWorldAvailability(world: PlayWorld) {
    if (uiPreview) {
      const groupId = world.mapGroupId || world.mainProjectId || world.id
      const playEnabled = !isPlayEnabled(world)
      setWorldList((current) =>
        current.map((entry) =>
          (entry.mapGroupId || entry.mainProjectId || entry.id) === groupId
            ? { ...entry, playEnabled }
            : entry,
        ),
      )
      setNotice('')
      return
    }
    setBusy(`availability:${world.id}`)
    setNotice('')
    try {
      const data = await apiClient.patchApiPlayAdminWorldsId({
        params: { path: { id: world.id } },
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { playEnabled: !isPlayEnabled(world) },
      }) as Record<string, any>
      const changed = new Map<string, PlayWorld>(
        ((data.worlds || []) as PlayWorld[]).map((entry) => [entry.id, entry]),
      )
      setWorldList((current) => current.map((entry) => changed.get(entry.id) || entry))
      setNotice(
        isPlayEnabled(world) ? '地图组已关闭，玩家暂时无法进入' : '地图组已启动，玩家可以进入',
      )
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setBusy('')
    }
  }

  function openWorldEditor(world: PlayWorld) {
    setEditWorld(world)
    setEditPublicId(world.publicId)
    setNotice('')
  }

  async function saveWorld(event: FormEvent) {
    event.preventDefault()
    if (!editWorld) return
    if (uiPreview) {
      const publicId = editPublicId.trim()
      setWorldList((current) =>
        current.map((world) => (world.id === editWorld.id ? { ...world, publicId } : world)),
      )
      setEditWorld(null)
      setNotice('')
      return
    }
    setBusy(`edit:${editWorld.id}`)
    setNotice('')
    try {
      const data = await apiClient.patchApiPlayAdminWorldsId({
        params: { path: { id: editWorld.id } },
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { publicId: editPublicId },
      }) as Record<string, any>
      setWorldList((current) =>
        current.map((world) => (world.id === editWorld.id ? data.world : world)),
      )
      setEditWorld(null)
      setNotice(`地图信息已保存，访问链接为 /p/${data.world.publicId}`)
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setBusy('')
    }
  }

  function exitAdmin() {
    sessionStorage.removeItem(TOKEN_KEY)
    setAdminToken('')
    setVerified(false)
  }

  async function logoutAccount() {
    if (!uiPreview) {
      await apiClient.postApiPlayLogout()
    }
    setPreviewSignedIn(false)
    setPlayerName('')
    setPlayerUsername('')
    setPlayerUserId('')
    setPlayerBoxId('')
    setPlayerSkinId('explorer')
    setLibraryEnabled(false)
    setFavoriteIds(new Set())
    setRecentIds([])
    setFavoriteCount(0)
    setRecentCount(0)
  }

  async function saveProfile(changes: PlayerProfileChanges) {
    if (uiPreview) {
      setPlayerName(changes.displayName)
      setPlayerSkinId(changes.avatarSkinId)
    } else {
      const data = await apiClient.patchApiPlayProfile({ body: changes }) as Record<string, any>
      setPlayerName(data.player?.displayName || changes.displayName)
      setPlayerSkinId(data.player?.avatarSkinId || changes.avatarSkinId)
    }
    setNotice('资料已保存')
  }

  const selectedReviewResource = bundleReview?.resources.find(
    (resource) => resource.id === selectedReviewResourceId,
  )
  const selectedReviewWorld = bundleReview?.worlds.find((world) => world.id === reviewWorldId)
  const visibleReviewResources =
    bundleReview?.resources.filter(
      (resource) =>
        resource.worldId === reviewWorldId &&
        resource.kind === reviewCategory &&
        (reviewCategory !== 'script' ||
          (resource.scriptTarget || 'server') === reviewScriptTarget),
    ) || []

  const selectReviewScope = (worldId: string, category: ReviewCategory) => {
    const worldResources =
      bundleReview?.resources.filter((resource) => resource.worldId === worldId) || []
    const nextScriptTarget: ReviewScriptTarget = worldResources.some(
      (resource) =>
        resource.kind === 'script' &&
        (resource.scriptTarget || 'server') === reviewScriptTarget,
    )
      ? reviewScriptTarget
      : worldResources.some(
            (resource) => resource.kind === 'script' && resource.scriptTarget !== 'client',
          )
        ? 'server'
        : 'client'
    setReviewWorldId(worldId)
    setReviewCategory(category)
    setReviewScriptTarget(nextScriptTarget)
    setSelectedReviewResourceId(
      worldResources.find(
        (resource) =>
          resource.kind === category &&
          (category !== 'script' ||
            (resource.scriptTarget || 'server') === nextScriptTarget),
      )?.id || '',
    )
  }

  const selectReviewScriptTarget = (target: ReviewScriptTarget) => {
    setReviewScriptTarget(target)
    setSelectedReviewResourceId(
      bundleReview?.resources.find(
        (resource) =>
          resource.worldId === reviewWorldId &&
          resource.kind === 'script' &&
          (resource.scriptTarget || 'server') === target,
      )?.id || '',
    )
  }

  const selectReviewWorld = (worldId: string) => {
    const category = bundleReview?.resources.some(
      (resource) => resource.worldId === worldId && resource.kind === reviewCategory,
    )
      ? reviewCategory
      : reviewCategories.find(({ kind }) =>
          bundleReview?.resources.some(
            (resource) => resource.worldId === worldId && resource.kind === kind,
          ),
        )?.kind || 'script'
    selectReviewScope(worldId, category)
  }

  return (
    <>
      <Head>
        <title>游玩作品中心</title>
      </Head>
      <main
        className={`page boxWorkCenter playWorkCenter${heroEnabled ? ' playHomeHero' : ''}${
          heroEnabled && headerSolid ? ' isHeaderSolid' : ''
        }`}
      >
        <header className="siteHeader">
          <Link
            className="siteBrand"
            href="/"
            aria-label="BOX3 Engine 游玩作品中心"
            style={{
              alignItems: 'center',
              color: '#f5f5f5',
              display: 'inline-flex',
              flexDirection: 'row',
              flexWrap: 'nowrap',
              gap: 9,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            <img className="siteMark" src="/logo512.png" alt="" aria-hidden="true" />
            <span className="siteBrandName" style={{ color: '#f5f5f5' }}>
              BOX3 Engine
            </span>
          </Link>

          {playerName || playerUserId || playerBoxId || previewSignedIn ? (
            <PlayerAccount
              identity={{
                displayName: playerName,
                username: playerUsername,
                userId: playerUserId,
                boxId: playerBoxId,
                avatarSkinId: playerSkinId,
              }}
              onSave={saveProfile}
              onLogout={logoutAccount}
            />
          ) : (
            <div className="guestActions" aria-label="账户入口">
              {uiPreview ? (
                <button className="guestLogin" type="button" onClick={previewSignIn}>
                  登录 / 注册
                </button>
              ) : (
                <Link className="guestLogin" href="/login-required?source=play">
                  登录 / 注册
                </Link>
              )}
            </div>
          )}
        </header>

        {siteConfig?.announcement?.text ? (
          !siteConfig.announcement.href ? (
            <div className="announceBar" role="status">
              <span className="announceText">{siteConfig.announcement.text}</span>
            </div>
          ) : /^https:/i.test(siteConfig.announcement.href) ? (
            <a
              className="announceBar announceLink"
              href={siteConfig.announcement.href}
              rel="noreferrer"
              aria-label="站点公告"
            >
              <span className="announceText">{siteConfig.announcement.text}</span>
            </a>
          ) : (
            <Link
              className="announceBar announceLink"
              href={siteConfig.announcement.href}
              aria-label="站点公告"
            >
              <span className="announceText">{siteConfig.announcement.text}</span>
            </Link>
          )
        ) : null}

        {bannerImages.length ? (
          <PlayBannerCarousel
            images={bannerImages}
            heightPx={bannerHeightPx}
            autoplayMs={bannerAutoplayMs}
          />
        ) : null}

        <div className="header">
          <div className="title">
            <h1>{t('playHome.maps')}</h1>
            <span>{`${worldGroups.length} 个地图`}</span>
          </div>
        </div>

        {siteTabs.length ? (
          <nav className="sectionNav" aria-label="地图分区">
            {siteTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={activeTab?.key === tab.key ? 'active' : ''}
                onClick={() => setActiveTabKey(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        ) : null}

        {libraryEnabled && worldList.length ? (
          <nav className="collectionNav">
            <button
              className={collectionView === 'all' ? 'active' : ''}
              onClick={() => setCollectionView('all')}
            >
              {t('playHome.all')}
            </button>
            <button
              className={collectionView === 'recent' ? 'active' : ''}
              onClick={() => setCollectionView('recent')}
            >
              {t('playHome.recent')}
            </button>
            <button
              className={collectionView === 'favorites' ? 'active' : ''}
              onClick={() => setCollectionView('favorites')}
            >
              {t('playHome.favorites')}
            </button>
          </nav>
        ) : null}

        {notice ? (
          <div className={`notice${notice === '资料已保存' ? ' success' : ''}`}>
            {notice}
            <button onClick={() => setNotice('')}>×</button>
          </div>
        ) : null}

        {worldList.length ? (
          visibleGroups.length ? (
            <div className="playerGrid" aria-label={t('playHome.mapList')}>
              {visibleGroups.map(({ groupId, main }) => {
                const worldMeta = readPlayWorldMeta(main)
                return (
                <article className="card" key={groupId}>
                  {libraryEnabled ? <button className="favoriteButton" aria-label={t('playHome.favoriteMap')} onClick={() => toggleFavorite(main.publicId)}>{favoriteIds.has(main.publicId) ? '★' : '☆'}</button> : null}
                  {!isPlayEnabled(main) ? <span className="mapClosed">{t('playHome.temporarilyClosed')}</span> : null}
                  <Link className="cardLink" href={`/p/${encodeURIComponent(main.publicId)}`} onClick={(event) => {
                    if (!isPlayEnabled(main)) {
                      event.preventDefault()
                      return
                    }
                    recordRecent(main.publicId)
                  }}>
                    <div className="cover"><img src={main.cover || DEFAULT_MAP_COVER} alt="" />{liveMapStats[main.publicId] ? <span className="mapOnline">{t('playHome.onlineCount', { count: liveMapStats[main.publicId].onlineCount })}</span> : null}</div>
                    <div className="info"><strong>{main.name}</strong><small>{main.author || t('playHome.unnamed')} · {main.version}</small>{worldMeta.parts.length ? <span className="cardMeta">{worldMeta.parts.join(' · ')}</span> : null}{main.description ? <p>{main.description}</p> : null}<span className="playCta">{t('playHome.playNow')} <ArrowUpRight size={15} aria-hidden="true" /></span></div>
                  </Link>
                </article>
                )
              })}
            </div>
          ) : (
            <div className="empty"><strong>{t('playHome.noMatchingMaps')}</strong><small>{t('playHome.noMatchingMapsHint')}</small></div>
          )
        ) : worldList.length ? (
          <div className="groups">
            {worldGroups.map(({ groupId, main, submaps }) => {
              const resources = [main, ...submaps]
                .map((world) => resourceStatuses[world.id])
                .filter((status): status is MapResourceStatus => Boolean(status))
              const totalBytes = resources.reduce((total, status) => total + status.bytes, 0)
              const importTimes = resources.map((status) => status.importedAt).sort()
              const latestImport = importTimes[importTimes.length - 1]
              return (
                <section className="mapGroup" key={groupId} aria-label={`${main.name}地图组`}>
                <header className="groupHeader">
                  <div className="groupIdentity">
                    <div>
                      <strong>{main.name}</strong>
                      <small>1 张主地图 · {submaps.length} 张副地图</small>
                      {verified && resources.length ? (
                        <small className="resourceStatus">
                          {main.version || '未标记版本'} · {formatBytes(totalBytes)} · 导入于 {formatImportedAt(latestImport || '')}
                        </small>
                      ) : null}
                    </div>
                  </div>
                  {verified ? (
                    <label className="groupAvailability">
                      <input
                        type="checkbox"
                        checked={isPlayEnabled(main)}
                        disabled={Boolean(busy)}
                        onChange={() => void toggleWorldAvailability(main)}
                        aria-label={isPlayEnabled(main) ? '关闭地图组' : '启动地图组'}
                      />
                      <i aria-hidden="true" />
                    </label>
                  ) : null}
                </header>
                <div className="mapTree">
                  <div className="mainMap">
                    <span className="roleLabel mainRole">主地图</span>
                    <article className="card">
                      <Link className="cardLink" href={`/p/${encodeURIComponent(main.publicId)}`}>
                        <div className="cover">
                          <img src={main.cover || DEFAULT_MAP_COVER} alt="" />
                        </div>
                        <div className="info">
                          <strong>{main.name}</strong>
                          <small>
                            {main.author || '未署名'} · {main.version}
                          </small>
                          {main.description ? <p>{main.description}</p> : null}
                          <span className="playCta">
                            打开地图
                            <ArrowUpRight size={15} aria-hidden="true" />
                          </span>
                        </div>
                      </Link>
                      {verified ? (
                        <div className="cardActions">
                          <button disabled={Boolean(busy)} onClick={() => openWorldEditor(main)}>
                            地图设置
                          </button>
                          <button
                            className="dangerText"
                            disabled={Boolean(busy)}
                            onClick={() => requestDelete(main)}
                          >
                            删除地图组
                          </button>
                        </div>
                      ) : null}
                    </article>
                  </div>

                  {submaps.length ? (
                    <div className="submapBranch">
                      <div className="branchHeading">
                        <span>副地图</span>
                        <small>共享本地图组资源</small>
                      </div>
                      <div className="submapGrid">
                        {submaps.map((world, index) => (
                          <div className="submapItem" key={world.id}>
                            <span className="roleLabel">
                              副地图 {String(index + 1).padStart(2, '0')}
                            </span>
                            <article className="card">
                              <Link
                                className="cardLink"
                                href={`/p/${encodeURIComponent(world.publicId)}`}
                              >
                                <div className="cover">
                                  <img src={world.cover || DEFAULT_MAP_COVER} alt="" />
                                </div>
                                <div className="info">
                                  <strong>{world.name}</strong>
                                  <small>
                                    {world.author || '未署名'} · {world.version}
                                  </small>
                                  {world.description ? <p>{world.description}</p> : null}
                                  <span className="playCta">
                                    打开地图
                                    <ArrowUpRight size={15} aria-hidden="true" />
                                  </span>
                                </div>
                              </Link>
                              {verified ? (
                                <div className="cardActions">
                                  <button
                                    disabled={Boolean(busy)}
                                    onClick={() => openWorldEditor(world)}
                                  >
                                    地图设置
                                  </button>
                                  <button
                                    className="dangerText"
                                    disabled={Boolean(busy)}
                                    onClick={() => requestDelete(world)}
                                  >
                                    删除副地图
                                  </button>
                                </div>
                              ) : null}
                            </article>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="empty">
            <strong>暂无地图</strong>
            <small>导入地图后会显示在这里</small>
            {verified ? (
              <button className="button primary" onClick={() => importInput.current?.click()}>
                导入地图组游玩包
              </button>
            ) : null}
          </div>
        )}

        <footer className="playFooter">
          <span>{t('playHome.engineDeveloper')} <strong>{t('playHome.engineDeveloperName')}</strong></span>
          <span>{t('playHome.disclaimer')}</span>
          {siteConfig?.footer?.text ? <span className="footerSiteText">{siteConfig.footer.text}</span> : null}
        </footer>
      </main>

      {loginOpen ? (
        <div className="backdrop playWorkOverlay" onMouseDown={() => setLoginOpen(false)}>
          <form
            className="dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              setBusy('verify')
              setNotice('')
              verifyToken(adminToken)
                .catch((error) => setNotice(error.message))
                .finally(() => setBusy(''))
            }}
          >
            <h2>服主验证</h2>
            <label>管理密钥</label>
            <input
              autoFocus
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
            />
            <div className="dialogActions">
              <button className="button" type="button" onClick={() => setLoginOpen(false)}>
                取消
              </button>
              <button
                className="button primary"
                disabled={!adminToken || busy === 'verify'}
                type="submit"
              >
                {busy === 'verify' ? '验证中…' : '验证'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteWorld ? (
        <div
          className="backdrop playWorkOverlay"
          onMouseDown={() => {
            setDeleteConfirmed(false)
            setDeleteWorld(null)
          }}
        >
          <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <h2>{deleteTargets.length > 1 ? '删除地图组' : '删除地图'}</h2>
            <p>
              {deleteTargets.length > 1
                ? `将永久删除主地图及 ${deleteTargets.length - 1} 张副地图，玩家将无法再进入这些地图。`
                : `将永久删除“${deleteWorld.name}”，玩家将无法再进入该地图。`}
            </p>
            <ul className="deleteImpactList">
              {deleteTargets.map((world) => (
                <li key={world.id}>
                  <span>{world.mapRole === 'main' ? '主地图' : '副地图'}</span>
                  {world.name}
                </li>
              ))}
            </ul>
            <label className="deleteConfirm">
              <input
                type="checkbox"
                checked={deleteConfirmed}
                onChange={(event) => setDeleteConfirmed(event.target.checked)}
              />
              我已确认删除，且无法恢复
            </label>
            <div className="dialogActions">
              <button
                className="button"
                onClick={() => {
                  setDeleteConfirmed(false)
                  setDeleteWorld(null)
                }}
              >
                取消
              </button>
              <button
                className="button danger"
                disabled={!deleteConfirmed || busy === `delete:${deleteWorld.id}`}
                onClick={confirmDelete}
              >
                {busy === `delete:${deleteWorld.id}` ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editWorld ? (
        <div
          className="backdrop playWorkOverlay"
          onMouseDown={() => {
            if (!busy) setEditWorld(null)
          }}
        >
          <form
            className="dialog editDialog"
            onSubmit={saveWorld}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>地图设置</h2>
            <label htmlFor="play-world-id">访问 ID</label>
            <input id="play-world-id" maxLength={63} spellCheck={false} value={editPublicId} onChange={(event) => setEditPublicId(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
            <small className="fieldHint">访问链接：/p/{editPublicId || '访问-id'} · 当前游玩端中必须唯一</small>
            <div className="dialogActions">
              <button
                className="button"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setEditWorld(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={Boolean(busy) || !editPublicId.trim()}
              >
                {busy === `edit:${editWorld.id}` ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {bundleReview ? (
        <div className="backdrop playWorkOverlay reviewOverlay">
          <section
            className="bundleReviewDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bundle-review-title"
          >
            <header className="bundleReviewHeader">
              <div className="bundleReviewHeading">
                <span><ShieldCheck size={21} aria-hidden="true" /></span>
                <div>
                  <h2 id="bundle-review-title">检查游玩包</h2>
                  <p>{reviewFilename} · {bundleReview.mapCount} 张地图 · {formatBytes(bundleReview.totalBytes)}</p>
                </div>
              </div>
              <button className="reviewClose" type="button" aria-label="取消审查" onClick={() => void closeBundleReview()}>
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="reviewWorkspace">
              <aside className="reviewMapBrowser" aria-label="地图列表">
                <header>
                  <strong>地图</strong>
                  <span>{bundleReview.worlds.length}</span>
                </header>
                <div className="reviewMapList">
                {bundleReview.worlds.map((world) => (
                  <button
                    key={world.id}
                    className={reviewWorldId === world.id ? 'active' : ''}
                    type="button"
                    onClick={() => selectReviewWorld(world.id)}
                  >
                    <div>
                      <strong>{world.name}</strong>
                      <small>{world.mapRole === 'main' ? '主地图' : '副地图'}{world.version ? ` · ${world.version}` : ''}</small>
                    </div>
                    <span>
                      {bundleReview.resources.filter(
                        (resource) =>
                          resource.worldId === world.id &&
                          ['script', 'image', 'audio'].includes(resource.kind),
                      ).length}
                    </span>
                  </button>
                ))}
                </div>
              </aside>

              <section className="reviewContent">
                <header className="reviewWorldHeader">
                  <div>
                    <span>{selectedReviewWorld?.mapRole === 'submap' ? '副地图' : '主地图'}</span>
                    <h3>{selectedReviewWorld?.name || '选择地图'}</h3>
                    {selectedReviewWorld ? (
                      <p>
                        {selectedReviewWorld.author || '未署名'}
                        {selectedReviewWorld.version ? ` · ${selectedReviewWorld.version}` : ''}
                        {selectedReviewWorld.description ? ` · ${selectedReviewWorld.description}` : ''}
                      </p>
                    ) : null}
                  </div>
                </header>

                <nav className="reviewTabs" aria-label="资源分类">
                  {reviewCategories.map(({ kind, label, icon: Icon }) => {
                    const count = bundleReview.resources.filter(
                      (resource) => resource.worldId === reviewWorldId && resource.kind === kind,
                    ).length
                    return (
                      <button
                        key={kind}
                        className={reviewCategory === kind ? 'active' : ''}
                        type="button"
                        onClick={() => selectReviewScope(reviewWorldId, kind)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        {t(label)}<span>{count}</span>
                      </button>
                    )
                  })}
                </nav>

                <div className="reviewResourceWorkspace">
                  <aside className="reviewResourceList">
                    {reviewCategory === 'script' ? (
                      <div className="reviewScriptFilter" role="tablist" aria-label="代码运行位置">
                        {(['server', 'client'] as const).map((target) => {
                          const count = bundleReview.resources.filter(
                            (resource) =>
                              resource.worldId === reviewWorldId &&
                              resource.kind === 'script' &&
                              (resource.scriptTarget || 'server') === target,
                          ).length
                          return (
                            <button
                              key={target}
                              className={reviewScriptTarget === target ? 'active' : ''}
                              type="button"
                              role="tab"
                              aria-selected={reviewScriptTarget === target}
                              onClick={() => selectReviewScriptTarget(target)}
                            >
                              <span>{target === 'server' ? '服务端' : '客户端'}</span>
                              <small>{count}</small>
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                    {visibleReviewResources.length ? visibleReviewResources.map((resource) => (
                      <button
                        key={resource.id}
                        className={selectedReviewResourceId === resource.id ? 'active' : ''}
                        type="button"
                        onClick={() => setSelectedReviewResourceId(resource.id)}
                      >
                        <span>{resource.name}</span>
                        <small>{formatBytes(resource.bytes)}{resource.previewable ? '' : ' · 无法预览'}</small>
                      </button>
                    )) : <p className="reviewEmpty">这张地图没有{reviewCategories.find((item) => item.kind === reviewCategory)?.label}</p>}
                  </aside>
                  <section className="reviewPreview" aria-live="polite">
                    <header>
                      <strong>{selectedReviewResource?.name || '未选择文件'}</strong>
                      {selectedReviewResource ? <span>{formatBytes(selectedReviewResource.bytes)}</span> : null}
                    </header>
                    <div
                      className={`reviewPreviewBody${
                        selectedReviewResource?.kind === 'script'
                          ? ' code'
                          : selectedReviewResource?.kind === 'image'
                            ? ' image'
                            : ''
                      }`}
                    >
                      {reviewLoading ? <p>正在读取预览…</p> : null}
                      {reviewError ? <p className="reviewPreviewError">{reviewError}</p> : null}
                      {!reviewLoading && !reviewError && selectedReviewResource && !selectedReviewResource.previewable ? (
                        <p>该文件过大或格式不支持在线预览。</p>
                      ) : null}
                      {!reviewLoading && selectedReviewResource?.kind === 'script' && reviewText ? (
                        <pre><code>{reviewText}</code></pre>
                      ) : null}
                      {!reviewLoading && selectedReviewResource?.kind === 'image' && reviewResourceUrl ? (
                        <img src={reviewResourceUrl} alt={selectedReviewResource.name} />
                      ) : null}
                      {!reviewLoading && selectedReviewResource?.kind === 'audio' && reviewResourceUrl ? (
                        <audio controls preload="metadata" src={reviewResourceUrl} />
                      ) : null}
                      {!reviewLoading && !selectedReviewResource ? <p>从文件列表选择内容进行预览</p> : null}
                    </div>
                  </section>
                </div>
              </section>
            </div>

            <footer className="bundleReviewFooter">
              <div className="reviewFooterInfo">
                {bundleReview.warnings.length ? (
                  <details className="reviewWarnings">
                    <summary><AlertTriangle size={14} aria-hidden="true" /> {bundleReview.warnings.length} 项资源提醒</summary>
                    <div>{bundleReview.warnings.slice(0, 10).map((warning, index) => <p key={index}>{warning}</p>)}</div>
                  </details>
                ) : (
                  <p><ShieldCheck size={14} aria-hidden="true" /> 预览不会执行脚本或启动地图</p>
                )}
              </div>
              <div className="reviewFooterActions">
                <button className="button" type="button" onClick={() => void closeBundleReview()}>取消</button>
                <button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => void confirmBundleReview()}>
                  确认并导入
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}

      {importProgress ? (
        <div className="progressBackdrop playWorkOverlay">
          <section
            className="progressDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="play-import-title"
          >
            <div
              className={`progressIcon ${importProgress.phase === 'done' ? 'done' : importProgress.phase === 'error' ? 'error' : ''}`}
            >
              {importProgress.phase === 'done' ? '✓' : importProgress.phase === 'error' ? '!' : '↑'}
            </div>
            <h2 id="play-import-title">
              {importProgress.phase === 'uploading'
                ? '正在上传游玩包'
                : importProgress.phase === 'processing'
                  ? '正在检查并导入地图组'
                  : importProgress.phase === 'done'
                    ? '导入完成'
                    : '导入失败'}
            </h2>
            <p className="progressFilename">
              {importProgress.worldName || importProgress.filename}
              {importProgress.phase === 'done' && importProgress.mapCount
                ? ` · ${importProgress.mapCount} 张地图`
                : ''}
            </p>
            <div
              className="progressTrack"
              aria-label="游玩包导入进度"
              aria-valuenow={Math.round(importProgress.percent)}
              role="progressbar"
            >
              <span style={{ width: `${importProgress.percent}%` }} />
            </div>
            <div className="progressMeta" aria-live="polite">
              <strong>{Math.round(importProgress.percent)}%</strong>
              <span>
                {importProgress.phase === 'uploading'
                  ? `${formatBytes(importProgress.sent)} / ${formatBytes(importProgress.total)} · ${importProgress.elapsedSeconds}s`
                  : importProgress.phase === 'processing'
                    ? `正在解压、校验并原子写入游玩目录 · ${importProgress.elapsedSeconds}s`
                    : importProgress.phase === 'done'
                      ? `${formatBytes(importProgress.total)} · 用时 ${importProgress.elapsedSeconds}s`
                      : importProgress.message}
              </span>
            </div>
            {importProgress.details?.length ? (
              <div className="importDiagnostics" role="log" aria-label="游玩包检查详情">
                <div className="importDiagnosticsHeader">
                  <strong>检查详情</strong>
                  <span>{importProgress.details.length} 项</span>
                </div>
                <ul>
                  {importProgress.details.map((detail, index) => (
                    <li key={`${detail.code || 'detail'}-${index}`} data-level={detail.level}>
                      <span>{detail.level === 'error' ? '错误' : '提醒'}</span>
                      <p>{detail.message}</p>
                      {detail.code ? <code>{detail.code}</code> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {importProgress.phase === 'done' || importProgress.phase === 'error' ? (
              <button
                className="progressClose"
                type="button"
                onClick={() => setImportProgress(null)}
              >
                {importProgress.phase === 'done' ? '完成' : '关闭'}
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      <style jsx>{`
        :global(*) {
          box-sizing: border-box;
        }
        :global(body) {
          margin: 0;
          background: #f7f7f8;
          color: #202124;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        button,
        input {
          font: inherit;
        }
        .page {
          width: min(1120px, calc(100% - 40px));
          margin: 0 auto;
          padding: 20px 0 80px;
        }
        .siteHeader {
          display: flex;
          min-height: 56px;
          align-items: center;
          gap: 28px;
          margin-bottom: 38px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .siteBrand {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          color: #fff;
          font-size: 17px;
          font-weight: 750;
          letter-spacing: -0.03em;
          text-decoration: none;
        }
        .siteMark {
          display: grid;
          width: 22px;
          height: 22px;
          grid-template-columns: repeat(2, 1fr);
          gap: 2px;
          transform: rotate(30deg) skewY(-10deg);
        }
        .siteMark i {
          border-radius: 3px;
          background: #ffdb00;
        }
        .siteMark i:nth-child(2) {
          background: #ffac21;
        }
        .siteMark i:nth-child(3) {
          grid-column: span 2;
          background: #ff7131;
        }
        .siteNav {
          display: flex;
          height: 56px;
          align-items: center;
          gap: 4px;
        }
        .siteNav a {
          display: inline-flex;
          height: 56px;
          align-items: center;
          gap: 7px;
          padding: 0 10px;
          color: rgba(255, 255, 255, 0.54);
          font-size: 13px;
          text-decoration: none;
        }
        .siteNav .siteNavCurrent {
          color: #fff;
          box-shadow: inset 0 -2px #ffdb00;
        }
        .siteAccount {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-left: auto;
          color: rgba(255, 255, 255, 0.7);
          font-size: 13px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 24px;
        }
        .title {
          display: flex;
          align-items: baseline;
          gap: 12px;
        }
        .title h1 {
          font-size: 26px;
          margin: 0;
        }
        .title span {
          font-size: 13px;
          color: #85888f;
        }
        .headerActions {
          display: flex;
          gap: 8px;
        }
        .button {
          display: inline-flex;
          height: 36px;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 0 14px;
          border: 1px solid #d9dadd;
          border-radius: 7px;
          background: #fff;
          color: #303238;
          text-decoration: none;
          cursor: pointer;
          transition:
            transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
            background-color 140ms ease,
            border-color 140ms ease;
        }
        .button:hover {
          background: #f3f4f5;
        }
        .button:active {
          transform: scale(0.97);
        }
        .button:disabled {
          cursor: default;
          opacity: 0.55;
          transform: none;
        }
        .button.primary {
          border-color: #1f2329;
          background: #1f2329;
          color: #fff;
        }
        .button.primary:hover {
          background: #34383f;
        }
        .button.danger {
          border-color: #d94343;
          background: #d94343;
          color: #fff;
        }
        .hidden {
          display: none;
        }
        .notice {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin: -8px 0 18px;
          padding: 10px 12px;
          border: 1px solid #efd0d0;
          border-radius: 7px;
          background: #fff5f5;
          color: #b42323;
          font-size: 13px;
        }
        .notice button {
          border: 0;
          background: transparent;
          color: inherit;
          font-size: 20px;
          cursor: pointer;
        }
        .playerGrid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(208px, 224px));
          justify-content: start;
          gap: 18px;
        }
        .groups {
          display: grid;
          gap: 20px;
        }
        .mapGroup {
          padding: 18px;
          border: 1px solid #e1e3e7;
          border-radius: 12px;
          background: #fff;
        }
        .groupHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          padding-bottom: 16px;
          border-bottom: 1px solid #eceef1;
        }
        .groupIdentity {
          display: flex;
          min-width: 0;
          align-items: center;
          gap: 12px;
        }
        .groupIdentity > div {
          display: grid;
          min-width: 0;
          gap: 4px;
        }
        .groupIdentity strong {
          overflow: hidden;
          font-size: 16px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .groupIdentity small,
        .branchHeading small {
          color: #85888f;
          font-size: 12px;
        }
        .groupIdentity .resourceStatus {
          color: #6e737b;
          font-size: 11px;
        }
        .groupBadge {
          flex: 0 0 auto;
          padding: 5px 8px;
          border-radius: 6px;
          color: #fff;
          background: #282c32;
          font-size: 11px;
          font-weight: 700;
        }
        .groupAvailability {
          display: inline-flex;
          flex: 0 0 auto;
          align-items: center;
          gap: 9px;
          color: #62666d;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
        }
        .groupAvailability input {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
        }
        .groupAvailability i {
          position: relative;
          width: 34px;
          height: 20px;
          border-radius: 999px;
          background: #b8bdc4;
          transition: background-color 150ms ease;
        }
        .groupAvailability i::after {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
          content: '';
          transition: transform 150ms ease;
        }
        .groupAvailability input:checked + i { background: #ffdb00; }
        .groupAvailability input:checked + i::after { transform: translateX(14px); }
        .groupAvailability input:focus-visible + i { outline: 2px solid #285fe8; outline-offset: 3px; }
        .groupAvailability input:disabled + i { opacity: 0.55; }
        .groupAvailability:has(input:disabled) { cursor: default; }
        .mapTree {
          padding-top: 16px;
        }
        .mainMap,
        .submapItem {
          position: relative;
          padding-top: 25px;
        }
        .roleLabel {
          position: absolute;
          z-index: 2;
          top: 0;
          left: 12px;
          color: #777c84;
          font-size: 11px;
          font-weight: 700;
        }
        .mainRole {
          color: #20242a;
        }
        .mainMap {
          width: min(100%, 360px);
        }
        .submapBranch {
          position: relative;
          margin: 18px 0 0 38px;
          padding: 0 0 0 28px;
          border-left: 2px solid #d8dbe0;
        }
        .submapBranch::before {
          position: absolute;
          top: -18px;
          left: -2px;
          width: 28px;
          height: 34px;
          border-bottom: 2px solid #d8dbe0;
          content: '';
        }
        .branchHeading {
          display: flex;
          align-items: baseline;
          gap: 9px;
          margin: 0 0 10px;
        }
        .branchHeading span {
          font-size: 13px;
          font-weight: 700;
        }
        .submapGrid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          gap: 14px;
        }
        .submapItem::before {
          position: absolute;
          top: 11px;
          left: -30px;
          width: 20px;
          border-top: 2px solid #d8dbe0;
          content: '';
        }
        .card {
          overflow: hidden;
          background: #fff;
          border: 1px solid #e6e7e9;
          border-radius: 10px;
          transition:
            border-color 0.15s,
            transform 0.15s,
            box-shadow 0.15s;
        }
        .mainMap .card {
          border-color: #b9bdc4;
          box-shadow: 0 2px 10px rgba(28, 32, 38, 0.06);
        }
        .submapItem .card {
          background: #fcfcfd;
        }
        .card:hover {
          border-color: #aeb2b9;
          box-shadow: 0 8px 22px rgba(28, 32, 38, 0.08);
          transform: translateY(-2px);
        }
        .cardLink {
          display: block;
          color: inherit;
          text-decoration: none;
        }
        .cover {
          position: relative;
          aspect-ratio: 16/9;
          background: #eceef1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #a2a6ad;
          font-size: 32px;
        }
        .cover img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .info {
          padding: 14px;
        }
        .info strong {
          display: block;
          font-size: 15px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .info small {
          display: block;
          color: #85888f;
          margin-top: 6px;
        }
        .info p {
          margin: 10px 0 0;
          color: #5e6269;
          font-size: 13px;
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .cardActions {
          display: flex;
          border-top: 1px solid #ececef;
        }
        .cardActions button {
          flex: 1;
          height: 38px;
          border: 0;
          background: #fff;
          color: #555960;
          font-size: 13px;
          cursor: pointer;
        }
        .cardActions button + button {
          border-left: 1px solid #ececef;
        }
        .cardActions button:hover {
          background: #f6f6f7;
        }
        .cardActions .dangerText {
          color: #cf3939;
        }
        .empty {
          min-height: 164px;
          padding: 54px 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 18px;
          text-align: center;
          color: #92959b;
          background: #fff;
          border: 1px solid #e6e7e9;
          border-radius: 10px;
        }
        .backdrop {
          position: fixed;
          inset: 0;
          z-index: 20;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(0, 0, 0, 0.65);
        }
        .dialog {
          width: min(400px, 100%);
          padding: 24px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: #262626;
          border-radius: 8px;
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.5);
        }
        .editDialog {
          max-height: min(760px, calc(100vh - 40px));
          overflow: auto;
        }
        .dialog h2 {
          margin: 0 0 20px;
          font-size: 19px;
        }
        .dialog p {
          margin: 0 0 22px;
          color: #5d6168;
          font-size: 14px;
          line-height: 1.6;
        }
        .dialog label {
          display: block;
          margin: 13px 0 8px;
          color: #555960;
          font-size: 13px;
        }
        .dialog input,
        .dialog textarea {
          width: 100%;
          padding: 0 11px;
          border: 1px solid #d6d8dc;
          border-radius: 6px;
          outline: none;
          background: #fff;
          color: #303238;
        }
        .dialog input {
          height: 40px;
        }
        .dialog textarea {
          min-height: 82px;
          padding-top: 9px;
          resize: vertical;
          font: inherit;
        }
        .dialog input:focus,
        .dialog textarea:focus {
          border-color: #7a7f87;
          box-shadow: 0 0 0 3px rgba(40, 44, 50, 0.08);
        }
        .dialog input[type='file'] {
          height: auto;
          padding: 7px;
        }
        .fieldHint {
          display: block;
          margin-top: 7px;
          color: #85888f;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }
        .dialogActions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 22px;
        }
        .progressBackdrop {
          position: fixed;
          z-index: 30;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 24px;
          background: rgba(0, 0, 0, 0.66);
        }
        .reviewOverlay {
          z-index: 34;
          overflow-y: auto;
          align-items: flex-start;
        }
        .bundleReviewDialog {
          display: grid;
          width: min(1040px, 100%);
          height: min(700px, calc(100vh - 48px));
          height: min(700px, calc(100dvh - 48px));
          overflow: hidden;
          margin: auto;
          grid-template-rows: auto minmax(0, 1fr) auto;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 12px;
          color: #fff;
          background: #262626;
          box-shadow: 0 28px 90px rgba(0, 0, 0, 0.56);
        }
        .bundleReviewHeader {
          display: flex;
          min-height: 68px;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          padding: 15px 20px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .bundleReviewHeading { display: flex; min-width: 0; align-items: center; gap: 12px; }
        .bundleReviewHeading > span {
          display: grid;
          width: 40px;
          height: 40px;
          flex: 0 0 auto;
          place-items: center;
          border-radius: 8px;
          color: #262626;
          background: #ffdb00;
        }
        .bundleReviewHeading h2 { margin: 0; color: #fff; font-size: 19px; letter-spacing: -0.02em; }
        .bundleReviewHeading p {
          overflow: hidden;
          margin: 4px 0 0;
          color: rgba(255, 255, 255, 0.5);
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .reviewClose {
          display: grid;
          width: 34px;
          height: 34px;
          flex: 0 0 auto;
          place-items: center;
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.56);
          background: transparent;
        }
        .reviewClose:hover { color: #fff; background: #404040; }
        .reviewWorkspace {
          display: grid;
          min-height: 0;
          grid-template-columns: 220px minmax(0, 1fr);
          background: #202020;
        }
        .reviewMapBrowser {
          min-width: 0;
          overflow: hidden;
          border-right: 1px solid rgba(255, 255, 255, 0.09);
          background: #292929;
        }
        .reviewMapBrowser > header {
          display: flex;
          height: 48px;
          align-items: center;
          justify-content: space-between;
          padding: 0 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .reviewMapBrowser > header strong { font-size: 12px; }
        .reviewMapBrowser > header span { color: rgba(255, 255, 255, 0.36); font-size: 10px; }
        .reviewMapList { display: grid; gap: 4px; max-height: calc(100% - 48px); overflow-y: auto; padding: 7px; }
        .reviewMapList > button {
          display: flex;
          width: 100%;
          min-width: 0;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px;
          border: 1px solid transparent;
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.7);
          background: transparent;
          text-align: left;
          transition: color 140ms ease, background-color 140ms ease, transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        .reviewMapList > button > div { min-width: 0; }
        .reviewMapList > button strong,
        .reviewMapList > button small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .reviewMapList > button strong { font-size: 11px; }
        .reviewMapList > button small { margin-top: 4px; color: rgba(255, 255, 255, 0.4); font-size: 9px; }
        .reviewMapList > button > span { flex: 0 0 auto; color: rgba(255, 255, 255, 0.32); font-size: 9px; }
        .reviewMapList > button:hover { color: #fff; background: #343434; }
        .reviewMapList > button.active { border-color: rgba(255, 219, 0, 0.26); color: #fff; background: #363636; }
        .reviewMapList > button.active > span { color: #ffdb00; }
        .reviewMapList > button:active { transform: scale(0.98); }
        .reviewContent { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); }
        .reviewWorldHeader {
          display: flex;
          min-height: 72px;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: #262626;
        }
        .reviewWorldHeader > div { min-width: 0; }
        .reviewWorldHeader span { color: #ffdb00; font-size: 9px; font-weight: 700; }
        .reviewWorldHeader h3 { margin: 3px 0 0; color: #fff; font-size: 15px; }
        .reviewWorldHeader p { overflow: hidden; margin: 5px 0 0; color: rgba(255, 255, 255, 0.42); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
        .reviewTabs {
          display: flex;
          gap: 4px;
          overflow-x: auto;
          padding: 8px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: #262626;
        }
        .reviewTabs button {
          display: inline-flex;
          height: 30px;
          flex: 0 0 auto;
          align-items: center;
          gap: 5px;
          padding: 0 8px;
          border: 1px solid transparent;
          border-radius: 6px;
          color: rgba(255, 255, 255, 0.5);
          background: transparent;
          font-size: 10px;
        }
        .reviewTabs button span { color: rgba(255, 255, 255, 0.3); }
        .reviewTabs button:hover { color: #fff; background: #353535; }
        .reviewTabs button.active { color: #262626; background: #ffdb00; font-weight: 700; }
        .reviewTabs button.active span { color: rgba(38, 38, 38, 0.55); }
        .reviewTabs button:active { transform: scale(0.97); }
        .reviewMapList,
        .reviewTabs,
        .reviewResourceList,
        .reviewPreviewBody,
        .reviewPreviewBody pre,
        .reviewWarnings > div {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.24) transparent;
        }
        .reviewMapList::-webkit-scrollbar,
        .reviewResourceList::-webkit-scrollbar,
        .reviewPreviewBody::-webkit-scrollbar,
        .reviewPreviewBody pre::-webkit-scrollbar,
        .reviewWarnings > div::-webkit-scrollbar {
          width: 8px;
        }
        .reviewTabs::-webkit-scrollbar,
        .reviewPreviewBody pre::-webkit-scrollbar {
          height: 8px;
        }
        .reviewMapList::-webkit-scrollbar-track,
        .reviewTabs::-webkit-scrollbar-track,
        .reviewResourceList::-webkit-scrollbar-track,
        .reviewPreviewBody::-webkit-scrollbar-track,
        .reviewPreviewBody pre::-webkit-scrollbar-track,
        .reviewWarnings > div::-webkit-scrollbar-track {
          background: transparent;
        }
        .reviewMapList::-webkit-scrollbar-thumb,
        .reviewTabs::-webkit-scrollbar-thumb,
        .reviewResourceList::-webkit-scrollbar-thumb,
        .reviewPreviewBody::-webkit-scrollbar-thumb,
        .reviewPreviewBody pre::-webkit-scrollbar-thumb,
        .reviewWarnings > div::-webkit-scrollbar-thumb {
          border: 2px solid transparent;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.24);
          background-clip: padding-box;
        }
        .reviewMapList::-webkit-scrollbar-thumb:hover,
        .reviewTabs::-webkit-scrollbar-thumb:hover,
        .reviewResourceList::-webkit-scrollbar-thumb:hover,
        .reviewPreviewBody::-webkit-scrollbar-thumb:hover,
        .reviewPreviewBody pre::-webkit-scrollbar-thumb:hover,
        .reviewWarnings > div::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 219, 0, 0.62);
          background-clip: padding-box;
        }
        .reviewResourceWorkspace { display: grid; min-height: 0; grid-template-columns: 230px minmax(0, 1fr); }
        .reviewResourceList { min-height: 0; overflow-y: auto; padding: 7px; border-right: 1px solid rgba(255, 255, 255, 0.08); background: #292929; }
        .reviewScriptFilter {
          position: sticky;
          z-index: 2;
          top: -7px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 4px;
          margin: -7px -7px 7px;
          padding: 7px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: #292929;
        }
        .reviewScriptFilter > button {
          display: flex;
          height: 30px;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border-radius: 6px;
          color: rgba(255, 255, 255, 0.5);
          background: transparent;
          font-size: 10px;
        }
        .reviewScriptFilter > button:hover { color: #fff; background: #343434; }
        .reviewScriptFilter > button.active { color: #262626; background: #ffdb00; font-weight: 700; }
        .reviewScriptFilter > button small { color: inherit; font-size: 9px; opacity: 0.62; }
        .reviewResourceList > button {
          display: grid;
          width: 100%;
          gap: 3px;
          padding: 10px;
          border-radius: 6px;
          color: rgba(255, 255, 255, 0.72);
          background: transparent;
          text-align: left;
        }
        .reviewResourceList > button:hover { background: #343434; }
        .reviewResourceList > button.active { color: #fff; background: #3b3b3b; }
        .reviewResourceList > button:active { transform: scale(0.98); }
        .reviewResourceList > button span { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
        .reviewResourceList > button small { color: rgba(255, 255, 255, 0.34); font-size: 9px; }
        .reviewEmpty { margin: 28px 10px; color: rgba(255, 255, 255, 0.38); font-size: 11px; text-align: center; }
        .reviewPreview { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
        .reviewPreview > header {
          display: flex;
          min-height: 42px;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 0 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .reviewPreview > header strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
        .reviewPreview > header span { flex: 0 0 auto; color: rgba(255, 255, 255, 0.34); font-size: 9px; }
        .reviewPreviewBody {
          display: grid;
          min-height: 0;
          overflow: auto;
          place-items: center;
          padding: 16px;
          color: rgba(255, 255, 255, 0.42);
          font-size: 11px;
        }
        .reviewPreviewBody pre {
          width: 100%;
          min-height: 100%;
          margin: 0;
          overflow: auto;
          color: #d7d7d7;
          font: 11px/1.65 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          white-space: pre;
          tab-size: 2;
          user-select: text;
        }
        .reviewPreviewBody.code { display: block; overflow: hidden; padding: 0; }
        .reviewPreviewBody.code pre {
          box-sizing: border-box;
          height: 100%;
          min-height: 0;
          padding: 16px;
        }
        .reviewPreviewBody.image {
          overflow: hidden;
        }
        .reviewPreviewBody img {
          display: block;
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          object-fit: contain;
          border-radius: 6px;
        }
        .reviewPreviewBody audio { width: min(520px, 100%); }
        .reviewPreviewError { color: #f77b7b; }
        .bundleReviewFooter {
          display: flex;
          min-height: 68px;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          padding: 13px 20px;
        }
        .reviewFooterInfo { min-width: 0; }
        .reviewFooterInfo > p {
          display: flex;
          max-width: 680px;
          align-items: flex-start;
          gap: 7px;
          margin: 0;
          color: rgba(255, 255, 255, 0.42);
          font-size: 10px;
          line-height: 1.5;
        }
        .reviewFooterInfo > p svg { flex: 0 0 auto; color: #ffdb00; }
        .reviewWarnings { position: relative; color: rgba(255, 255, 255, 0.52); font-size: 10px; }
        .reviewWarnings summary { display: flex; align-items: center; gap: 6px; list-style: none; cursor: pointer; }
        .reviewWarnings summary::-webkit-details-marker { display: none; }
        .reviewWarnings summary svg { color: #ffdb00; }
        .reviewWarnings > div {
          position: absolute;
          z-index: 5;
          bottom: calc(100% + 10px);
          left: 0;
          width: min(620px, calc(100vw - 48px));
          max-height: 180px;
          overflow-y: auto;
          padding: 10px 12px;
          border: 1px solid rgba(255, 219, 0, 0.22);
          border-radius: 7px;
          background: #30302a;
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.34);
        }
        .reviewWarnings p { margin: 0 0 5px; color: rgba(255, 255, 255, 0.62); font-size: 10px; line-height: 1.45; }
        .reviewWarnings p:last-child { margin-bottom: 0; }
        .reviewFooterActions { display: flex; flex: 0 0 auto; gap: 8px; }
        .progressDialog {
          width: min(100%, 520px);
          padding: 28px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 8px;
          color: #fff;
          background: #262626;
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.5);
        }
        .progressIcon {
          display: grid;
          width: 44px;
          height: 44px;
          place-items: center;
          border-radius: 9px;
          color: #262626;
          background: #ffdb00;
          font-size: 24px;
          font-weight: 800;
        }
        .progressIcon.done {
          color: #fff;
          background: #78c95d;
        }
        .progressIcon.error {
          color: #fff;
          background: #f65252;
        }
        .progressDialog h2 {
          margin: 18px 0 6px;
          font-size: 20px;
        }
        .progressFilename {
          overflow: hidden;
          margin: 0;
          color: rgba(255, 255, 255, 0.62);
          font-size: 13px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .progressTrack {
          overflow: hidden;
          height: 8px;
          margin-top: 24px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
        }
        .progressTrack span {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: #ffdb00;
          transition: width 260ms ease;
        }
        .progressMeta {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-top: 10px;
        }
        .progressMeta strong {
          flex: 0 0 auto;
          color: #ffdb00;
          font-size: 13px;
        }
        .progressMeta span {
          color: rgba(255, 255, 255, 0.58);
          font-size: 12px;
          line-height: 1.55;
          text-align: right;
          word-break: break-all;
        }
        .importDiagnostics {
          max-height: min(310px, 38vh);
          overflow: hidden;
          margin-top: 18px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 9px;
          background: #303030;
        }
        .importDiagnosticsHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .importDiagnosticsHeader strong {
          color: rgba(255, 255, 255, 0.9);
          font-size: 12px;
        }
        .importDiagnosticsHeader span {
          color: rgba(255, 255, 255, 0.48);
          font-size: 11px;
        }
        .importDiagnostics ul {
          display: grid;
          max-height: min(260px, 31vh);
          overflow-y: auto;
          margin: 0;
          padding: 5px 0;
          list-style: none;
        }
        .importDiagnostics li {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 3px 9px;
          padding: 8px 12px;
        }
        .importDiagnostics li + li {
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }
        .importDiagnostics li > span {
          align-self: start;
          min-width: 34px;
          padding: 2px 5px;
          border-radius: 4px;
          color: #fff;
          background: #d94b4b;
          font-size: 10px;
          line-height: 1.35;
          text-align: center;
        }
        .importDiagnostics li[data-level='warning'] > span {
          color: #2b2600;
          background: #ffdb00;
        }
        .importDiagnostics p {
          margin: 0;
          color: rgba(255, 255, 255, 0.78);
          font-size: 12px;
          line-height: 1.55;
          text-align: left;
          word-break: break-word;
        }
        .importDiagnostics code {
          grid-column: 2;
          color: rgba(255, 255, 255, 0.38);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
        }
        .progressClose {
          display: flex;
          min-width: 88px;
          height: 36px;
          align-items: center;
          justify-content: center;
          margin: 24px 0 0 auto;
          border: 0;
          border-radius: 7px;
          color: #262626;
          background: #ffdb00;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .progressClose:hover {
          background: #ffe44d;
        }
        /* Shared product shell: one restrained dark palette, compact surfaces,
           and yellow reserved for the primary action or current selection. */
        :global(body) {
          background: #262626;
          color: #f5f5f5;
        }
        .playWorkCenter.page {
          width: min(1150px, calc(100% - 32px));
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          padding: 0 0 72px;
          color: rgba(255, 255, 255, 0.9);
        }
        .playWorkCenter .siteHeader {
          min-height: 64px;
          gap: 18px;
          margin: 0 0 28px;
          border-color: rgba(255, 255, 255, 0.1);
        }
        .playWorkCenter .siteBrand {
          gap: 10px;
          color: #fff;
          font-size: 16px;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .playWorkCenter .siteMark {
          display: block;
          flex: 0 0 auto;
          width: 26px;
          height: 26px;
          object-fit: contain;
          transform: none;
        }
        .playWorkCenter .guestActions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
        .playWorkCenter .guestActions :global(.guestLogin) { display: inline-flex; height: 32px; align-items: center; justify-content: center; padding: 0 14px; border-radius: 9999px; font-size: 12px; font-weight: 700; line-height: 1; text-decoration: none; transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }
        .playWorkCenter .guestActions :global(.guestLogin) { color: rgba(0, 0, 0, 0.95) !important; background: #fff !important; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.22); }
        .playWorkCenter .guestActions button:global(.guestLogin) { border: 0; cursor: pointer; }
        .playWorkCenter .guestActions :global(.guestLogin):hover { background: #ffdb00 !important; color: #262626 !important; }
        .playWorkCenter .guestActions :global(.guestLogin):active { transform: scale(0.97); }
        .playWorkCenter .header { margin-bottom: 16px; }
        .playWorkCenter .title { gap: 10px; }
        .playWorkCenter .title h1 { color: #fff; font-size: 22px; letter-spacing: -0.025em; }
        .playWorkCenter .title span { color: rgba(255, 255, 255, 0.45); font-size: 13px; }
        .playWorkCenter .button {
          height: 38px;
          border-color: rgba(255, 255, 255, 0.14);
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.84);
          background: #404040;
        }
        .playWorkCenter .button:hover { background: #4a4a4a; }
        .playWorkCenter .button.primary {
          border-color: #ffdb00;
          color: #262626;
          background: #ffdb00;
          font-weight: 700;
        }
        .playWorkCenter .button.primary:hover { background: #ffe44d; }
        .playWorkCenter .notice { border-color: rgba(246, 82, 82, 0.32); color: #ff9a9a; background: rgba(246, 82, 82, 0.08); }
        .playWorkCenter .notice.success { border-color: rgba(255, 219, 0, 0.36); color: #ffdb00; background: rgba(255, 219, 0, 0.08); }
        .playWorkCenter .collectionNav {
          gap: 4px;
          margin: 0 0 20px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .playWorkCenter .collectionNav button {
          height: 30px;
          padding: 0 10px;
          border: 0;
          border-radius: 6px;
          color: rgba(255, 255, 255, 0.55);
          background: transparent;
          font-size: 12px;
          cursor: pointer;
          transition: color 140ms ease, background-color 140ms ease;
        }
        .playWorkCenter .collectionNav button:hover { color: #fff; background: #404040; }
        .playWorkCenter .collectionNav button.active { color: #262626; background: #ffdb00; }
        .playWorkCenter .playerGrid {
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 14px;
        }
        .playWorkCenter .groups {
          grid-template-columns: repeat(auto-fill, minmax(430px, 1fr));
          align-items: start;
          gap: 12px;
        }
        .playWorkCenter .mapGroup {
          padding: 14px;
          border-color: rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          background: #333;
        }
        .playWorkCenter .groupHeader { border-color: rgba(255, 255, 255, 0.09); }
        .playWorkCenter .groupIdentity small,
        .playWorkCenter .branchHeading small,
        .playWorkCenter .roleLabel { color: rgba(255, 255, 255, 0.44); }
        .playWorkCenter .groupIdentity .resourceStatus { color: rgba(255, 255, 255, 0.36); }
        .playWorkCenter .groupBadge { color: #262626; background: #ffdb00; }
        .playWorkCenter .groupAvailability { color: rgba(255, 255, 255, 0.64); }
        .playWorkCenter .groupAvailability i { background: #626262; }
        .playWorkCenter .groupAvailability input:checked + i { background: #ffdb00; }
        .playWorkCenter .mainRole { color: #ffdb00; }
        .playWorkCenter .submapBranch,
        .playWorkCenter .submapBranch::before,
        .playWorkCenter .submapItem::before { border-color: rgba(255, 255, 255, 0.16); }
        .playWorkCenter .card {
          position: relative;
          border-color: rgba(255, 255, 255, 0.09);
          border-radius: 8px;
          background: #404040;
          box-shadow: none;
          transition: border-color 160ms ease, background-color 160ms ease, transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        .playWorkCenter .mainMap .card { border-color: rgba(255, 219, 0, 0.35); }
        .playWorkCenter .card:hover {
          border-color: rgba(255, 219, 0, 0.58);
          background: #484848;
          box-shadow: none;
        }
        .playWorkCenter .cover {
          color: rgba(255, 255, 255, 0.32);
          background: #333;
        }
        .playWorkCenter .info strong { color: #fff; }
        .playWorkCenter .info small { color: rgba(255, 255, 255, 0.45); }
        .playWorkCenter .info p { color: rgba(255, 255, 255, 0.58); }
        .playWorkCenter .playerGrid .card { min-height: 0; }
        .playWorkCenter .playerGrid .cover {
          aspect-ratio: 1;
          border-radius: 7px 7px 0 0;
        }
        .playWorkCenter .playerGrid .info { min-height: 128px; padding: 14px; }
        .playWorkCenter .playerGrid .info p { margin-top: 6px; }
        .playWorkCenter .mapOnline {
          position: absolute;
          bottom: 9px;
          left: 9px;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 8px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 999px;
          color: rgba(255, 255, 255, 0.86);
          background: rgba(38, 38, 38, 0.76);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
          font-size: 11px;
          line-height: 1;
        }
        .playWorkCenter .playCta {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-top: 14px;
          color: #ffdb00;
          font-size: 12px;
          font-weight: 700;
        }
        .playWorkCenter .card:hover .playCta svg { transform: translate(2px, -2px); }
        .playWorkCenter .playCta svg { transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }
        .playWorkCenter .cardActions { border-color: rgba(255, 255, 255, 0.08); }
        .playWorkCenter .cardActions button { color: rgba(255, 255, 255, 0.68); background: #404040; }
        .playWorkCenter .cardActions button + button { border-color: rgba(255, 255, 255, 0.08); }
        .playWorkCenter .cardActions button:hover { background: #4a4a4a; }
        .playWorkCenter .favoriteButton {
          position: absolute;
          z-index: 2;
          top: 10px;
          right: 10px;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          color: #ffdb00;
          background: rgba(38, 38, 38, 0.8);
          transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background-color 140ms ease;
        }
        .playWorkCenter .favoriteButton:hover { background: #262626; }
        .playWorkCenter .favoriteButton:active { transform: scale(0.94); }
        .playWorkCenter .mapClosed {
          position: absolute;
          z-index: 3;
          top: 10px;
          left: 10px;
          padding: 5px 8px;
          border-radius: 5px;
          color: rgba(255, 255, 255, 0.84);
          background: rgba(38, 38, 38, 0.84);
          font-size: 11px;
        }
        .playWorkCenter .empty {
          min-height: 152px;
          align-items: flex-start;
          gap: 5px;
          padding: 24px;
          border: 1px dashed rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          color: #d9dade;
          background: transparent;
          text-align: left;
        }
        .playWorkCenter .empty small { color: rgba(255, 255, 255, 0.5); }
        .playWorkCenter .empty .button { margin-top: 12px; }
        .playWorkCenter .playFooter {
          position: fixed;
          z-index: 10;
          bottom: 0;
          left: 0;
          display: flex;
          justify-content: space-between;
          width: 100%;
          box-sizing: border-box;
          gap: 18px;
          margin: 0;
          padding: 14px max(16px, calc((100% - 1150px) / 2));
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(38, 38, 38, 0.96);
          box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.12);
          backdrop-filter: blur(12px);
          color: rgba(255, 255, 255, 0.4);
          font-size: 11px;
          line-height: 1.65;
        }
        .playWorkCenter .playFooter strong { color: rgba(255, 255, 255, 0.72); font-weight: 600; }
        .playWorkOverlay .dialog,
        .playWorkOverlay .progressDialog {
          border: 1px solid rgba(255, 255, 255, 0.13);
          border-radius: 8px;
          color: #fff;
          background: #262626;
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.48);
        }
        .playWorkOverlay .dialog h2 { color: #fff; }
        .playWorkOverlay .dialog p,
        .playWorkOverlay .dialog label { color: rgba(255, 255, 255, 0.62); }
        .playWorkOverlay .deleteImpactList {
          display: grid;
          gap: 6px;
          max-height: 152px;
          overflow-y: auto;
          margin: -7px 0 18px;
          padding: 10px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          background: #333;
          list-style: none;
        }
        .playWorkOverlay .deleteImpactList li {
          overflow: hidden;
          color: rgba(255, 255, 255, 0.74);
          font-size: 12px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .playWorkOverlay .deleteImpactList span {
          display: inline-block;
          min-width: 42px;
          margin-right: 8px;
          color: rgba(255, 219, 0, 0.88);
          font-size: 10px;
        }
        .playWorkOverlay .deleteConfirm {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 4px;
          color: rgba(255, 255, 255, 0.82);
          font-size: 12px;
          cursor: pointer;
        }
        .playWorkOverlay .deleteConfirm input {
          width: 15px;
          height: 15px;
          accent-color: #ffdb00;
        }
        .playWorkOverlay .dialog input,
        .playWorkOverlay .dialog textarea { border-color: rgba(255, 255, 255, 0.18); color: #fff; background: #404040; }
        .playWorkOverlay .dialog input:focus,
        .playWorkOverlay .dialog textarea:focus { border-color: #ffdb00; box-shadow: 0 0 0 3px rgba(255, 219, 0, 0.14); }
        .playWorkOverlay .fieldHint { color: rgba(255, 255, 255, 0.42); }
        .playWorkOverlay .editDialog { width: min(420px, 100%); padding: 20px; }
        .playWorkOverlay .editDialog h2 { margin-bottom: 18px; font-size: 20px; letter-spacing: -0.02em; }
        .playWorkOverlay .editDialog label { margin-top: 14px; font-weight: 600; }
        .playWorkOverlay .editDialog .fieldHint { margin-top: 6px; font-size: 10px; }
        .playWorkOverlay .editDialog input[type='file'] { height: 44px; padding: 5px; cursor: pointer; }
        .playWorkOverlay .editDialog input[type='file']::file-selector-button {
          height: 30px;
          margin-right: 9px;
          padding: 0 10px;
          border: 0;
          border-radius: 5px;
          color: rgba(255, 255, 255, 0.86);
          background: #505050;
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
        .playWorkOverlay .editDialog input[type='file']::file-selector-button:hover { background: #5a5a5a; }
        .playWorkOverlay .editDialog .dialogActions {
          margin: 20px -20px -20px;
          padding: 12px 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          background: #2a2a2a;
        }
        .playWorkOverlay .button {
          height: 38px;
          border-color: rgba(255, 255, 255, 0.14);
          border-radius: 7px;
          color: rgba(255, 255, 255, 0.84);
          background: #404040;
        }
        .playWorkOverlay .button:hover { background: #4a4a4a; }
        .playWorkOverlay .button.primary {
          border-color: #ffdb00;
          color: #262626;
          background: #ffdb00;
          font-weight: 700;
        }
        .playWorkOverlay .button.primary:hover { background: #ffe44d; }
        .playWorkOverlay .button.danger { border-color: #f65252; color: #fff; background: #d84545; }
        .playWorkOverlay .button.danger:hover { background: #ee5757; }
        @keyframes account-menu-in {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (hover: hover) and (pointer: fine) { .playWorkCenter .card:hover { transform: translateY(-2px); } }
        @media (hover: none), (pointer: coarse) { .playWorkCenter .card:hover { transform: none; } }
        @media (prefers-reduced-motion: reduce) { .playWorkCenter .card, .groupAvailability i, .groupAvailability i::after { transition: none; } }
        @media (max-width: 640px) {
          .reviewOverlay { padding: 12px; }
          .bundleReviewDialog { height: calc(100vh - 24px); }
          .reviewWorkspace { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
          .reviewMapBrowser { border-right: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
          .reviewMapBrowser > header { height: 40px; }
          .reviewMapList { display: flex; max-height: none; overflow-x: auto; padding: 6px; }
          .reviewMapList > button { width: 180px; flex: 0 0 auto; }
          .reviewWorldHeader { min-height: 60px; }
          .reviewResourceWorkspace { grid-template-columns: 1fr; grid-template-rows: 150px minmax(0, 1fr); }
          .reviewResourceList { border-right: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
          .reviewPreview { min-height: 260px; }
          .bundleReviewFooter { align-items: stretch; flex-direction: column; }
          .reviewFooterActions { justify-content: flex-end; }
          .page {
            width: min(100% - 24px, 1120px);
            padding-top: 12px;
          }
          .siteHeader {
            gap: 12px;
            margin-bottom: 28px;
          }
          .siteNav {
            display: none;
          }
          .siteAccount {
            font-size: 12px;
          }
          .header {
            align-items: flex-start;
            flex-direction: column;
          }
          .headerActions {
            width: 100%;
            flex-wrap: wrap;
          }
          .playWorkCenter .playerGrid {
            grid-template-columns: 1fr;
          }
          .playWorkCenter .groups {
            grid-template-columns: 1fr;
          }
          .playWorkCenter .playFooter {
            align-items: flex-start;
            flex-direction: column;
            gap: 5px;
            padding: 10px 16px;
          }
          .mapGroup {
            padding: 14px;
          }
          .groupHeader {
            align-items: flex-start;
            flex-direction: column;
          }
          .mainMap {
            width: 100%;
          }
          .submapBranch {
            margin-left: 12px;
            padding-left: 18px;
          }
          .submapItem::before {
            left: -20px;
            width: 12px;
          }
          .submapGrid {
            grid-template-columns: 1fr;
          }
        }
        /* 卡片元信息行（「7月25日 更新」 · 「9.72K 浏览」）：
           字段缺失时整行不渲染，因此不受 hero 条件限制，两种形态都用同一套样式。 */
        .playWorkCenter .cardMeta {
          display: block;
          margin-top: 5px;
          color: rgba(255, 255, 255, 0.42);
          font-size: 11px;
          letter-spacing: 0.01em;
        }
        /* ---------- play 首页改版：hero 壳层（换皮自 dao3.fun 的实测骨架） ----------           整段都以 .playHomeHero 为前缀，该类只在「拿到站级配置且配置里真有
           banner/公告/tab」时才加到 <main> 上。配置缺失时这段一条都不匹配，
           页面回到改版前的形态：普通流 64px 头部 + 1150px 内容列 + 悬浮页脚。
           Tailwind 语义值 -> 等价 CSS 的换算：
             bg-gray-900 -> #262626   bg-gray-800 -> #1f1f1f   bg-gray-700 -> #333
             rounded-lg -> 8px        pb-[100%] -> 本仓既有 aspect-ratio: 1 比例盒
             hover:scale-110 -> transform: scale(1.1) + transition
             border-radius 9999px -> 胶囊            screens 断点 -> 960 / 1200 三档
        */
        .playHomeHero.page {
          width: 100%;
          padding: 0;
        }
        .playHomeHero .siteHeader {
          position: sticky;
          top: 0;
          z-index: 20;
          height: 64px;
          min-height: 64px;
          box-sizing: border-box;
          margin: 0;
          padding: 0 max(16px, calc((100% - 1024px) / 2));
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(38, 38, 38, 0.96);
          backdrop-filter: blur(12px);
          transition: box-shadow 160ms ease, border-color 160ms ease;
        }
        .playHomeHero.isHeaderSolid .siteHeader {
          border-bottom-color: rgba(255, 255, 255, 0.14);
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.28);
        }
        /* 内容列：1024px 居中（对应 w-full lg:max-w-screen-lg px-4 lg:px-5），
           banner / 公告条 / 页脚保持通栏。 */
        .playHomeHero.page > .header,
        .playHomeHero.page > .sectionNav,
        .playHomeHero.page > .collectionNav,
        .playHomeHero.page > .notice,
        .playHomeHero.page > .playerGrid,
        .playHomeHero.page > .groups,
        .playHomeHero.page > .empty {
          width: min(1024px, calc(100% - 32px));
          margin-left: auto;
          margin-right: auto;
        }
        .playHomeHero .header {
          margin-top: 22px;
        }
        .playHomeHero .announceBar {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          box-sizing: border-box;
          width: 100%;
          min-height: 34px;
          padding: 7px max(16px, calc((100% - 1024px) / 2));
          background: #ffdb00;
          color: #262626;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.5;
          text-align: center;
          text-decoration: none;
        }
        .playHomeHero .announceBar.announceLink {
          cursor: pointer;
          transition: background-color 140ms ease;
        }
        .playHomeHero .announceBar.announceLink:hover {
          background: #ffe44d;
        }
        .playHomeHero .announceText {
          overflow: hidden;
          max-width: 100%;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .playHomeHero .sectionNav {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 0 0 14px;
          padding-bottom: 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .playHomeHero .sectionNav button {
          height: 32px;
          padding: 0 14px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 9999px;
          background: #333;
          color: rgba(255, 255, 255, 0.72);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
        }
        .playHomeHero .sectionNav button:hover { color: #fff; background: #404040; }
        .playHomeHero .sectionNav button.active { border-color: #ffdb00; color: #262626; background: #ffdb00; }
        .playHomeHero .playerGrid {
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 16px;
        }
        .playHomeHero .playerGrid .card { border-radius: 8px; }
        .playHomeHero .playerGrid .cover { overflow: hidden; }
        .playHomeHero .playerGrid .cover img {
          transition: transform 320ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        .playHomeHero .playerGrid .card:hover .cover img { transform: scale(1.1); }
        .playHomeHero .playFooter {
          position: static;
          margin-top: 44px;
          padding: 16px max(16px, calc((100% - 1024px) / 2));
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          background: #1f1f1f;
          box-shadow: none;
          backdrop-filter: none;
        }
        .playHomeHero .footerSiteText { color: rgba(255, 255, 255, 0.5); }
        /* banner 轮播：结构与交互在 components/play-home/banner-carousel.tsx，
           本仓 components/ 无 styled-jsx 先例，故样式由这里以 :global 前缀接管。 */
        .playHomeHero :global(.playBanner) {
          position: relative;
          display: block;
          overflow: hidden;
          width: 100%;
          background: #333;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .playHomeHero :global(.playBannerTrack) {
          display: flex;
          height: 100%;
          transition: transform 420ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        .playHomeHero :global(.playBannerSlide),
        .playHomeHero :global(.playBannerLink) {
          display: block;
          height: 100%;
          color: inherit;
          text-decoration: none;
        }
        .playHomeHero :global(.playBannerSlide) {
          position: relative;
          flex: 0 0 auto;
          overflow: hidden;
          background: #333;
        }
        .playHomeHero :global(.playBannerLink)[aria-hidden='true'] { pointer-events: none; }
        .playHomeHero :global(.playBannerImage) {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .playHomeHero :global(.playBannerScrim) {
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: linear-gradient(
            90deg,
            rgba(0, 0, 0, 0.74) 0%,
            rgba(0, 0, 0, 0.38) 44%,
            rgba(0, 0, 0, 0) 74%
          );
        }
        .playHomeHero :global(.playBannerCaption) {
          position: absolute;
          z-index: 2;
          bottom: 46px;
          left: max(16px, calc((100% - 1024px) / 2));
          display: grid;
          gap: 8px;
          max-width: min(520px, 68%);
        }
        .playHomeHero :global(.playBannerTitle) {
          color: #fff;
          font-size: 26px;
          font-weight: 800;
          letter-spacing: -0.025em;
          line-height: 1.2;
          text-shadow: 0 2px 14px rgba(0, 0, 0, 0.55);
        }
        .playHomeHero :global(.playBannerSubtitle) {
          overflow: hidden;
          color: rgba(255, 255, 255, 0.8);
          font-size: 13px;
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .playHomeHero :global(.playBannerCta) {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          justify-self: start;
          height: 32px;
          padding: 0 14px;
          border-radius: 9999px;
          background: #ffdb00;
          color: #262626;
          font-size: 12px;
          font-weight: 800;
        }
        .playHomeHero :global(.playBannerArrow) {
          position: absolute;
          z-index: 3;
          top: 50%;
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          margin-top: -17px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 9999px;
          color: #fff;
          background: rgba(38, 38, 38, 0.72);
          cursor: pointer;
          opacity: 0.82;
          transition: opacity 140ms ease, background-color 140ms ease, color 140ms ease;
        }
        .playHomeHero :global(.playBannerPrev) { left: max(12px, calc((100% - 1024px) / 2)); }
        .playHomeHero :global(.playBannerNext) { right: max(12px, calc((100% - 1024px) / 2)); }
        .playHomeHero :global(.playBannerArrow:hover),
        .playHomeHero :global(.playBannerArrow:focus-visible) {
          opacity: 1;
          background: #ffdb00;
          color: #262626;
        }
        .playHomeHero :global(.playBannerDots) {
          position: absolute;
          z-index: 3;
          bottom: 14px;
          left: 50%;
          display: flex;
          gap: 6px;
          transform: translateX(-50%);
        }
        .playHomeHero :global(.playBannerDot) {
          width: 8px;
          height: 8px;
          padding: 0;
          border: 0;
          border-radius: 9999px;
          background: rgba(255, 255, 255, 0.42);
          cursor: pointer;
          transition: width 160ms ease, background-color 160ms ease;
        }
        .playHomeHero :global(.playBannerDot.isActive) { width: 22px; background: #ffdb00; }
        /* 顶栏加载进度条（fixed z-9999 + absolute bg-base-500）的不依赖
           @keyframes 版本：styled-jsx 的 keyframes 作用域无法本地验证，改为静态细条。 */
        .playHomeHero :global(.playBannerProgress) {
          position: fixed;
          z-index: 9999;
          top: 0;
          left: 0;
          width: 100%;
          height: 2px;
          background: #3a3a3a;
        }
        .playHomeHero :global(.playBannerProgress) > i {
          position: absolute;
          top: 0;
          left: 0;
          width: 46%;
          height: 100%;
          background: #ffdb00;
        }
        @media (min-width: 961px) {
          .playHomeHero .playerGrid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 18px;
          }
          .playHomeHero :global(.playBannerCaption) { bottom: 54px; }
          .playHomeHero :global(.playBannerTitle) { font-size: 30px; }
        }
        @media (min-width: 1201px) {
          .playHomeHero .playerGrid { gap: 20px; }
          .playHomeHero .header { margin-top: 26px; }
        }
        @media (max-width: 960px) {
          .playHomeHero :global(.playBannerCaption) { bottom: 40px; max-width: 78%; }
          .playHomeHero :global(.playBannerTitle) { font-size: 21px; }
          .playHomeHero :global(.playBannerSubtitle) { font-size: 12px; }
          .playHomeHero :global(.playBannerArrow) { display: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .playHomeHero .playerGrid .cover img,
          .playHomeHero :global(.playBannerTrack) { transition: none; }
          .playHomeHero .playerGrid .card:hover .cover img { transform: none; }
        }
      `}</style>
    </>
  )
}

export const getServerSideProps: GetServerSideProps = async () => {
  if (process.env.BOX_DEPLOYMENT_MODE === 'player-service') {
    return { redirect: { destination: '/', permanent: false } }
  }
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') {
    return { redirect: { destination: '/projects', permanent: false } }
  }
  // Only used by the local UI development server. Production play deployments
  // never set this flag, so their player authentication flow is unchanged.
  if (process.env.NODE_ENV === 'development' && process.env.BOX_UI_PREVIEW === 'true') {
    const worlds = getPlayWorlds()
    return {
      props: {
        worlds: worlds.length ? worlds : previewWorlds,
        uiPreview: true,
        mapStats: previewMapStats,
        siteConfig: previewSiteConfig,
      },
    }
  }
  if (!process.env.BOX_PLAY_LIBRARY_PATH) {
    return {
      redirect: {
        destination: `/p/${encodeURIComponent(process.env.BOX_WORLD_PUBLIC_ID || process.env.BOX_WORLD_ID || 'local')}`,
        permanent: false,
      },
    }
  }
  const worlds = getPlayWorlds()
  const groupByMap = Object.fromEntries(
    worlds.map((world) => [world.publicId, world.mapGroupId || world.mainProjectId || world.id]),
  )
  return {
    props: {
      worlds,
      uiPreview: false,
      mapStats: getPlayPresenceCounts(worlds.map((world) => world.publicId), groupByMap),
      siteConfig: readSiteConfigSafely(),
    },
  }
}

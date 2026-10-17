export const services = [
    ['creator', '地图创作工具 / 创作作品管理', '地图编辑服务', 'creatorPort', 3127, '/'],
    ['voxa', '模型创作工具', '模型编辑服务', 'voxaPort', 3123, '/'],
    ['play', '游玩端', '作品游玩与地图服务', 'playPort', 3121, '/'],
    ['player-service', '后台管理', '账号、权限与封禁', 'playerServicePort', 3124, '/'],
    ['player-auth-portal', '登录页面', '玩家登录与注册', 'authPortalPort', 3125, '/'],
];

const managedServices = [
    ['managed-postgres', 'PostgreSQL', '玩家、权限与地图数据', 'postgresql'],
    ['managed-redis', 'Redis', '缓存与运行时协调', 'redis'],
];

export const startPrompts = [
    '开始你的创作了吗？',
    '准备好让别人来游玩了吗？',
    '选择一个端，开始今天的工作吧。',
    '地图和模型，等你启动。',
];

export const THEME_KEY = 'box-manager-theme';

export const OVERVIEW_POLL_MS = 10000;

export const OVERVIEW_HIDDEN_POLL_MS = 60000;

export const PERFORMANCE_POLL_MS = 5000;

export const PERFORMANCE_HIDDEN_POLL_MS = 30000;

export const PROJECT_RUNTIME_POLL_MS = 3000;

export const PROJECT_RUNTIME_HIDDEN_POLL_MS = 10000;

export const PROJECT_RUNTIME_EMPTY_POLL_MS = 10000;

export const themes = [
    ['system', '跟随系统'],
    ['light', '亮色'],
    ['dark', '暗色'],
];

export const ownerSecretKeys = ['permissionTokenSecret', 'playerAuthApiKey', 'playAdminToken'];

export const numericConfigFields = [
    'playRuntimes',
    'creatorEditRuntimes',
    'creatorPlayRuntimes',
    'creatorEditPrewarmRuntimes',
    'playPrewarmRuntimes',
    'playerLimit',
    'scriptMemoryMb',
    'runtimeIdleMinutes',
    'runtimeStartTimeoutMinutes',
    'teleportMaxRooms',
    'teleportRoomIdleMinutes',
    'databasePoolSize',
    'storageCacheRedisTtl',
    'playerServiceMemoryMb',
    'playerServiceCpuLimit',
    'authPortalMemoryMb',
    'authPortalCpuLimit',
    'creatorMemoryMb',
    'creatorCpuLimit',
    'playMemoryMb',
    'playCpuLimit',
    'redisDb',
    'storageCacheRedisDb',
    'autoBackupIntervalMinutes',
    'autoBackupRetentionCount',
    'autoBackupRetentionDays',
    'playPort',
    'voxaPort',
    'creatorPort',
    'playerServicePort',
    'authPortalPort',
];

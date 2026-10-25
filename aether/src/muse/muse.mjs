/**
 * game-design-brain.mjs — 游戏设计大脑 (GDD/0.1)
 *
 * 让 AI 像人类制作人一样思考：这个游戏该包括什么系统、空间怎么布局、
 * 需要哪些 HUD/模型/地形。类型学知识库(GenreKB) + 空间规划器 + fun 自评，
 * 全程确定性（种子化），输出下游三模块（terrain-engine / ui-theme-kit / model-sculpt）
 * 共同消费的 GDD JSON。校验由 gdd-validate.mjs 守门。
 */
import fsSync from 'node:fs';

/* ================= 类型学知识库 ================= */
export const GenreKB = {
  '像素战争': {
    match: ['像素战争', 'pixel war', '像素对战', '方块战争'],
    artStyle: 'pixel', themeKeywords: ['像素', '方块', '复古', '竞技'],
    loop: { phases: ['采集资源', '升级装备', '团战推进', '摧毁核心'], economy: ['矿石', '木材', '金币'], winConditions: ['摧毁敌方水晶', '积分领先'] },
    systems: [
      { id: 'respawn', name: '重生', ui: [], models: [] },
      { id: 'shop', name: '战备商店', ui: ['shopGrid'], models: [] },
      { id: 'resource', name: '矿脉采集', ui: ['ammoCounter'], models: [{ role: 'prop', name: 'pixel-pickaxe', style: '像素矿镐', sizeHint: [22, 30, 10], animated: false }] },
      { id: 'core', name: '队伍水晶', ui: ['bossbar'], models: [{ role: 'landmark', name: 'pixel-turret', style: '水晶守卫炮塔', sizeHint: [30, 26, 30], animated: true }] },
    ],
    spatialPattern: 'symmetric-camps',
    zoneRecipe: [
      { role: 'spawn', count: 'teams', name: '{team}营地', elevationHint: 'plateau-10', biome: '出生平原', priority: 1 },
      { role: 'arena', count: 1, name: '中央战场', elevationHint: 'bowl+4', biome: '焦土平原', priority: 2 },
      { role: 'resource', count: 'teams', name: '{team}矿脉区', elevationHint: 'hill', biome: '矿洞丘陵', priority: 3 },
      { role: 'shop', count: 1, name: '中立集市', elevationHint: 'flat', biome: '石板广场', priority: 2 },
    ],
    poiKinds: ['bed', 'shop', 'ore', 'core'],
    hud: ['hotbar', 'hearts', 'armorBar', 'hunger', 'xpBar', 'nameplate', 'killfeed', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'crosshair', 'buffRow', 'ammoCounter'],
    models: [
      { role: 'hero', name: 'pixel-blaster', style: '像素步枪', sizeHint: [26, 9, 5], animated: true },
      { role: 'landmark', name: 'pixel-castle', style: '像素城堡', sizeHint: [42, 40, 42], animated: false },
    ],
    terrain: { continentProfile: 'island-ring', rivers: 1, landmarkSilhouettes: ['中央火山口'], traversal: 'walk' },
    pacing: { routeSeconds: [25, 45], shrink: false },
  },
  '起床战争': {
    match: ['起床战争', 'bedwars', '床战'],
    artStyle: 'pixel', themeKeywords: ['床战', '资源岛', '桥'],
    loop: { phases: ['守床', '收集铁金绿钻', '搭桥进攻', '破床歼灭'], economy: ['铁', '金', '绿宝石', '钻石'], winConditions: ['全员歼灭且床已破'] },
    systems: [
      { id: 'bed', name: '队伍床', ui: [], models: [{ role: 'landmark', name: 'pixel-team-bed', style: '像素床', sizeHint: [14, 6, 20] }] },
      { id: 'res-island', name: '资源岛', ui: [], models: [{ role: 'prop', name: 'pixel-generator', style: '像素生成器', sizeHint: [10, 12, 10], animated: true }] },
      { id: 'shop', name: '岛主商店', ui: ['shopGrid'], models: [] },
      { id: 'upgrades', name: '升级祭坛', ui: [], models: [{ role: 'prop', name: 'pixel-altar', style: '像素祭坛', sizeHint: [12, 10, 12], animated: true }] },
    ],
    spatialPattern: 'island-archipelago',
    zoneRecipe: [
      { role: 'spawn', count: 'teams', name: '{team}岛', elevationHint: 'plateau-14', biome: '浮空草岛', priority: 1 },
      { role: 'resource', count: 2, name: '中环资源岛', elevationHint: 'plateau-10', biome: '矿岛', priority: 2 },
      { role: 'shop', count: 1, name: '中央钻石岛', elevationHint: 'plateau-16', biome: '钻石岛', priority: 1 },
    ],
    poiKinds: ['bed', 'generator', 'shop', 'altar'],
    hud: ['hotbar', 'hearts', 'nameplate', 'killfeed', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'crosshair', 'buffRow'],
    models: [{ role: 'landmark', name: 'bedwars-base', style: '床战基地塔', sizeHint: [24, 26, 24], animated: false }],
    terrain: { continentProfile: 'archipelago', rivers: 0, landmarkSilhouettes: ['中央钻石尖塔'], traversal: 'parkour' },
    pacing: { routeSeconds: [20, 35], shrink: false },
  },
  '竞技场PvP': {
    match: ['竞技场', 'pvp', '乱斗', '格斗'],
    artStyle: 'hitech', themeKeywords: ['霓虹', '对决', '擂台'],
    loop: { phases: ['对线消耗', '抢强化', '决胜圈'], economy: ['能量核心'], winConditions: ['淘汰积分'] },
    systems: [
      { id: 'buff-pickup', name: '强化拾取', ui: ['buffRow'], models: [{ role: 'prop', name: 'hitech-orb', style: '能量球', sizeHint: [8, 8, 8], animated: true }] },
      { id: 'spectator', name: '观战系统', ui: ['scoreboard'], models: [] },
    ],
    spatialPattern: 'ring-arena',
    zoneRecipe: [
      { role: 'spawn', count: 'teams', name: '{team}闸门', elevationHint: 'plateau-6', biome: '霓虹平台', priority: 1 },
      { role: 'arena', count: 1, name: '中央擂台', elevationHint: 'bowl+8', biome: '合金地板', priority: 1 },
      { role: 'objective', count: 2, name: '制高点头', elevationHint: 'peak', biome: '天线塔', priority: 3 },
    ],
    poiKinds: ['gate', 'orb', 'tower'],
    hud: ['hearts', 'nameplate', 'killfeed', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'crosshair', 'buffRow', 'ammoCounter'],
    models: [{ role: 'landmark', name: 'hitech-arena-core', style: '竞技场能量核心', sizeHint: [18, 30, 18], animated: true }],
    terrain: { continentProfile: 'island-ring', rivers: 0, landmarkSilhouettes: ['环形能量墙'], traversal: 'parkour' },
    pacing: { routeSeconds: [10, 20], shrink: false },
  },
  '修仙RPG': {
    match: ['修仙', '仙侠', 'rpg', '养成'],
    artStyle: 'ink', themeKeywords: ['水墨', '云海', '飞升'],
    loop: { phases: ['打坐修炼', '采集炼丹', '历练突破', '渡劫飞升'], economy: ['灵石', '灵草', '丹药'], winConditions: ['渡劫成功飞升'] },
    systems: [
      { id: 'meditate', name: '打坐修炼', ui: ['buffRow'], models: [] },
      { id: 'alchemy', name: '炼丹', ui: [], models: [{ role: 'landmark', name: 'ink-furnace', style: '青铜丹炉', sizeHint: [24, 30, 24], animated: true }] },
      { id: 'sect', name: '宗门任务', ui: ['toast'], models: [] },
      { id: 'tribulation', name: '渡劫', ui: ['bossbar'], models: [] },
    ],
    spatialPattern: 'hub-radial',
    zoneRecipe: [
      { role: 'hub', count: 1, name: '青冥城', elevationHint: 'plateau-12', biome: '云上主城', priority: 1 },
      { role: 'resource', count: 2, name: '灵田/药谷', elevationHint: 'hill', biome: '灵植谷地', priority: 2 },
      { role: 'boss', count: 1, name: '渡劫峰', elevationHint: 'peak', biome: '雷岩绝顶', priority: 1 },
      { role: 'shop', count: 1, name: '坊市', elevationHint: 'flat', biome: '石板街市', priority: 3 },
      { role: 'transition', count: 2, name: '云桥', elevationHint: 'bridge', biome: '云海', priority: 4 },
    ],
    poiKinds: ['altar', 'field', 'market', 'peak', 'bridge'],
    hud: ['hotbar', 'hearts', 'xpBar', 'nameplate', 'bossbar', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'toast', 'buffRow', 'crosshair'],
    models: [
      { role: 'hero', name: 'ink-crane', style: '仙鹤', sizeHint: [34, 40, 16], animated: true },
      { role: 'landmark', name: 'ink-stele', style: '问心剑碑', sizeHint: [22, 44, 13], animated: true },
    ],
    terrain: { continentProfile: 'continent', rivers: 2, landmarkSilhouettes: ['中央主峰', '环山'], traversal: 'walk' },
    pacing: { routeSeconds: [20, 40], shrink: false },
  },
  '生存建造': {
    match: ['生存', '建造', 'sandbox', '沙盒'],
    artStyle: 'cozy', themeKeywords: ['田园', '采集', '建造'],
    loop: { phases: ['采集', '建造', '防御夜袭', '扩张'], economy: ['木材', '石料', '食物'], winConditions: ['无限模式'] },
    systems: [
      { id: 'day-cycle', name: '昼夜', ui: ['timer'], models: [] },
      { id: 'craft', name: '制作', ui: ['shopGrid'], models: [{ role: 'prop', name: 'cozy-workbench', style: '木工台', sizeHint: [14, 10, 10] }] },
      { id: 'farm', name: '农场', ui: ['toast'], models: [{ role: 'prop', name: 'cozy-scarecrow', style: '稻草人', sizeHint: [8, 16, 8] }] },
    ],
    spatialPattern: 'single-hub',
    zoneRecipe: [
      { role: 'spawn', count: 1, name: '初始营地', elevationHint: 'flat', biome: '草原', priority: 1 },
      { role: 'resource', count: 3, name: '林区/石场/浆果丛', elevationHint: 'hill', biome: '混交林', priority: 2 },
      { role: 'boss', count: 1, name: '远古遗迹', elevationHint: 'plateau-8', biome: '苔原遗迹', priority: 3 },
    ],
    poiKinds: ['camp', 'grove', 'quarry', 'ruin'],
    hud: ['hotbar', 'hearts', 'hunger', 'xpBar', 'nameplate', 'minimapFrame', 'toast', 'buffRow', 'crosshair', 'timer'],
    models: [{ role: 'landmark', name: 'cozy-windmill', style: '风车农舍', sizeHint: [26, 34, 26], animated: true }],
    terrain: { continentProfile: 'continent', rivers: 2, landmarkSilhouettes: ['风车山丘'], traversal: 'walk' },
    pacing: { routeSeconds: [20, 50], shrink: false },
  },
  '跑酷': {
    match: ['跑酷', 'parkour', '闯关'],
    artStyle: 'hitech', themeKeywords: ['速通', '跳跃', '计时'],
    loop: { phases: ['计时起跑', '关卡跳跃', '终点排名'], economy: [], winConditions: ['最短时间'] },
    systems: [
      { id: 'checkpoints', name: '检查点', ui: ['toast'], models: [] },
      { id: 'leaderboard', name: '排行榜', ui: ['scoreboard'], models: [] },
    ],
    spatialPattern: 'linear-track',
    zoneRecipe: [
      { role: 'spawn', count: 1, name: '起点平台', elevationHint: 'plateau-20', biome: '霓虹跑道', priority: 1 },
      { role: 'transition', count: 4, name: '关卡段', elevationHint: 'varies', biome: '悬浮赛道', priority: 2 },
      { role: 'objective', count: 1, name: '终点', elevationHint: 'plateau-40', biome: '终点塔', priority: 1 },
    ],
    poiKinds: ['start', 'checkpoint', 'finish'],
    hud: ['timer', 'hearts', 'nameplate', 'crosshair', 'buffRow', 'minimapFrame'],
    models: [{ role: 'prop', name: 'hitech-beacon', style: '检查点信标', sizeHint: [6, 24, 6], animated: true }],
    terrain: { continentProfile: 'archipelago', rivers: 0, landmarkSilhouettes: ['终点光柱'], traversal: 'parkour' },
    pacing: { routeSeconds: [45, 120], shrink: false },
  },
  '塔防': {
    match: ['塔防', 'tower defense', '防守'],
    artStyle: 'cozy', themeKeywords: ['波次', '建造', '防守'],
    loop: { phases: ['布防', '抵御波次', '升级', 'boss 波'], economy: ['金币'], winConditions: ['守住 N 波'] },
    systems: [
      { id: 'waves', name: '波次', ui: ['timer', 'scoreboard'], models: [] },
      { id: 'towers', name: '炮塔建造', ui: ['shopGrid'], models: [{ role: 'prop', name: 'cozy-tower', style: '守卫炮塔', sizeHint: [10, 18, 10], animated: true }] },
    ],
    spatialPattern: 'linear-track',
    zoneRecipe: [
      { role: 'objective', count: 1, name: '水晶要塞', elevationHint: 'plateau-8', biome: '要塞', priority: 1 },
      { role: 'transition', count: 3, name: '防线带', elevationHint: 'flat', biome: '草地防线', priority: 2 },
      { role: 'spawn', count: 1, name: '怪物巢穴', elevationHint: 'canyon', biome: '黑暗裂谷', priority: 1 },
    ],
    poiKinds: ['crystal', 'lane', 'nest'],
    hud: ['hotbar', 'hearts', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'toast', 'buffRow', 'crosshair'],
    models: [{ role: 'landmark', name: 'cozy-castle-gate', style: '要塞大门', sizeHint: [24, 22, 12] }],
    terrain: { continentProfile: 'canyon', rivers: 0, landmarkSilhouettes: ['裂谷巢穴'], traversal: 'walk' },
    pacing: { routeSeconds: [15, 30], shrink: false },
  },
  '大逃杀': {
    match: ['大逃杀', '吃鸡', 'battle royale', 'battle-royale'],
    artStyle: 'hitech', themeKeywords: ['缩圈', '拾取', '生存'],
    loop: { phases: ['跳伞落地', '拾取装备', '转移进圈', '决赛圈'], economy: ['装备品质'], winConditions: ['最后存活'] },
    systems: [
      { id: 'loot', name: '战利品', ui: ['hotbar', 'ammoCounter'], models: [{ role: 'prop', name: 'hitech-crate', style: '补给箱', sizeHint: [10, 8, 10] }] },
      { id: 'shrink', name: '收缩圈', ui: ['minimapFrame', 'timer'], models: [] },
      { id: 'revive', name: '复活赛', ui: [], models: [] },
    ],
    spatialPattern: 'scattered-pois',
    zoneRecipe: [
      { role: 'hub', count: 1, name: '中央城区', elevationHint: 'varies', biome: '高密度城区', priority: 1 },
      { role: 'resource', count: 4, name: '外围资源点', elevationHint: 'hill', biome: '村落/工厂', priority: 2 },
      { role: 'boss', count: 1, name: '军事要塞', elevationHint: 'plateau-10', biome: '要塞', priority: 3 },
      { role: 'transition', count: 3, name: '野外区', elevationHint: 'varies', biome: '荒野', priority: 4 },
    ],
    poiKinds: ['loot', 'crate', 'tower', 'vault'],
    hud: ['hotbar', 'hearts', 'armorBar', 'nameplate', 'killfeed', 'minimapFrame', 'timer', 'crosshair', 'buffRow', 'ammoCounter'],
    models: [{ role: 'landmark', name: 'hitech-station', style: '补给轨道站', sizeHint: [34, 12, 34], animated: true }],
    terrain: { continentProfile: 'continent', rivers: 2, landmarkSilhouettes: ['中央塔群'], traversal: 'walk' },
    pacing: { routeSeconds: [40, 70], shrink: true },
  },
  '夺旗': {
    match: ['夺旗', 'ctf', '旗帜'],
    artStyle: 'hitech', themeKeywords: ['对抗', '护送', '旗帜'],
    loop: { phases: ['取旗', '护送回营', '防守反击', '返程加速'], economy: ['充能核心'], winConditions: ['先夺 N 旗'] },
    systems: [
      { id: 'flags', name: '旗帜', ui: ['teamScore', 'toast'], models: [{ role: 'landmark', name: 'hitech-flag', style: '能量旗', sizeHint: [6, 26, 6], animated: true }] },
      { id: 'speed-pads', name: '加速板', ui: [], models: [{ role: 'prop', name: 'hitech-pad', style: '加速板', sizeHint: [10, 2, 10] }] },
    ],
    spatialPattern: 'symmetric-camps',
    zoneRecipe: [
      { role: 'spawn', count: 'teams', name: '{team}基地', elevationHint: 'plateau-8', biome: '基地平台', priority: 1 },
      { role: 'arena', count: 1, name: '中央峡谷', elevationHint: 'canyon', biome: '峡谷', priority: 2 },
      { role: 'resource', count: 2, name: '侧翼高地', elevationHint: 'hill', biome: '高地', priority: 3 },
    ],
    poiKinds: ['flag', 'pad', 'base'],
    hud: ['hearts', 'nameplate', 'killfeed', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'crosshair', 'buffRow'],
    models: [{ role: 'landmark', name: 'hitech-flag-base', style: '旗座', sizeHint: [12, 6, 12] }],
    terrain: { continentProfile: 'canyon', rivers: 1, landmarkSilhouettes: ['跨谷大桥'], traversal: 'parkour' },
    pacing: { routeSeconds: [20, 40], shrink: false },
  },
  '躲猫猫': {
    match: ['躲猫猫', '捉迷藏', 'prop hunt', 'hide'],
    artStyle: 'cozy', themeKeywords: ['伪装', '搜寻', '欢乐'],
    loop: { phases: ['伪装躲藏', '搜捕计时', '互换攻防'], economy: [], winConditions: ['存活到时/找出全部'] },
    systems: [
      { id: 'disguise', name: '道具伪装', ui: ['hotbar', 'toast'], models: [{ role: 'prop', name: 'cozy-prop-set', style: '伪装物件组', sizeHint: [16, 16, 16] }] },
      { id: 'taunt', name: '挑衅动作', ui: ['buffRow'], models: [] },
    ],
    spatialPattern: 'single-hub',
    zoneRecipe: [
      { role: 'arena', count: 1, name: '主屋', elevationHint: 'flat', biome: '家具屋', priority: 1 },
      { role: 'resource', count: 2, name: '花园/库房', elevationHint: 'flat', biome: '花园', priority: 2 },
    ],
    poiKinds: ['room', 'garden', 'storage'],
    hud: ['hotbar', 'hearts', 'timer', 'scoreboard', 'toast', 'buffRow', 'crosshair'],
    models: [{ role: 'prop', name: 'cozy-furniture', style: '家具组', sizeHint: [20, 16, 20] }],
    terrain: { continentProfile: 'island-ring', rivers: 0, landmarkSilhouettes: ['大宅'], traversal: 'walk' },
    pacing: { routeSeconds: [10, 25], shrink: false },
  },
};

/* ================= 工具 ================= */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TEAM_NAMES = ['红方', '蓝方', '绿方', '黄方'];
const BIOME_BLOCKS = {
  '出生平原': { top: 'grass', sub: 'dirt', base: 'stone' }, '焦土平原': { top: 'dark_dirt', sub: 'dirt', base: 'stone' },
  '矿洞丘陵': { top: 'stone', sub: 'stone', base: 'stone' }, '石板广场': { top: 'light_sand', sub: 'dirt', base: 'stone' },
  '浮空草岛': { top: 'grass', sub: 'dirt', base: 'stone' }, '矿岛': { top: 'dark_grass_rock', sub: 'dirt', base: 'stone' },
  '钻石岛': { top: 'light_sand', sub: 'stone', base: 'stone' }, '霓虹平台': { top: 'dark_sand', sub: 'stone', base: 'stone' },
  '合金地板': { top: 'light_volcanic_rock', sub: 'dark_volcanic_rock', base: 'stone' }, '天线塔': { top: 'dark_volcanic_rock', sub: 'stone', base: 'stone' },
  '云上主城': { top: 'grass', sub: 'dirt', base: 'stone' }, '灵植谷地': { top: 'orange_grass', sub: 'dirt', base: 'stone' },
  '雷岩绝顶': { top: 'dark_volcanic_rock', sub: 'stone', base: 'stone' }, '石板街市': { top: 'light_sand', sub: 'dirt', base: 'stone' },
  '云海': { top: 'snow', sub: 'snow', base: 'stone' }, '草原': { top: 'grass', sub: 'dirt', base: 'stone' },
  '混交林': { top: 'dark_grass_all', sub: 'dirt', base: 'stone' }, '苔原遗迹': { top: 'snow_grass', sub: 'dirt', base: 'stone' },
  '霓虹跑道': { top: 'dark_sand', sub: 'stone', base: 'stone' }, '悬浮赛道': { top: 'light_purple_grass_', sub: 'stone', base: 'stone' },
  '终点塔': { top: 'dark_sand', sub: 'stone', base: 'stone' }, '要塞': { top: 'grass_rock', sub: 'stone', base: 'stone' },
  '草地防线': { top: 'grass', sub: 'dirt', base: 'stone' }, '黑暗裂谷': { top: 'dark_volcanic_rock', sub: 'dark_volcanic_rock', base: 'stone' },
  '高密度城区': { top: 'dark_grass_rock', sub: 'stone', base: 'stone' }, '村落/工厂': { top: 'orange_grass_all', sub: 'dirt', base: 'stone' },
  '荒野': { top: 'withered_grass', sub: 'dirt', base: 'stone' }, '峡谷': { top: 'grass_rock', sub: 'stone', base: 'stone' },
  '高地': { top: 'snow_land', sub: 'stone', base: 'stone' }, '基地平台': { top: 'dark_sand', sub: 'stone', base: 'stone' },
  '家具屋': { top: 'orange_grass', sub: 'dirt', base: 'stone' }, '花园': { top: 'pink_grass', sub: 'dirt', base: 'stone' },
};

function matchGenre(input) {
  const text = String(input || '').toLowerCase();
  for (const [name, kb] of Object.entries(GenreKB)) {
    if (kb.match.some((m) => text.includes(m.toLowerCase()))) return name;
  }
  return null;
}

/* ================= KB 外置与自由意图 ================= */
/**
 * 外置知识库：src/muse/genre-kb-extra.json（数组，元素与 GenreKB 值同构 +
 * `name` 字段）。新题材不再改代码——LLM/人按 schema 产出条目，过校验即入 KB。
 * 校验失败的条目跳过并 warn，绝不阻塞主流程。
 */
const KB_EXTRA_PATH = new URL('./genre-kb-extra.json', import.meta.url);
try {
  if (fsSync.existsSync(KB_EXTRA_PATH)) {
    const extras = JSON.parse(fsSync.readFileSync(KB_EXTRA_PATH, 'utf8'));
    for (const entry of Array.isArray(extras) ? extras : []) {
      const name = String(entry?.name || '').trim();
      if (!name || GenreKB[name]) continue;
      const required = ['match', 'zoneRecipe', 'spatialPattern', 'poiKinds'];
      if (!required.every((k) => entry[k])) {
        console.warn(`[muse] genre-kb-extra 条目 "${name}" 缺字段（${required.join('/')}），跳过`);
        continue;
      }
      GenreKB[name] = { ...entry };
    }
  }
} catch (error) {
  console.warn(`[muse] genre-kb-extra.json 读取失败（忽略）: ${error.message}`);
}

/**
 * 自由意图 → 最贴近类型：先关键词直配（matchGenre），再 token 重叠打分
 * （match + themeKeywords + 类型名）。返回 { genre, score } 或 null。
 * 供 NL 需求先落类型再传 overrides 给 generateGDD。
 */
export function resolveGenre(input) {
  const text = String(input || '').toLowerCase().trim();
  if (!text) return null;
  const direct = matchGenre(text);
  if (direct) return { genre: direct, score: 1 };
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  let best = null;
  for (const [name, kb] of Object.entries(GenreKB)) {
    const haystack = [...kb.match, ...kb.themeKeywords, name].map((m) => m.toLowerCase());
    let hits = 0;
    for (const token of tokens) {
      if (haystack.some((h) => h.includes(token) || token.includes(h))) hits += 1;
    }
    const score = hits / tokens.length;
    if (score > 0 && (!best || score > best.score)) best = { genre: name, score: Number(score.toFixed(3)) };
  }
  return best;
}

/* ================= 空间规划器 ================= */
function planZones({ kb, W, H, teams, rng }) {
  const zones = [];
  const R = Math.min(W, H) / 2;
  const cx = W / 2, cz = H / 2;
  let id = 0;
  const add = (z) => { zones.push({ id: `z${id++}`, ...z }); };
  const perRecipe = [];
  for (const r of kb.zoneRecipe) {
    const n = r.count === 'teams' ? teams : r.count;
    for (let i = 0; i < n; i += 1) perRecipe.push({ ...r, idx: i, team: r.count === 'teams' ? i : null });
  }
  switch (kb.spatialPattern) {
    case 'symmetric-camps': {
      const teamZones = perRecipe.filter((r) => r.team !== null);
      const others = perRecipe.filter((r) => r.team === null);
      // 队伍营地在环上均匀分布
      const ringR = R * 0.62;
      teamZones.filter((r) => r.role === 'spawn').forEach((r) => {
        const ang = (r.idx / teams) * Math.PI * 2 - Math.PI / 2;
        add({ role: r.role, name: r.name.replace('{team}', TEAM_NAMES[r.idx]), center: [Math.round(cx + Math.cos(ang) * ringR), Math.round(cz + Math.sin(ang) * ringR)], radius: Math.round(R * 0.16), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: ['z_hub'], gameplayNotes: `${TEAM_NAMES[r.idx]} 出生+核心`, team: r.idx });
      });
      // 每队附属区（资源）贴在自己营地与中心之间（外推，避开中央战场）
      teamZones.filter((r) => r.role !== 'spawn').forEach((r) => {
        const spawn = zones.find((z) => z.team === r.idx && z.role === 'spawn');
        if (!spawn) return;
        const ang = Math.atan2(spawn.center[1] - cz, spawn.center[0] - cx);
        const midR = ringR * 0.62;
        add({ role: r.role, name: r.name.replace('{team}', TEAM_NAMES[r.idx]), center: [Math.round(cx + Math.cos(ang) * midR), Math.round(cz + Math.sin(ang) * midR)], radius: Math.round(R * 0.12), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [spawn.id], gameplayNotes: `${TEAM_NAMES[r.idx]} 资源`, team: r.idx });
      });
      // 中立区：战场自适应半径（不吞资源环），集市放两营地间空档
      const resR = Math.round(R * 0.12);
      const arenaR = Math.max(Math.round(R * 0.12), Math.min(Math.round(R * 0.26), Math.round(ringR * 0.62 - resR * 0.85 - 10)));
      others.forEach((r, i) => {
        if (r.role === 'arena') {
          add({ role: r.role, name: r.name, center: [Math.round(cx), Math.round(cz)], radius: arenaR, elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: '中立' });
        } else {
          const ang = -Math.PI / 2 + Math.PI / teams * (i + 0.5) * 2;
          const rr = Math.max(arenaR + Math.round(R * 0.1), Math.round(ringR * 0.38));
          add({ role: r.role, name: r.name, center: [Math.round(cx + Math.cos(ang) * rr), Math.round(cz + Math.sin(ang) * rr)], radius: Math.round(R * 0.1), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: '中立' });
        }
      });
      break;
    }
    case 'island-archipelago': {
      const ringR = R * 0.66;
      const spawns = perRecipe.filter((r) => r.team !== null && r.role === 'spawn');
      spawns.forEach((r) => {
        const ang = (r.idx / teams) * Math.PI * 2 - Math.PI / 2;
        add({ role: r.role, name: r.name.replace('{team}', TEAM_NAMES[r.idx]), center: [Math.round(cx + Math.cos(ang) * ringR), Math.round(cz + Math.sin(ang) * ringR)], radius: Math.round(R * 0.15), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: `${TEAM_NAMES[r.idx]} 基地岛`, team: r.idx });
      });
      perRecipe.filter((r) => r.team === null).forEach((r, i) => {
        const ang = (i / Math.max(1, perRecipe.filter((x) => x.team === null).length)) * Math.PI * 2 + 0.5;
        const rr = r.role === 'shop' ? 0 : ringR * 0.5;
        add({ role: r.role, name: r.name, center: [Math.round(cx + Math.cos(ang) * rr), Math.round(cz + Math.sin(ang) * rr)], radius: Math.round(R * (r.role === 'shop' ? 0.1 : 0.13)), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: r.role === 'shop' ? '中央高价值区' : '资源岛' });
      });
      break;
    }
    case 'ring-arena': {
      perRecipe.forEach((r) => {
        if (r.team !== null) {
          const ang = (r.idx / teams) * Math.PI * 2 - Math.PI / 2;
          add({ role: r.role, name: r.name.replace('{team}', TEAM_NAMES[r.idx]), center: [Math.round(cx + Math.cos(ang) * R * 0.55), Math.round(cz + Math.sin(ang) * R * 0.55)], radius: Math.round(R * 0.13), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: '入场闸门', team: r.idx });
        } else if (r.role === 'arena') {
          add({ role: r.role, name: r.name, center: [Math.round(cx), Math.round(cz)], radius: Math.round(R * 0.3), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: '主擂台' });
        } else {
          const ang = rng() * Math.PI * 2;
          add({ role: r.role, name: r.name, center: [Math.round(cx + Math.cos(ang) * R * 0.4), Math.round(cz + Math.sin(ang) * R * 0.4)], radius: Math.round(R * 0.1), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: [], gameplayNotes: '制高点' });
        }
      });
      break;
    }
    case 'hub-radial': {
      add({ role: 'hub', name: kb.zoneRecipe.find((r) => r.role === 'hub')?.name || '主城', center: [Math.round(cx), Math.round(cz)], radius: Math.round(R * 0.22), elevationHint: 'plateau-12', biome: kb.zoneRecipe.find((r) => r.role === 'hub')?.biome || '云上主城', priority: 1, adjacency: [], gameplayNotes: '枢纽' });
      const rest = perRecipe.filter((r) => r.role !== 'hub');
      rest.forEach((r, i) => {
        const ang = (i / rest.length) * Math.PI * 2 - Math.PI / 2;
        add({ role: r.role, name: r.name, center: [Math.round(cx + Math.cos(ang) * R * 0.68), Math.round(cz + Math.sin(ang) * R * 0.68)], radius: Math.round(R * 0.14), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: ['z0'], gameplayNotes: r.role });
      });
      break;
    }
    case 'linear-track': {
      const n = perRecipe.length;
      perRecipe.forEach((r, i) => {
        const t = (i + 0.5) / n;
        const x = Math.round(20 + t * (W - 40));
        const zig = Math.round(cz + Math.sin(t * Math.PI * 3) * R * 0.22);
        add({ role: r.role, name: r.name, center: [x, zig], radius: Math.round(R * 0.13), elevationHint: r.elevationHint === 'varies' ? `plateau-${Math.round(8 + t * 26)}` : r.elevationHint, biome: r.biome, priority: r.priority, adjacency: i ? [`z${id - 1}`] : [], gameplayNotes: `赛道 ${Math.round(t * 100)}%` });
      });
      break;
    }
    case 'scattered-pois': {
      const hub = perRecipe.find((r) => r.role === 'hub');
      if (hub) add({ role: 'hub', name: hub.name, center: [Math.round(cx), Math.round(cz)], radius: Math.round(R * 0.2), elevationHint: 'varies', biome: hub.biome, priority: 1, adjacency: [], gameplayNotes: '高价值城区' });
      perRecipe.filter((r) => r.role !== 'hub').forEach((r, i) => {
        const ang = (i / Math.max(1, perRecipe.length - 1)) * Math.PI * 2 + rng();
        const rr = R * (0.35 + rng() * 0.4);
        add({ role: r.role, name: r.name, center: [Math.round(cx + Math.cos(ang) * rr), Math.round(cz + Math.sin(ang) * rr)], radius: Math.round(R * 0.11), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: zones.length ? ['z0'] : [], gameplayNotes: r.role });
      });
      break;
    }
    default: { // single-hub
      add({ role: 'hub', name: '中心营地', center: [Math.round(cx), Math.round(cz)], radius: Math.round(R * 0.18), elevationHint: 'flat', biome: '草原', priority: 1, adjacency: [], gameplayNotes: '枢纽' });
      perRecipe.forEach((r, i) => {
        const ang = (i / Math.max(1, perRecipe.length)) * Math.PI * 2 - Math.PI / 2;
        add({ role: r.role, name: r.name, center: [Math.round(cx + Math.cos(ang) * R * 0.6), Math.round(cz + Math.sin(ang) * R * 0.6)], radius: Math.round(R * 0.13), elevationHint: r.elevationHint, biome: r.biome, priority: r.priority, adjacency: ['z0'], gameplayNotes: r.role });
      });
    }
  }
  // 邻接补全：无邻接的 zone 连到最近的 zone
  for (const z of zones) {
    if (z.adjacency.length) continue;
    let best = null, bd = Infinity;
    for (const o of zones) {
      if (o === z) continue;
      const d = (o.center[0] - z.center[0]) ** 2 + (o.center[1] - z.center[1]) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    if (best) z.adjacency.push(best.id);
  }
  relaxZones(zones, W, H);
  return zones;
}

/** 松弛：重叠的 zone 对沿中心线推开（低 priority 移动更多），并钳回地图（兜底所有空间范式） */
function relaxZones(zones, W, H) {
  const weight = (z) => (z.role === 'spawn' || z.role === 'hub' ? 0.25 : 1);
  for (let iter = 0; iter < 16; iter += 1) {
    let worst = null;
    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        const a = zones[i], b = zones[j];
        let dx = b.center[0] - a.center[0], dy = b.center[1] - a.center[1];
        // 中心重合（同角色多 zone 常见）：推开方向无定义会让松弛器永远空转。
        // 用黄金角按索引确定性取方向，把两中心沿该向各推 need/2。
        if (!dx && !dy) {
          const ang = (i * 2.399 + j * 1.047) % (Math.PI * 2);
          const dist = ((a.radius + b.radius) * 0.86) / 2 + 1;
          a.center = [Math.round(a.center[0] - Math.cos(ang) * dist), Math.round(a.center[1] - Math.sin(ang) * dist)];
          b.center = [Math.round(b.center[0] + Math.cos(ang) * dist), Math.round(b.center[1] + Math.sin(ang) * dist)];
          worst = true;
          continue;
        }
        const d = Math.hypot(dx, dy) || 1;
        const need = (a.radius + b.radius) * 0.86;
        if (d < need) {
          const push = (need - d) / d;
          const wa = weight(a), wb = weight(b);
          const total = wa + wb;
          a.center = [Math.round(a.center[0] - dx * push * (wa / total)), Math.round(a.center[1] - dy * push * (wa / total))];
          b.center = [Math.round(b.center[0] + dx * push * (wb / total)), Math.round(b.center[1] + dy * push * (wb / total))];
          worst = true;
        }
      }
    }
    for (const z of zones) {
      z.center[0] = Math.max(z.radius + 2, Math.min(W - z.radius - 2, z.center[0]));
      z.center[1] = Math.max(z.radius + 2, Math.min(H - z.radius - 2, z.center[1]));
    }
    if (!worst) break;
  }
  // 兜底：仍重叠者按优先级收缩低者半径
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      const a = zones[i], b = zones[j];
      let d, need;
      for (let guard = 0; guard < 12; guard += 1) {
        d = Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]);
        need = (a.radius + b.radius) * 0.86;
        if (d >= need) break;
        const victim = (a.priority || 5) <= (b.priority || 5) ? b : a;
        victim.radius = Math.max(8, victim.radius - 2);
      }
    }
  }
}

function planPois({ kb, zones, rng }) {
  const nodes = [];
  const edges = [];
  const kindByRole = { spawn: 'base', hub: 'altar', arena: 'core', resource: 'ore', boss: 'boss', shop: 'shop', objective: 'objective', transition: 'checkpoint' };
  for (const z of zones) {
    const kind = z.role === 'spawn' ? (kb.poiKinds.includes('bed') ? 'bed' : 'base') : (kb.poiKinds.includes(kindByRole[z.role]) ? kindByRole[z.role] : kindByRole[z.role] || 'poi');
    nodes.push({ id: `p_${z.id}`, zone: z.id, pos: [z.center[0], 0, z.center[1]], kind });
    if (z.role === 'shop') nodes.push({ id: `p_${z.id}_npc`, zone: z.id, pos: [z.center[0] + 3, 0, z.center[1] + 3], kind: 'shopkeeper' });
  }
  // 边：zone 邻接 → path
  const zid = new Map(zones.map((z) => [z.id, z]));
  for (const z of zones) for (const a of z.adjacency) {
    if (zid.has(a)) edges.push({ a: `p_${z.id}`, b: `p_${a}`, kind: 'path' });
  }
  // 团队对称区加传送边（跑图 >90s 时）
  const spawns = zones.filter((z) => z.role === 'spawn');
  if (spawns.length > 2) spawns.slice(1).forEach((s, i) => edges.push({ a: `p_${spawns[0].id}`, b: `p_${s.id}`, kind: 'portal' }));
  return { nodes, edges };
}

/* ================= fun 自评 ================= */
function funScore({ gdd, kb, W, H }) {
  const zones = gdd.zones;
  const clarity = Math.min(100, 40 + zones.length * 6 + gdd.terrain.landmarkSilhouettes.length * 8);
  // pacing：按 POI 邻接边估算实际路线时间（对称图不量跨图直线）
  const target = (kb.pacing.routeSeconds[0] + kb.pacing.routeSeconds[1]) / 2;
  const nodeById = new Map(gdd.poiGraph.nodes.map((n) => [n.id, n]));
  let sumD = 0, n = 0;
  for (const e of gdd.poiGraph.edges) {
    const a = nodeById.get(e.a), b = nodeById.get(e.b);
    if (!a || !b) continue;
    sumD += Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]); n += 1;
  }
  const avgD = n ? sumD / n : Math.min(W, H) / 3;
  const estSec = avgD / 3.2; // ~3.2 格/秒 步行+绕路
  const pacing = Math.max(20, Math.min(100, 100 - Math.abs(estSec - target) * 2.2));
  // balance：队伍区对称误差
  const spawns = zones.filter((z) => z.role === 'spawn');
  let balance = 100;
  if (spawns.length >= 2) {
    const c = [W / 2, H / 2];
    const errs = spawns.map((s) => Math.hypot(s.center[0] - c[0], s.center[1] - c[1]));
    balance = Math.max(20, 100 - (Math.max(...errs) - Math.min(...errs)) * 2.5);
  }
  const depth = Math.min(100, 35 + gdd.loop.economy.length * 12 + gdd.loop.phases.length * 7 + (kb.pacing.shrink ? 10 : 0));
  const notes = [];
  if (clarity < 70) notes.push('地标或分区数不足：补充 1-2 个轮廓地标');
  if (pacing < 70) notes.push(`路径节奏偏差（估 ${Math.round(estSec)}s vs 目标 ${target}s）：调整 zone 半径/间距`);
  if (balance < 70) notes.push('队伍区不对称：收紧出生环半径公差');
  if (depth < 70) notes.push('玩法深度不足：增加经济链或阶段目标');
  return { scores: { clarity: Math.round(clarity), pacing: Math.round(pacing), balance: Math.round(balance), depth: Math.round(depth) }, notes };
}

/* ================= 主入口 ================= */
export function generateGDD(input = {}) {
  const genreName = input.genre ? matchGenre(input.genre) || matchGenre(input.genreName || '') : null;
  if (!genreName) throw new Error(`unknown genre: ${input.genre || input.genreName || '(空)'}；支持：${Object.keys(GenreKB).join('/')}`);
  const kb = GenreKB[genreName];
  const W = input.mapSize?.[0] || 256;
  const H = input.mapSize?.[1] || 256;
  const seed = input.seed || 20261025;
  const rng = mulberry(seed);
  const teams = Math.min(4, Math.max(2, input.players?.teams || (kb.spatialPattern.includes('symmetric') || kb.spatialPattern.includes('archipelago') ? 4 : 2)));
  const zones = planZones({ kb, W, H, teams, rng });
  const poiGraph = planPois({ kb, zones, rng });
  const biomePalette = [...new Set(zones.map((z) => z.biome))].map((b) => ({ biome: b, blocks: BIOME_BLOCKS[b] || { top: 'grass', sub: 'dirt', base: 'stone' }, density: 0.18 + rng() * 0.15 }));
  const gdd = {
    version: 'GDD/0.1',
    id: input.id || `${genreName}-${W}x${H}`.replace(/\s+/g, '-'),
    name: input.name || `${genreName}·${kb.themeKeywords[0]}`,
    genre: genreName,
    themeKeywords: kb.themeKeywords,
    artStyle: kb.artStyle,
    mapSize: [W, H],
    heightBudget: input.heightBudget || 64,
    seed,
    players: { count: input.players?.count || teams * 4, teams },
    loop: kb.loop,
    zones,
    poiGraph,
    terrain: { ...kb.terrain, biomePalette, water: { level: 8, bodies: kb.terrain.continentProfile === 'archipelago' ? 0 : 2 } },
    ui: {
      screens: [{ id: 'hud', purpose: '战斗主界面' }, ...(kb.systems.some((s) => s.ui.includes('shopGrid')) ? [{ id: 'shop', purpose: '商店弹窗' }] : [])],
      components: [...new Set([...kb.hud, ...kb.systems.flatMap((s) => s.ui)])].map((kind) => ({ kind, bindings: {} })),
      density: input.uiDensity || 'medium',
      criticalInfo: kb.hud.slice(0, 3),
    },
    models: [...kb.models, ...kb.systems.flatMap((s) => s.models)],
    fun: { scores: {}, notes: [] },
  };
  // fun 自评 + 自动重试（微调 zone 半径±5% 影响有限，主要是确认结构健康）
  for (let round = 0; round < 3; round += 1) {
    gdd.fun = funScore({ gdd, kb, W, H });
    const min = Math.min(...Object.values(gdd.fun.scores));
    if (min >= 70) break;
    // 确定性微调：pacing 偏大→收缩非核心区半径；balance 偏低→出生区贴环
    if (gdd.fun.scores.pacing < 70) for (const z of gdd.zones) if (z.role !== 'spawn') z.radius = Math.round(z.radius * 1.06);
    if (gdd.fun.scores.balance < 70) {
      const c = [W / 2, H / 2];
      const spawns = gdd.zones.filter((z) => z.role === 'spawn');
      const rAvg = spawns.reduce((s, z) => s + Math.hypot(z.center[0] - c[0], z.center[1] - c[1]), 0) / Math.max(1, spawns.length);
      for (const z of spawns) {
        const ang = Math.atan2(z.center[1] - c[1], z.center[0] - c[0]);
        z.center = [Math.round(c[0] + Math.cos(ang) * rAvg), Math.round(c[1] + Math.sin(ang) * rAvg)];
      }
    }
  }
  return gdd;
}
export { matchGenre };

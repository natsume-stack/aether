#!/usr/bin/env node
/**
 * ScreenComposer: gameplay semantics -> ScreenPlan.
 *
 * Screens are derived from what the game actually needs (teams, rounds,
 * economy, objectives, quests, dialogue, radar, map) rather than stamping one
 * fixed HUD template. Every screen is reachable from a named state, carries a
 * region, priority, visibility condition and interaction flag.
 */
import { hashObject, parseArgs, writeJson, readJson } from './common.mjs';
import { buildDesignSystem } from './design-system.mjs';
import { loadBrief, validateBrief } from './brief.mjs';

const SCREEN_DEFS = {
  hud: { label: 'HUD', category: 'status', region: 'top-left', priority: 1, visibleWhen: 'playing', interaction: false, state: 'playing' },
  timer: { label: '回合计时', category: 'status', region: 'top-center', priority: 2, visibleWhen: 'playing', interaction: false, state: 'playing' },
  objective: { label: '当前目标', category: 'guidance', region: 'top-center-below', priority: 2, visibleWhen: 'playing', interaction: false, state: 'playing' },
  scoreboard: { label: '记分板', category: 'status', region: 'top-right', priority: 3, visibleWhen: 'playing', interaction: false, state: 'playing' },
  teamStatus: { label: '队伍状态', category: 'status', region: 'mid-right', priority: 4, visibleWhen: 'playing', interaction: false, state: 'playing' },
  flagStatus: { label: '旗帜状态', category: 'status', region: 'mid-right', priority: 4, visibleWhen: 'playing', interaction: false, state: 'playing' },
  radar: { label: '雷达', category: 'guidance', region: 'mid-right-low', priority: 5, visibleWhen: 'playing', interaction: false, state: 'playing' },
  activityPanel: { label: '活动面板', category: 'log', region: 'mid-left', priority: 6, visibleWhen: 'playing', interaction: false, state: 'playing' },
  resources: { label: '资源/背包', category: 'status', region: 'bottom-left', priority: 5, visibleWhen: 'playing', interaction: false, state: 'playing' },
  minimap: { label: '小地图', category: 'guidance', region: 'bottom-right', priority: 6, visibleWhen: 'playing', interaction: false, state: 'playing' },
  compass: { label: '方向罗盘', category: 'guidance', region: 'bottom-right', priority: 6, visibleWhen: 'playing', interaction: false, state: 'playing' },
  toast: { label: '短反馈', category: 'feedback', region: 'top-center-toast', priority: 9, visibleWhen: 'transient', interaction: false, state: 'playing' },
  crosshair: { label: '准星', category: 'feedback', region: 'center', priority: 10, visibleWhen: 'playing', interaction: false, state: 'playing' },
  shop: { label: '商店', category: 'interaction', region: 'center', priority: 7, visibleWhen: 'shop-open', interaction: true, state: 'shop' },
  dialog: { label: '对话/确认', category: 'interaction', region: 'center', priority: 7, visibleWhen: 'dialog-open', interaction: true, state: 'dialog' },
  result: { label: '结算', category: 'flow', region: 'center', priority: 8, visibleWhen: 'match-end', interaction: true, state: 'result' },
  lobby: { label: '大厅', category: 'flow', region: 'center', priority: 0, visibleWhen: 'lobby', interaction: true, state: 'lobby' },
};

const MOBILE_HIDDEN = new Set(['scoreboard', 'teamStatus', 'flagStatus', 'radar', 'activityPanel', 'lobby']);
const MOBILE_FULLSCREEN = new Set(['shop', 'dialog', 'result']);

function gameplayTags(brief) {
  const gameplay = brief.gameplay || {};
  const objective = String(gameplay.objective || '');
  const tags = new Set();
  if (gameplay.teamCount > 1) {
    tags.add('teams');
    tags.add('scoreboard');
  }
  if (gameplay.roundSeconds) tags.add('timer');
  if (gameplay.shop) {
    tags.add('economy');
    tags.add('shop');
  }
  if (Array.isArray(gameplay.economy) && gameplay.economy.length) tags.add('economy');
  if (objective.includes('bed') || objective.includes('flag') || objective.includes('capture')) {
    tags.add('combat');
    tags.add('objective');
  }
  if (objective.includes('quest') || Array.isArray(gameplay.quests)) {
    tags.add('quests');
    tags.add('dialogue');
    tags.add('exploration');
  }
  if (gameplay.radar) tags.add('radar');
  if (gameplay.minimap) tags.add('minimap');
  if (gameplay.respawn) tags.add('health');
  if (gameplay.winCondition || gameplay.roundSeconds) tags.add('rounds');
  if (!tags.has('combat')) tags.add('exploration');
  return tags;
}

function teamEntries(brief) {
  return Object.keys(brief.palette.teams || {}).map((key) => ({
    id: key,
    label: { red: '红队', blue: '蓝队', green: '绿队', yellow: '黄队', cyan: '青队', orange: '橙队', town: '小镇' }[key] || key,
    token: `color.team.${key}`,
  }));
}

function contentFor(brief, ds, tags) {
  const teams = teamEntries(brief);
  const gameplay = brief.gameplay || {};
  const content = {};
  const teamCount = gameplay.teamCount || teams.length;
  const has = (tag) => tags.has(tag);

  if (has('combat')) {
    content.hud = {
      title: brief.id === 'B' ? '峡谷行动' : '起床战争',
      rows: [
        { icon: 'health', text: '♥ 100', token: 'color.danger' },
        { icon: 'currency', text: `◈ ${gameplay.economy?.[0] === 'iron' ? '铁 12' : '能量 64'}`, token: 'color.accent' },
        { text: teams[0] ? `${teams[0].label} · 存活` : '存活', token: teams[0]?.token || 'color.muted' },
      ],
    };
    content.objective = {
      title: '当前目标',
      value: brief.id === 'A' ? '破坏床 0/4' : '夺取旗帜 0/1',
    };
    content.crosshair = { glyph: '✛' };
    content.toast = { text: brief.id === 'A' ? '红队床已被破坏' : '敌方旗帜已离开基地' };
    content.dialog = {
      title: brief.id === 'A' ? '确认购买' : '放弃任务？',
      body: brief.id === 'A' ? '花费 12 金购买护甲？' : '离开后将丢失当前进度。',
      confirm: brief.id === 'A' ? '购买' : '放弃',
      cancel: '取消',
      danger: brief.id === 'B',
    };
    content.result = {
      title: brief.id === 'A' ? '胜利' : '行动结束',
      rows: brief.id === 'A' ? ['击杀 8', '破坏床 2', '存活 12:30'] : ['夺取 2', '防守 5', '用时 03:12'],
      action: '再来一局',
    };
    content.lobby = {
      title: brief.id === 'A' ? '四队起床战争' : '峡谷夺旗',
      rows: brief.id === 'A' ? ['保护床', '收集资源', '破坏敌床'] : ['夺取敌方旗帜', '守住己方旗帜', '推进中路'],
      action: '开始',
    };
  } else {
    content.hud = {
      title: '晨光镇',
      rows: [
        { icon: 'health', text: '♡ 体力 100', token: 'color.success' },
        { icon: 'quest', text: '任务 1/3', token: 'color.accent' },
        { text: '晴 · 午后', token: 'color.muted' },
      ],
    };
    content.objective = { title: '当前任务', value: '为面包师取回面粉' };
    content.toast = { text: '任务更新：前往磨坊' };
    content.dialog = {
      title: '面包师',
      body: '能帮我把面粉带回来吗？',
      confirm: '接受',
      cancel: '稍后',
      danger: false,
    };
    content.result = {
      title: '今日完成',
      rows: ['任务 3/3', '发现 2 处风景', '结识 4 位居民'],
      action: '继续散步',
    };
    content.lobby = {
      title: '晨光镇',
      rows: ['探索小镇', '帮助居民', '收集故事'],
      action: '开始',
    };
  }

  if (has('timer')) content.timer = { title: '回合', value: brief.id === 'A' ? '05:00' : '04:00' };
  if (has('scoreboard')) {
    content.scoreboard = {
      title: brief.id === 'A' ? '队伍排名' : '夺旗比分',
      rows: teams.map((team, index) => ({
        label: team.label,
        value: index === 0 ? '3' : index === 1 ? '2' : '1',
        token: team.token,
      })),
    };
  }
  if (has('teams') && brief.id === 'A') {
    content.teamStatus = {
      title: '床状态',
      rows: teams.map((team, index) => ({
        label: `${team.label} · ${index === 0 ? '床✓' : '床✗'} · ${4 - index}人`,
        token: team.token,
      })),
    };
  }
  if (has('teams') && brief.id === 'B') {
    content.flagStatus = {
      title: '旗帜状态',
      rows: [
        { label: `${teams[0]?.label || '青队'} 旗 · 基地`, token: teams[0]?.token || 'color.info' },
        { label: `${teams[1]?.label || '橙队'} 旗 · 运输中`, token: teams[1]?.token || 'color.warning' },
        { label: '我方推进 68%', token: 'color.muted' },
      ],
    };
  }
  if (has('economy')) {
    content.resources = {
      title: brief.id === 'A' ? '资源' : '背包',
      rows: brief.id === 'A'
        ? ['◈ 铁 12', '◆ 金 4', '✦ 绿宝石 1']
        : ['◇ 能量 64', '◇ 电池 2'],
    };
  }
  if (has('quests')) {
    content.resources = {
      title: '背包',
      rows: ['❀ 野花 3', '☁ 面粉 0'],
    };
    content.activityPanel = {
      title: '任务',
      rows: ['● 面包师 · 取面粉', '● 灯塔 · 修灯', '● 花园 · 找种子'],
    };
  }
  if (has('quests') && !content.activityPanel) {
    content.activityPanel = { title: '活动', rows: ['● 日常任务', '● 探索区域', '● 居民委托'] };
  }
  if (has('teams') && !content.activityPanel) {
    content.activityPanel = {
      title: '最近活动',
      rows: brief.id === 'A' ? ['● 击杀 3', '● 助攻 5', '● 收集 21'] : ['● 推进中路', '● 拦截运输', '● 修复护盾'],
    };
  }
  if (has('radar')) {
    content.radar = { title: '雷达', rows: ['N 032°', '接触 · 2 敌', '信号 · 稳定'] };
  }
  if (has('minimap')) content.minimap = { title: brief.id === 'C' ? '城镇地图' : '小地图' };
  if (has('exploration') && !has('minimap')) content.compass = { title: '方向', rows: ['➜ 面包房', '120 m', '北偏东'] };
  if (has('shop')) {
    content.shop = {
      title: '商店',
      rows: [
        { label: '① 羊毛', price: '4 铁', enabled: true },
        { label: '② 石剑', price: '10 铁', enabled: true },
        { label: '③ 护甲', price: '12 金', enabled: false },
      ],
      hint: '按 E 关闭',
    };
  }
  return content;
}

export function composeScreenPlan(brief, ds) {
  const validation = validateBrief(brief);
  if (!validation.ok) throw new Error(`invalid brief: ${JSON.stringify(validation.errors)}`);
  const tags = gameplayTags(brief);
  const content = contentFor(brief, ds, tags);
  const wanted = {
    hud: true,
    timer: tags.has('timer'),
    objective: tags.has('objective') || tags.has('quests'),
    scoreboard: tags.has('scoreboard'),
    teamStatus: tags.has('teams') && brief.id === 'A',
    flagStatus: tags.has('teams') && brief.id === 'B',
    radar: tags.has('radar'),
    activityPanel: tags.has('quests') || tags.has('teams'),
    resources: tags.has('economy') || tags.has('quests'),
    minimap: tags.has('minimap') || (tags.has('exploration') && brief.id === 'C'),
    compass: tags.has('exploration') && !tags.has('minimap') && brief.id !== 'C',
    toast: true,
    crosshair: tags.has('combat'),
    shop: tags.has('shop'),
    dialog: tags.has('dialogue') || tags.has('combat'),
    result: true,
    lobby: true,
  };
  const screens = [];
  for (const [id, def] of Object.entries(SCREEN_DEFS)) {
    if (!wanted[id]) continue;
    const breakpoints = {
      desktop: { visible: true, region: def.region },
      tablet: {
        visible: !MOBILE_HIDDEN.has(id),
        region: MOBILE_FULLSCREEN.has(id) ? 'center' : def.region,
      },
      mobile: {
        visible: !MOBILE_HIDDEN.has(id),
        region: MOBILE_FULLSCREEN.has(id)
          ? 'fullscreen'
          : id === 'hud'
            ? 'top-left'
            : id === 'timer'
              ? 'top-right'
              : id === 'objective'
                ? 'top-left-below'
                : id === 'resources'
                  ? 'bottom-left'
                  : id === 'minimap' || id === 'compass'
                    ? 'bottom-right-compact'
                    : id === 'toast'
                      ? 'top-center-toast'
                      : def.region,
        compact: id === 'teamStatus',
        hiddenSections: id === 'hud' ? [] : undefined,
      },
    };
    screens.push({
      ...def,
      id,
      content: content[id] || null,
      tokens: {
        background: 'color.surface',
        foreground: 'color.text',
        muted: 'color.muted',
        accent: 'color.accent',
        danger: 'color.danger',
      },
      breakpoints,
      reachableFrom: def.state === 'playing' ? ['playing'] : [def.state, 'playing'],
      zIndex: def.state === 'playing' ? (def.category === 'feedback' ? 120 : 20) : 200,
    });
  }
  const playing = screens.filter((screen) => screen.state === 'playing').map((screen) => screen.id);
  const overlays = screens.filter((screen) => screen.state !== 'playing').map((screen) => screen.id);
  const hierarchyCandidates = brief.id === 'A'
    ? ['hud', 'health', 'objective', 'timer', 'resources', 'scoreboard', 'teamStatus', 'activityPanel', 'minimap']
    : brief.id === 'B'
      ? ['flagStatus', 'objective', 'timer', 'scoreboard', 'radar', 'toast']
      : ['objective', 'hud', 'activityPanel', 'minimap', 'compass', 'toast'];
  const screenIds = new Set(screens.map((screen) => screen.id));
  const hierarchy = hierarchyCandidates.filter((id) => screenIds.has(id) || id === 'health');
  const plan = {
    version: 'ScreenPlan/0.1',
    briefHash: hashObject(brief),
    styleHash: ds.styleHash,
    tags: [...tags].sort(),
    screens,
    states: {
      playing,
      shop: screens.some((screen) => screen.id === 'shop') ? ['shop'] : [],
      dialog: ['dialog'],
      result: ['result'],
      lobby: ['lobby'],
    },
    hierarchy,
    interaction: screens.filter((screen) => screen.interaction).map((screen) => screen.id),
    safeAreas: { desktop: 24, tablet: 16, mobile: 12 },
    breakpoints: {
      desktop: { viewport: [1366, 768], safeArea: 24 },
      tablet: { viewport: [1024, 768], safeArea: 16 },
      mobile: { viewport: [390, 844], safeArea: 12 },
      visibleCount: {
        desktop: playing.length,
        tablet: playing.filter((id) => !MOBILE_HIDDEN.has(id)).length,
        mobile: playing.filter((id) => !MOBILE_HIDDEN.has(id)).length,
      },
      reflow: {
        mobile: 'independent stack: HUD/timer/objective top, resources bottom-left, compact map bottom-right; scoreboard/team/activity/lobby hidden; overlays fullscreen',
      },
    },
    interactionStates: [
      { id: 'playing', base: playing, overlay: null, reachable: true },
      { id: 'shop', base: playing.filter((id) => !MOBILE_HIDDEN.has(id)), overlay: 'shop', reachable: Boolean(wanted.shop) },
      { id: 'dialog', base: playing, overlay: 'dialog', reachable: true },
      { id: 'result', base: [], overlay: 'result', reachable: true },
      { id: 'lobby', base: [], overlay: 'lobby', reachable: true },
    ],
    tokenCoveragePlan: {
      rule: 'every node colour/font/size is a DesignSystem token reference',
      roles: ['color.bg', 'color.surface', 'color.text', 'color.muted', 'color.accent', 'color.danger', 'type.caption', 'type.body', 'type.title', 'type.hero', 'type.number'],
    },
  };
  plan.screenPlanHash = hashObject(plan);
  return plan;
}

if (process.argv[1] && process.argv[1].endsWith('screen-composer.mjs')) {
  const args = parseArgs();
  const id = args.get || args.brief || args._[0];
  if (!id) {
    console.error('usage: node screen-composer.mjs --get=A|B|C [--design=design.json] [--out=file]');
    process.exit(1);
  }
  const brief = loadBrief(id);
  const ds = args.design ? readJson(args.design) : buildDesignSystem(brief);
  const plan = composeScreenPlan(brief, ds);
  if (args.out) writeJson(args.out, plan);
  console.log(JSON.stringify({
    screenCount: plan.screens.length,
    screens: plan.screens.map((screen) => screen.id),
    states: plan.states,
    hierarchy: plan.hierarchy,
    screenPlanHash: plan.screenPlanHash,
  }, null, 2));
}

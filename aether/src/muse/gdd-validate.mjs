/**
 * gdd-validate.mjs — GDD/0.1 schema 校验器（下游共同信任的守门人）
 */
const ROLES = ['spawn', 'hub', 'arena', 'resource', 'boss', 'shop', 'objective', 'transition'];
const ART_STYLES = ['pixel', 'ink', 'hitech', 'cozy', 'horror'];
const PROFILES = ['archipelago', 'continent', 'island-ring', 'canyon'];
const UI_KINDS = ['hotbar', 'hearts', 'armorBar', 'hunger', 'xpBar', 'nameplate', 'bossbar', 'killfeed', 'minimapFrame', 'scoreboard', 'timer', 'teamScore', 'crosshair', 'toast', 'dialog', 'shopGrid', 'buffRow', 'ammoCounter', 'joystick', 'jumpBtn'];

export function validateGDD(gdd) {
  const errors = [];
  const warn = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(gdd.version === 'GDD/0.1', 'version 必须为 GDD/0.1');
  need(typeof gdd.id === 'string' && gdd.id.length > 0, 'id 缺失');
  need(typeof gdd.genre === 'string', 'genre 缺失');
  need(ART_STYLES.includes(gdd.artStyle), `artStyle 非法: ${gdd.artStyle}`);
  need(Array.isArray(gdd.mapSize) && gdd.mapSize.length === 2 && gdd.mapSize.every((v) => v >= 64), 'mapSize 非法（≥64）');
  need(Number.isInteger(gdd.seed), 'seed 缺失');
  need(gdd.players && gdd.players.teams >= 1, 'players.teams 缺失');
  need(Array.isArray(gdd.zones) && gdd.zones.length >= 2, 'zones 至少 2 个');
  need(gdd.loop && Array.isArray(gdd.loop.phases), 'loop.phases 缺失');
  need(gdd.poiGraph && Array.isArray(gdd.poiGraph.nodes), 'poiGraph.nodes 缺失');
  need(gdd.terrain && PROFILES.includes(gdd.terrain.continentProfile), `continentProfile 非法: ${gdd.terrain?.continentProfile}`);
  need(Array.isArray(gdd.terrain.biomePalette) && gdd.terrain.biomePalette.length >= 2, 'biomePalette 至少 2 个');
  need(gdd.ui && Array.isArray(gdd.ui.components) && gdd.ui.components.length >= 4, 'ui.components 至少 4 个');
  need(Array.isArray(gdd.models) && gdd.models.length >= 1, 'models 至少 1 个');

  const [W, H] = gdd.mapSize || [0, 0];
  const zoneIds = new Set();
  for (const z of gdd.zones || []) {
    need(typeof z.id === 'string' && !zoneIds.has(z.id), `zone id 重复/缺失: ${z.id}`);
    zoneIds.add(z.id);
    need(ROLES.includes(z.role), `zone ${z.id} role 非法: ${z.role}`);
    need(Array.isArray(z.center) && z.center[0] >= 0 && z.center[0] < W && z.center[1] >= 0 && z.center[1] < H, `zone ${z.id} center 越界: ${JSON.stringify(z.center)}`);
    need(z.radius > 4 && z.radius < Math.min(W, H) / 2, `zone ${z.id} radius 非法: ${z.radius}`);
  }
  // 圆不重叠（允许 15% 缓冲重叠：玩法上过渡带可以交叠）
  const overlapPairs = [];
  for (let i = 0; i < (gdd.zones || []).length; i += 1) {
    for (let j = i + 1; j < (gdd.zones || []).length; j += 1) {
      const a = gdd.zones[i], b = gdd.zones[j];
      const d = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
      const minD = (a.radius + b.radius) * 0.85;
      if (d < minD) overlapPairs.push(`${a.id}~${b.id}(d=${Math.round(d)},need=${Math.round(minD)})`);
    }
  }
  if (overlapPairs.length) errors.push(`zone 重叠: ${overlapPairs.join(' ')}`);
  // poiGraph 引用合法
  const nodeIds = new Set((gdd.poiGraph?.nodes || []).map((n) => n.id));
  for (const e of gdd.poiGraph?.edges || []) need(nodeIds.has(e.a) && nodeIds.has(e.b), `edge 引用非法: ${e.a}->${e.b}`);
  for (const n of gdd.poiGraph?.nodes || []) need(zoneIds.has(n.zone), `node ${n.id} zone 引用非法: ${n.zone}`);
  // ui 组件 kind 合法
  for (const c of gdd.ui?.components || []) need(UI_KINDS.includes(c.kind), `ui 组件非法: ${c.kind}`);
  // models 尺寸提示
  for (const m of gdd.models || []) need(Array.isArray(m.sizeHint) && m.sizeHint.length === 3, `model ${m.name} sizeHint 非法`);
  // 有意提醒（不阻塞）
  if ((gdd.zones || []).filter((z) => z.role === 'spawn').length < gdd.players?.teams) warn.push('spawn 区数量少于队伍数');
  if ((gdd.terrain?.rivers || 0) > 0 && !gdd.terrain.biomePalette.some((b) => /河|谷|水/.test(b.biome))) warn.push('有河流但无水域系生物群系');
  return { ok: errors.length === 0, errors, warnings: warn, zoneCount: (gdd.zones || []).length, poiCount: nodeIds.size };
}

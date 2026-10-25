/**
 * prism-bridge.mjs — UI 套系 → 引擎 UI 节点计划桥 (UIBridge/0.1)
 *
 * 把布局求解结果翻译成 edit runtime uiNodeAdd 可表达的节点（--apply 时真写入，
 * 默认 dry-run 只打印计划）。引擎当前节点模型为 element+text（背景色+文本），
 * 因此策略：面板/格子→带主题底色的 element，图标/条→element 色块近似，
 * 文本→text；每个降级点记录到 degradations，供后续引擎能力扩展后精化。
 */
import http from 'node:http';

const EDIT = 'http://127.0.0.1:10080';
const ACTOR = 'cli:ui-theme-bridge';

function resolveColor(role, theme) {
  if (!role) return null;
  if (role.startsWith('teams.')) return theme.teams[Number(role.split('.')[1]) || 0];
  return theme.palette[role] || null;
}
function hexToRgba(hex, alpha = 1) {
  if (!hex || !hex.startsWith('#') || hex.length !== 7) return hex || null;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 布局 → 节点计划（每组件一组节点，保持组件级命名便于整组替换/删除） */
export function toNodePlan({ layout, gdd }) {
  const theme = layout.theme;
  const nodes = [];
  const degradations = [];
  const rootName = (gdd?.id || 'hud');
  let seq = 0;
  for (const [kind, place] of Object.entries(layout.placements)) {
    if (place.hidden) continue;
    for (const prim of place.built.prims || []) {
      const id = `${rootName}_${kind}_${seq++}`;
      const base = {
        name: id,
        position: [place.x + prim.x, place.y + prim.y],
        size: [prim.w, prim.h],
        tags: ['uiSuite', rootName, kind],
      };
      switch (prim.t) {
        case 'rect':
        case 'circle':
          nodes.push({ ...base, nodeType: 'element', backgroundColor: hexToRgba(resolveColor(prim.fill, theme), prim.alpha ?? 1) });
          break;
        case 'slot':
          nodes.push({ ...base, nodeType: 'element', backgroundColor: prim.selected ? hexToRgba(theme.palette.slotSelected, 0.35) : hexToRgba(theme.palette.slot, 0.9), borderColor: theme.palette.border, borderWidth: theme.border.size });
          break;
        case 'bar':
          nodes.push({ ...base, nodeType: 'element', backgroundColor: hexToRgba(theme.palette.panelBgAlt, 0.9) });
          nodes.push({ ...base, name: id + '_fill', position: [base.position[0] + 1, base.position[1] + 1], size: [Math.max(1, Math.round((prim.w - 2) * prim.pct)), prim.h - 2], tags: base.tags, nodeType: 'element', backgroundColor: resolveColor(prim.fill, theme) });
          break;
        case 'icon':
          degradations.push({ id, from: 'bitmap icon', to: '色块近似' });
          nodes.push({ ...base, nodeType: 'element', backgroundColor: hexToRgba(prim.state === 'empty' ? theme.palette.slot : (prim.icon === 'heart' ? theme.palette.danger : theme.palette.text), prim.state === 'half' ? 0.55 : 0.95) });
          break;
        case 'text':
          nodes.push({ ...base, nodeType: 'element', backgroundColor: null, text: String(prim.text), fontSize: Math.round(prim.size), color: resolveColor(prim.color, theme) });
          break;
        case 'button':
          nodes.push({ ...base, nodeType: 'element', backgroundColor: prim.primary ? theme.palette.accent : theme.palette.panelBgAlt, text: prim.label, fontSize: Math.round(prim.h * 0.42), color: prim.primary ? '#14141c' : theme.palette.text });
          break;
        case 'crosshair':
          nodes.push({ ...base, nodeType: 'element', backgroundColor: null, text: '+', fontSize: Math.round(prim.h * 0.8), color: theme.palette.accent });
          degradations.push({ id, from: '准星图形', to: '文本 +' });
          break;
        default:
          break;
      }
    }
  }
  return { nodes, degradations, layout: layout.profileId, theme: theme.id };
}

function callEdit(tool, args) {
  const data = Buffer.from(JSON.stringify({ tool, args, actor: ACTOR }));
  return new Promise((resolve, reject) => {
    const req = http.request(`${EDIT}/internal/ai-tool`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** 应用到引擎：清 uiSuite 组节点 → 逐节点 uiNodeAdd → uiValidate */
export async function applyToEngine({ plan, wipeSuite = true, validate = true }) {
  const results = { removed: 0, added: 0, errors: [] };
  if (wipeSuite) {
    const tree = await callEdit('uiTreeRead', {});
    for (const node of tree.result?.nodes || []) {
      if ((node.tags || []).includes('uiSuite')) {
        await callEdit('uiNodeRemove', { name: node.name });
        results.removed += 1;
      }
    }
  }
  for (const n of plan.nodes) {
    const r = await callEdit('uiNodeAdd', {
      name: n.name, nodeType: n.nodeType, position: n.position, size: n.size,
      backgroundColor: n.backgroundColor || undefined, borderColor: n.borderColor, borderWidth: n.borderWidth,
      text: n.text, fontSize: n.fontSize, color: n.color, tags: n.tags,
    });
    if (r.code || r.result?.success === false) results.errors.push(`${n.name}: ${r.result?.error || r.message}`);
    else results.added += 1;
  }
  if (validate) {
    const v = await callEdit('uiValidate', {});
    results.validate = v.result || v;
  }
  return results;
}

/* CLI: node prism-bridge.mjs <gdd.json> [desktop|laptop|mobile] [--apply] */
if (process.argv[1] && process.argv[1].endsWith('prism-bridge.mjs')) {
  const { readJson } = await import('../shared/common.mjs');
  const { solveLayout } = await import('./prism-layout.mjs');
  const gddPath = process.argv[2];
  const profileId = process.argv[3] || 'desktop';
  const apply = process.argv.includes('--apply');
  const gdd = readJson(gddPath);
  const layout = solveLayout({ gdd, profileId });
  const plan = toNodePlan({ layout, gdd });
  console.log(`plan: ${plan.nodes.length} nodes, ${plan.degradations.length} degradations (${plan.theme}/${plan.layout})`);
  if (apply) {
    const r = await applyToEngine({ plan });
    console.log('applied:', JSON.stringify(r).slice(0, 400));
  } else {
    console.log('dry-run 示例前 5 节点:');
    for (const n of plan.nodes.slice(0, 5)) console.log(' ', JSON.stringify(n));
  }
}

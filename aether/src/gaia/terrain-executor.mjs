#!/usr/bin/env node
/**
 * TerrainExecutor/0.1 — 把 TerrainPlan 翻译成 ai-tool 调用序列（可选执行器，默认 dry-run）。
 *
 * 调用顺序：terrainHeightmap（按行条带写高度场）→ terrainWater（湖）→
 * terrainRiver（逐条）→ terrainPath（逐段）→ terrainApply（散布分批）。
 * 写操作统一带 expectedRevision 乐观锁：冲突时 terrainRead 刷新后重试一次。
 *
 * 用法：
 *   node terrain-executor.mjs --plan plan.json                # dry-run，只打印调用计划
 *   node terrain-executor.mjs --plan plan.json --apply        # 真正执行
 *   node terrain-executor.mjs --plan plan.json --base http://127.0.0.1:10080 --actor terrain:bot
 *
 * 说明：ai-tool 各 terrain* 工具的参数 schema 以 runtime 实测为准；此处按
 * internal/ai-tool 通用信封 {tool, args, actor} 组包，高度数据用 0..255 量化整数。
 */
import { parseArgs, engineCall } from './common.mjs';
import { importPlanJson } from './terrain-engine.mjs';

const DEFAULT_BASE = 'http://127.0.0.1:10080';
const STRIP_ROWS = 64; // heightmap 每条带行数
const SCATTER_BATCH = 200;

/** 量化高度场 → 0..255 整数行主序 */
function quantizedRows(plan) {
  const [W, H] = plan.size;
  const rows = new Array(H);
  for (let y = 0; y < H; y += 1) {
    const row = new Array(W);
    for (let x = 0; x < W; x += 1) {
      row[x] = Math.max(0, Math.min(255, Math.round((plan.heightmap[y * W + x] / plan.heightBudget) * 255)));
    }
    rows[y] = row;
  }
  return rows;
}

/** TerrainPlan → [{tool, args, note}] 调用序列 */
export function buildExecutionPlan(plan) {
  const calls = [];
  const [W, H] = plan.size;
  calls.push({ tool: 'terrainRead', args: {}, note: '读取当前 revision', readOnly: true });

  const rows = quantizedRows(plan);
  for (let y0 = 0; y0 < H; y0 += STRIP_ROWS) {
    const rowCount = Math.min(STRIP_ROWS, H - y0);
    const data = [];
    for (let y = y0; y < y0 + rowCount; y += 1) data.push(...rows[y]);
    calls.push({
      tool: 'terrainHeightmap',
      args: { x: 0, y: y0, width: W, height: rowCount, format: 'u8', scale: plan.heightBudget, data },
      note: `高度场条带 y=${y0}..${y0 + rowCount - 1}（${data.length} 采样点）`,
    });
  }

  for (const lake of plan.lakes) {
    calls.push({
      tool: 'terrainWater',
      args: { cx: lake.pos[0], cy: lake.pos[1], radius: lake.radius, level: plan.waterLevel },
      note: `内陆湖 ${lake.id}`,
    });
  }

  for (const river of plan.rivers) {
    calls.push({
      tool: 'terrainRiver',
      args: { points: river.points, width: river.width },
      note: `河流 ${river.id}（${river.points.length} 折点, 宽 ${river.width}, ${river.mouth}）`,
    });
  }

  for (const path of plan.paths) {
    if (!path.found) continue;
    calls.push({
      tool: 'terrainPath',
      args: { points: path.points, width: 2 },
      note: `路径 ${path.a}→${path.b}（${path.points.length} 折点, 桥 ${path.bridges}）`,
    });
  }

  for (let i = 0; i < plan.scatter.length; i += SCATTER_BATCH) {
    const batch = plan.scatter.slice(i, i + SCATTER_BATCH).map((s) => ({ op: 'place', block: s.kind, at: [s.x, s.y, s.z] }));
    calls.push({
      tool: 'terrainApply',
      args: { ops: batch },
      note: `散布批次 ${i / SCATTER_BATCH + 1}（${batch.length} 个物体）`,
    });
  }
  return calls;
}

function argsBytes(args) {
  return Buffer.byteLength(JSON.stringify(args));
}

function printPlan(calls) {
  let totalBytes = 0;
  console.log('seq  tool               bytes   note');
  console.log('---  -----------------  ------  ------------------------------------');
  calls.forEach((c, i) => {
    const bytes = argsBytes(c.args);
    totalBytes += c.readOnly ? 0 : bytes;
    console.log(`${String(i).padStart(3)}  ${c.tool.padEnd(17)}  ${String(bytes).padStart(6)}  ${c.note}`);
  });
  const writes = calls.filter((c) => !c.readOnly).length;
  console.log(`\n共 ${calls.length} 个调用（写 ${writes}，预计上行 ~${(totalBytes / 1024).toFixed(0)} KB）`);
}

/** 执行写调用，revision 冲突自动刷新重试一次 */
async function execute(calls, base, actor) {
  let revision = null;
  let seq = 0;
  for (const call of calls) {
    seq += 1;
    if (call.readOnly) {
      const result = await engineCall(base, call.tool, call.args, actor);
      revision = result?.revision ?? result?.expectedRevision ?? revision;
      console.log(`[${seq}/${calls.length}] ${call.tool} → revision=${revision}`);
      continue;
    }
    const args = { ...call.args, expectedRevision: revision };
    try {
      await engineCall(base, call.tool, args, actor);
    } catch (err) {
      if (!/revision/i.test(String(err.message))) throw err;
      const fresh = await engineCall(base, 'terrainRead', {}, actor);
      revision = fresh?.revision ?? fresh?.expectedRevision ?? revision;
      await engineCall(base, call.tool, { ...call.args, expectedRevision: revision }, actor);
    }
    console.log(`[${seq}/${calls.length}] ${call.tool} ok  ${call.note}`);
  }
}

import { pathToFileURL } from 'node:url';

async function main() {
  const args = parseArgs();
  // 兼容 "--plan path" 空格传参（parseArgs 原生只支持 --key=value）
  if (args.plan === true && args._.length > 0) args.plan = args._[0];
  const planFile = args.plan;
  if (!planFile) {
    console.error('用法: node terrain-executor.mjs --plan <TerrainPlan.json> [--apply] [--base URL] [--actor id]');
    process.exit(1);
  }
  const { readJson } = await import('./common.mjs');
  const plan = importPlanJson(readJson(planFile));
  const calls = buildExecutionPlan(plan);
  if (!args.apply) {
    console.log(`[dry-run] TerrainPlan ${plan.id} seed=${plan.seed} → ${calls.length} 个 ai-tool 调用（加 --apply 实际执行）`);
    printPlan(calls);
    return;
  }
  const base = args.base || DEFAULT_BASE;
  const actor = args.actor || 'terrain-executor';
  await execute(calls, base, actor);
  console.log('执行完成。');
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}

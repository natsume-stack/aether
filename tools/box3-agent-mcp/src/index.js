#!/usr/bin/env node
/**
 * box3-agent-mcp entrypoint.
 *
 *   node src/index.js               start the MCP stdio server
 *   node src/index.js --tools-json  print tools/list and exit
 *   node src/index.js --config-json print the resolved (redacted) config
 *   node src/index.js --doctor      probe the map + VOXA live surfaces
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { AgentClient } from './client.js';
import { loadConfig } from './config.js';
import { publicTool, startStdioServer } from './server.js';
import { buildTools } from './tools.js';

export function buildContext(env = process.env) {
  const config = loadConfig(env);
  const client = new AgentClient(config);
  return { config, client };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const context = buildContext(env);

  if (argv.includes('--tools-json')) {
    const tools = buildTools(context.client, context.config).map(publicTool);
    process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
    return undefined;
  }
  if (argv.includes('--config-json')) {
    const diagnostics = context.client.diagnostics();
    process.stdout.write(
      `${JSON.stringify(
        {
          ...diagnostics,
          mapCode: context.config.mapCode ? `${context.config.mapCode.slice(0, 4)}…(redacted)` : '',
          voxaCode: context.config.voxaCode ? `${context.config.voxaCode.slice(0, 4)}…(redacted)` : '',
          mapToken: context.config.mapToken ? '(redacted)' : '',
          voxaToken: context.config.voxaToken ? '(redacted)' : '',
        },
        null,
        2,
      )}\n`,
    );
    return undefined;
  }
  if (argv.includes('--doctor')) {
    // A doctor that only prints configuration is useless: the two failure modes
    // that actually happen are "the join code was rotated" and "no editor tab is
    // open". Both are proven by making the real calls, so this does exactly that
    // and exits non-zero when a channel is unreachable.
    const report = { map: null, voxa: null };
    for (const kind of ['map', 'voxa']) {
      const stage = { join: null, status: null };
      try {
        const joined = await context.client.join(kind);
        stage.join = {
          ok: true,
          agentId: joined.agentId,
          fingerprint: joined.tokenFingerprint,
          projectId: joined.project?.id || null,
        };
      } catch (error) {
        stage.join = {
          ok: false,
          code: error.code,
          message: error.message,
          hint: error.hint,
        };
      }
      if (stage.join.ok) {
        try {
          stage.status = kind === 'map'
            ? await context.client.mapStatus()
            : await context.client.voxaStatus();
        } catch (error) {
          stage.status = {
            ok: false,
            code: error.code,
            message: error.message,
            hint: error.hint,
          };
        }
      }
      report[kind] = stage;
    }

    const attached = (value) => value && value.ok !== false && value.attached === true;
    const summary = {
      map: {
        reachable: report.map.join.ok,
        editorAttached: attached(report.map.status),
        next: attached(report.map.status)
          ? '可以直接开始：agent_observe → agent_look → agent_place'
          : '在 Creator 打开地图编辑器并保持标签页可见，然后重跑 --doctor',
      },
      voxa: {
        reachable: report.voxa.join.ok,
        editorAttached: attached(report.voxa.status),
        next: attached(report.voxa.status)
          ? '可以直接开始：voxa_observe → voxa_look → voxa_paint'
          : '在浏览器打开 VOXA 并保持标签页可见，然后重跑 --doctor',
      },
    };
    process.stdout.write(
      `${JSON.stringify({ diagnostics: context.client.diagnostics(), summary, report }, null, 2)}\n`,
    );
    const failed = !report.map.join.ok || !report.voxa.join.ok;
    if (failed) process.exitCode = 1;
    return report;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'box3-agent-mcp — 活体创作 MCP',
        '',
        '环境变量：',
        '  BOX_MAP_AGENT_BASE_URL   地图编辑器公开地址（如 https://box3.cdk.lat/edit 或 http://127.0.0.1:3127）',
        '  BOX_VOXA_AGENT_BASE_URL  VOXA 公开地址（如 http://127.0.0.1:3123）',
        '  BOX_MAP_AGENT_CODE       地图识别码（面板复制；与地址一起就是全部必需信息）',
        '  BOX_VOXA_AGENT_CODE      VOXA 识别码（面板复制）',
        '  BOX_MAP_PROJECT          可选：覆盖 project id（默认从 join 响应自动发现）',
        '  BOX_AGENT_NAME           agent 显示名（默认 zcode）',
        '  BOX_AGENT_WAIT_MS        单条命令等待回执（默认 30000）',
        '  BOX_AGENT_MIN_ACTION_MS  两条编辑命令最小间隔（默认 250，便于人看）',
        '  BOX_AGENT_ALLOW_WRITE    0/false = 只读',
        '',
        '子命令：--tools-json / --config-json / --doctor',
      ].join('\n') + '\n',
    );
    return undefined;
  }

  startStdioServer(context);
  return context;
}

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[box3-agent-mcp] ${error.stack || error.message}\n`);
    process.exit(1);
  });
}

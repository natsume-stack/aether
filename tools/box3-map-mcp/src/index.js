#!/usr/bin/env node
/**
 * box3-map-mcp entrypoint.
 *
 * Usage:
 *   node src/index.js                 start the MCP stdio server
 *   node src/index.js --tools-json    print the tools/list payload and exit
 *   node src/index.js --config-json   print the resolved (redacted) config
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { loadConfig, apiPath } from './config.js'
import { requestJson, tailEvents } from './engine-client.js'
import { LocalMapStore } from './local-store.js'
import { GuardError } from './script-write.js'
import { buildTools } from './tools.js'
import { publicTool, startStdioServer } from './server.js'
import { ENGINE_AI_TOOLS } from './tools/_shared.js'

export function buildContext(env = process.env) {
  const config = loadConfig(env)
  return {
    config,
    request: (spec) => requestJson(spec, config),
    tail: (spec) => tailEvents(spec, config),
    apiPath: (...segments) => apiPath(config, ...segments),
    store: new LocalMapStore(config.projectsRoot),
    guardError: (code, message, extra) => new GuardError(code, message, extra),
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

export function main(env = process.env, argv = process.argv.slice(2)) {
  const context = buildContext(env)
  if (argv.includes('--tools-json')) {
    // Same projection as `tools/list`, so the snapshot and the protocol can
    // never drift apart.
    const tools = buildTools(context).map(publicTool)
    process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`)
    return undefined
  }
  if (argv.includes('--coverage-json')) {
    const tools = buildTools(context)
    const names = tools.map((tool) => tool.name)
    process.stdout.write(
      `${JSON.stringify(
        {
          advertised: names.length,
          names,
          engineAiTools: ENGINE_AI_TOOLS.length,
          engineToolCoverage: ENGINE_AI_TOOLS.map((row) => ({
            ...row,
            advertised: names.includes(row.mcpTool),
          })),
        },
        null,
        2,
      )}\n`,
    )
    return undefined
  }
  if (argv.includes('--config-json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...context.config,
          cliToken: context.config.cliToken ? `${context.config.cliToken.slice(0, 4)}…(redacted)` : '',
          projectIdPattern: String(context.config.projectIdPattern),
          mapIdentityPattern: String(context.config.mapIdentityPattern),
        },
        null,
        2,
      )}\n`,
    )
    return undefined
  }
  startStdioServer(context)
  return context
}

if (invokedDirectly) {
  main()
}

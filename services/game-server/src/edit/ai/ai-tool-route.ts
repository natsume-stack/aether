import { bodyParse } from '@box/utils/backend';
import { randomUUID } from 'crypto';
import type * as http from 'http';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { EditServerState } from '../edit-server-schema';
import type { EditReplicaServer } from '../replica/replica-server';
import { createEntityTools, createScriptTools } from './entity-tools';
import type { CodeEditorServerController } from '../code-editor/code-editor-server-controller';
import { createMapAuthoringTools } from './map-authoring-tools';
import { coordinateAuthoring } from './authoring-tools';

/**
 * Loopback-only HTTP router that exposes the engine-side AI authoring tools
 * (terrain/UI from `createMapAuthoringTools`, entities from `createEntityTools`)
 * to SAME-HOST orchestrators (the BOX3 map MCP / an AI agent) without going
 * through mudb's AiProtocol, which today is only driven by the in-editor AI
 * panel. This closes the gap recorded in `box3-re/scan/O4-engine-ai-adaptation.md`
 * §3.4 (decision D-b).
 *
 * Design constraints (inherited from C4, intentionally not weakened):
 *   - The tools are reused VERBATIM. No second write implementation exists
 *     here; everything goes through the same functions the editor AI panel
 *     executes, writing the same authoritative in-memory RDA/voxel tree.
 *   - Optimistic locking (`expectedRevision`), rollback (`undoToken` ->
 *     `terrainRevert`) and the hard ordering rule (terrain writes refused with
 *     `PREVIEW_RUNNING` while a live preview runs, because the engine does not
 *     record voxel chunk hashes on save while running, replica-server.ts:1602)
 *     all stay inside the tools; this router never auto-stops the preview and
 *     never mutates the running state itself.
 *   - Persistence is NOT done here: after a successful write the orchestrator
 *     must still call the existing loopback `/internal/save-local-project`
 *     (via `POST /api/internal/map-authoring/<id>/save`), which keeps the
 *     project-level `branch.headHash` chain semantics untouched.
 *   - Security boundary mirrors `localOnly`/`/internal/save-local-project` in
 *     createServer.ts: loopback socket peer only, 403 otherwise. No auth is
 *     added to or bypassed from any existing route; script-writing tools are
 *     deliberately NOT exposed here (the MCP's `script_write` already gates
 *     them with a type check + CAS + read-back).
 */

/** terrainRevert replays an `undoToken` that can be many MB on large regions. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The loose runtime shape of one Vercel-AI-SDK `tool({...})` entry. The real
 * per-tool generics are erased at the bundle boundary on purpose: the zod
 * `inputSchema` re-validates every argument object before `execute` runs, so
 * `execute` still only ever sees inputs it declared.
 */
type HttpTool = {
  description?: string;
  inputSchema: z.ZodTypeAny;
  execute?: (
    input: any,
    options: { toolCallId: string; messages: unknown[] },
  ) => Promise<unknown>;
};

export type AiToolRouteSpec = {
  replica: EditReplicaServer;
  state: EditServerState;
  gameId: number;
  logger: Logger;
  codeEditorController: CodeEditorServerController;
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>,
) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createAiToolRouteHandler(spec: AiToolRouteSpec) {
  const { listScripts, readScript, scriptPreview, scriptCheck } = createScriptTools(spec.state, spec.codeEditorController, spec.logger);
  // Same bundle the AiServer wires for the editor AI panel (minus script
  // tools, see the header comment). Built once per runtime process; the tools
  // are thin closures over the live replica/state, exactly as in AiServer.
  const tools = coordinateAuthoring(spec.state, {
    listScripts,
    readScript,
    scriptPreview,
    scriptCheck,
    ...createMapAuthoringTools(
      spec.replica,
      spec.state,
      spec.gameId,
      spec.logger,
    ),
    ...createEntityTools(
      spec.replica,
      spec.state,
      spec.gameId,
      spec.logger,
    ),
  }) as unknown as Record<string, HttpTool>;
  const toolNames = Object.keys(tools);

  return async function aiToolRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Loopback gate identical to the existing internal routes in
    // createServer.ts (`/internal/save-local-project`, `localOnly`).
    const remoteAddress = req.socket.remoteAddress || '';
    const isLoopback =
      remoteAddress === '127.0.0.1' ||
      remoteAddress === '::1' ||
      remoteAddress === '::ffff:127.0.0.1';
    if (!isLoopback) {
      sendJson(res, 403, {
        code: 'FORBIDDEN',
        message: 'loopback-only internal route',
      });
      return;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, {
        tools: toolNames.map((name) => ({
          name,
          description: tools[name]?.description ?? '',
        })),
        usage:
          'POST {tool, args}. Terrain/UI writes keep the C4 semantics: ' +
          'expectedRevision optimistic lock, undoToken rollback via terrainRevert, ' +
          'PREVIEW_RUNNING refused while a live preview runs (replica-server.ts:1602). ' +
          'Persist afterwards with the existing /internal/save-local-project path.',
      });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST' });
      res.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = (await bodyParse(req, MAX_BODY_BYTES)) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Body size too big')) {
        sendJson(res, 413, {
          code: 'BODY_TOO_LARGE',
          message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        });
      } else {
        sendJson(res, 400, { code: 'INVALID_BODY', message });
      }
      return;
    }

    // Accept both `{tool}` (this lane) and `{name}` (plan/N2 R1 wording) so
    // slice-B callers written against either spec work unchanged.
    const name =
      typeof body.tool === 'string'
        ? body.tool
        : typeof body.name === 'string'
          ? body.name
          : '';
    // hasOwnProperty first: never let {"tool":"constructor"} etc. resolve.
    if (!name || !Object.prototype.hasOwnProperty.call(tools, name)) {
      sendJson(res, 400, {
        code: 'UNKNOWN_TOOL',
        message: `unknown or unavailable tool: "${name}"`,
        available: toolNames,
      });
      return;
    }
    const toolDef = tools[name];
    if (typeof toolDef.execute !== 'function') {
      sendJson(res, 501, {
        code: 'TOOL_NOT_EXECUTABLE',
        message: `tool "${name}" has no server-side execute`,
      });
      return;
    }

    const parsed = toolDef.inputSchema.safeParse(body.args ?? {});
    if (!parsed.success) {
      sendJson(res, 400, {
        code: 'TOOL_ARGS_INVALID',
        message: `invalid args for tool "${name}"`,
        issues: parsed.error.issues,
      });
      return;
    }

    try {
      spec.logger.info({ gameId: spec.gameId, tool: name }, '[internal/ai-tool] invoke');
      const result = await toolDef.execute(parsed.data, {
        toolCallId: typeof body.operationId === 'string' ? body.operationId : `http-${randomUUID()}`,
        messages: [],
      });
      // Keep the refusal codes diagnosable at the HTTP layer as well as in
      // band, mirroring the Next-side save route's 409 PREVIEW_RUNNING.
      const outcome = (result ?? {}) as Record<string, unknown>;
      const conflict =
        outcome.success === false &&
        (outcome.code === 'PREVIEW_RUNNING' ||
          outcome.code === 'REVISION_CONFLICT');
      sendJson(res, conflict ? 409 : 200, { tool: name, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spec.logger.error(
        { gameId: spec.gameId, tool: name, error },
        '[internal/ai-tool] execute failed',
      );
      const code = (error as Error & { code?: string }).code || 'TOOL_EXECUTION_FAILED';
      const status = ['OPERATION_ID_REUSED', 'REVISION_CONFLICT', 'PREVIEW_RUNNING', 'SCRIPT_LOCK_REQUIRED', 'SCRIPT_BUSY'].includes(code) ? 409
        : ['INVALID_OPERATION_ID', 'TOOL_ARGS_INVALID', 'INVALID_PROPOSAL', 'UNSUPPORTED_PROPOSAL_TOOL', 'PROPOSAL_REFUSED', 'INVALID_SCRIPT_PATCH', 'OVERLAPPING_SCRIPT_EDITS', 'SCRIPT_TOO_LARGE', 'SCRIPT_CHECK_FAILED'].includes(code) ? 400
        : ['SCRIPT_CHECK_UNAVAILABLE', 'SCRIPT_CHECK_TIMEOUT', 'SCRIPT_CHECK_BUDGET'].includes(code) ? 503
        : code === 'SCRIPT_CHECK_BUSY' ? 429
        : ['OPERATION_CAPACITY', 'PROPOSAL_CAPACITY'].includes(code) ? 429 : 500;
      sendJson(res, status, { code, message });
    }
  };
}

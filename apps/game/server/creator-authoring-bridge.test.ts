/**
 * Creator/v1 AI authoring bridge tests (lane B/D).
 *
 * Dual-mode, mirroring `server/creator-api-security.test.ts`:
 *   standalone (no package build needed)
 *     cd apps/game && node --experimental-strip-types server/creator-authoring-bridge.test.ts
 *   jest
 *     cd apps/game && node_modules/.bin/jest --runInBand --runTestsByPath server/creator-authoring-bridge.test.ts
 *
 * No credential ever appears in a fixture or in an audit line: the bearer value
 * below is an obvious fake and one case proves it cannot leak.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import type { AuthoringRuntimeCaller } from './creator-authoring-bridge';

/**
 * The repo runs these tests without a package build, and Node's ESM loader
 * resolves static specifiers before any module body can install a resolve hook.
 * Every local `.ts` import is therefore dynamic and aliased onto pre-declared
 * bindings, exactly the shape `creator-api-security.test.ts` uses.
 */
type Bridge = typeof import('./creator-authoring-bridge');
type Policy = typeof import('../shared/creator-cli-policy');
type Guard = typeof import('../pages/api/internal/map-authoring/_guard');

let CREATOR_AUTHORING_SCOPE!: Bridge['CREATOR_AUTHORING_SCOPE'];
let authoringBearer!: Bridge['authoringBearer'];
let authoringQuotaEntriesForTests!: Bridge['authoringQuotaEntriesForTests'];
let authoringSurface!: Bridge['authoringSurface'];
let consumeAuthoringWriteQuota!: Bridge['consumeAuthoringWriteQuota'];
let controlAuthoringPreview!: Bridge['controlAuthoringPreview'];
let createLoopbackRuntimeCaller!: Bridge['createLoopbackRuntimeCaller'];
let extractRevision!: Bridge['extractRevision'];
let invokeAuthoringTool!: Bridge['invokeAuthoringTool'];
let isAuthoringProjectId!: Bridge['isAuthoringProjectId'];
let isPreviewRunning!: Bridge['isPreviewRunning'];
let readAuthoringAudit!: Bridge['readAuthoringAudit'];
let resetAuthoringWriteQuota!: Bridge['resetAuthoringWriteQuota'];
let saveAuthoringProject!: Bridge['saveAuthoringProject'];
let tokenFingerprint!: Bridge['tokenFingerprint'];
let writeAuthoringAudit!: Bridge['writeAuthoringAudit'];
let CREATOR_CLI_CAPABILITIES!: Policy['CREATOR_CLI_CAPABILITIES'];
let CREATOR_CLI_CAPABILITY_META!: Policy['CREATOR_CLI_CAPABILITY_META'];
let normalizeCreatorCliCapabilities!: Policy['normalizeCreatorCliCapabilities'];
let allowLoopback!: Guard['allowLoopback'];

let loaded = false;
async function loadAll(): Promise<void> {
  if (loaded) return;
  const bridge = await import('./creator-authoring-bridge');
  const policy = await import('../shared/creator-cli-policy');
  const guard = await import('../pages/api/internal/map-authoring/_guard');
  ({
    CREATOR_AUTHORING_SCOPE, authoringBearer, authoringQuotaEntriesForTests, authoringSurface,
    consumeAuthoringWriteQuota, controlAuthoringPreview, createLoopbackRuntimeCaller, extractRevision,
    invokeAuthoringTool, isAuthoringProjectId, isPreviewRunning, readAuthoringAudit,
    resetAuthoringWriteQuota, saveAuthoringProject, tokenFingerprint, writeAuthoringAudit,
  } = bridge);
  ({ CREATOR_CLI_CAPABILITIES, CREATOR_CLI_CAPABILITY_META, normalizeCreatorCliCapabilities } = policy);
  ({ allowLoopback } = guard);
  loaded = true;
}


const FAKE_TOKEN = 'bxc_deadbeefdeadbeef_deadbeefdeadbeefdeadbeefdeadbeef';
const AUDITED_FIELDS = [
  'at',
  'tokenSubject',
  'projectId',
  'tool',
  'revisionBefore',
  'revisionAfter',
  'result',
];
/** The nine scopes shipped before this lane; none may disappear. */
const SHIPPED_SCOPES = [
  'projects.list',
  'resources.list',
  'scripts.read',
  'scripts.update',
  'storage.read',
  'storage.write',
  'runtime.view',
  'runtime.control',
  'scene.capture',
];

function resolveRepoRoot(): string {
  for (const candidate of [path.resolve(process.cwd(), '..', '..'), process.cwd()]) {
    if (fs.existsSync(path.join(candidate, 'apps/game/server/creator-api-security.ts'))) return candidate;
  }
  return process.cwd();
}

const repoRoot = resolveRepoRoot();
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Captures every audit line this module writes to stdout during `run`. */
async function captureAuditLines(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => {
    const text = String(chunk);
    if (text.startsWith('[box3.creator-authoring]')) {
      lines.push(text.slice('[box3.creator-authoring] '.length).trim());
    }
    return true;
  }) as never;
  try {
    await run();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return lines;
}

function captureAuditLinesSync(run: () => void): string[] {
  let captured: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => {
    const text = String(chunk);
    if (text.startsWith('[box3.creator-authoring]')) {
      captured.push(text.slice('[box3.creator-authoring] '.length).trim());
    }
    return true;
  }) as never;
  try {
    run();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return captured;
}

type Call = { url: string; method: string; body: unknown };

function stubCaller(
  projectId: string,
  responses: Array<{ match: string; status?: number; data?: unknown; throws?: boolean }>,
): { caller: AuthoringRuntimeCaller; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: text, method: String(init?.method || 'GET'), body });
    const rule = responses.find((entry) => text.includes(entry.match));
    if (rule?.throws) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9967'), { code: 'ECONNREFUSED' });
    if (!rule) return fakeFetchResponse(501, { code: 'STUB_MISS' });
    return fakeFetchResponse(rule.status ?? 200, rule.data ?? {});
  }) as unknown as typeof fetch;
  return { caller: createLoopbackRuntimeCaller(projectId, fetchImpl), calls };
}

function fakeFetchResponse(status: number, data: unknown): Response {
  return { status, json: async () => data } as Response;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    end() { return res; },
    setHeader() { /* not used by the loopback guard */ },
  };
  return res;
}

function reqWithPeer(peerAddress: string) {
  return { socket: { remoteAddress: peerAddress }, headers: {} } as never;
}

type Case = [name: string, run: () => void | Promise<void>];

function buildCases(): Case[] {
  return [
    ['新增 scope 严格 additive：出厂 9 项一个不少，只多 1 项且无重复', () => {
      for (const scope of SHIPPED_SCOPES) {
        assert.ok((CREATOR_CLI_CAPABILITIES as readonly string[]).includes(scope), `${scope} 不得被移除`);
      }
      assert.equal(CREATOR_CLI_CAPABILITIES.length, SHIPPED_SCOPES.length + 1, '本泳道只允许新增一项');
      assert.equal(new Set(CREATOR_CLI_CAPABILITIES).size, CREATOR_CLI_CAPABILITIES.length, 'scope 不得重复');
      assert.equal(CREATOR_AUTHORING_SCOPE, 'authoring.apply');
      assert.ok((CREATOR_CLI_CAPABILITIES as readonly string[]).includes(CREATOR_AUTHORING_SCOPE));
    }],

    ['签发端与鉴权端共用的归一化函数接受新 scope，未知值仍丢弃', () => {
      assert.deepEqual(normalizeCreatorCliCapabilities(['authoring.apply']), ['authoring.apply']);
      assert.deepEqual(
        normalizeCreatorCliCapabilities(['projects.list', 'authoring.apply', 'authoring.apply', 'projects.delete']),
        ['projects.list', 'authoring.apply'],
        '去重并拒绝用户级权限名（projects.delete 不是 CLI scope）',
      );
      assert.deepEqual(normalizeCreatorCliCapabilities('not-an-array'), []);
    }],

    ['门户元数据齐全，勾选面与签发 zod 都由同一份枚举驱动', () => {
      for (const scope of CREATOR_CLI_CAPABILITIES) {
        const meta = CREATOR_CLI_CAPABILITY_META[scope];
        assert.ok(meta.label && meta.description && meta.group, `${scope} 缺少门户元数据`);
      }
      const ui = read('apps/player-admin/src/pages/creator/creator-management.tsx');
      assert.match(ui, /CREATOR_CLI_CAPABILITIES\.reduce/, '门户权限分组必须遍历枚举，不得硬编码 9 项');
      assert.match(ui, /CREATOR_CLI_CAPABILITY_META\[capability\]\.label/, '勾选项 label 来自元数据');
      const validation = read('apps/game/server/player-admin-validation.ts');
      assert.match(validation, /z\.enum\(CREATOR_CLI_CAPABILITIES/, '签发端 zod 枚举来自同一份清单');
      const identity = read('apps/game/server/local-player-identity.ts');
      assert.match(identity, /const requested = normalizeCreatorCliCapabilities\(values\.scopes\)/,
        'createCreatorCliToken 落库前过同一份归一化');
    }],

    ['tokenFingerprint 稳定、不可逆，且绝不等于凭据本身', () => {
      const one = tokenFingerprint(FAKE_TOKEN);
      assert.match(one, /^[0-9a-f]{12}$/, '指纹固定 12 位十六进制');
      assert.equal(one, tokenFingerprint(FAKE_TOKEN), '同一 token 指纹稳定');
      assert.notEqual(one, tokenFingerprint(`${FAKE_TOKEN.slice(0, -1)}a`), '不同 token 指纹不同');
      assert.equal(tokenFingerprint(''), 'none');
      assert.ok(!one.includes('bxc_'), '指纹不得含 token 前缀');
    }],

    ['审计行含 6 个契约字段，且不含凭据与 Authorization 原文', () => {
      const lines = captureAuditLinesSync(() => {
        writeAuthoringAudit({
          tokenSubject: 'subject-ai-1',
          tokenFingerprint: tokenFingerprint(FAKE_TOKEN),
          projectId: 'demo-map',
          tool: 'terrainApply',
          action: 'tool',
          revisionBefore: '41',
          revisionAfter: '42',
          result: 'applied',
          statusCode: 200,
        });
      });
      assert.equal(lines.length, 1);
      const row = JSON.parse(lines[0]) as Record<string, unknown>;
      for (const field of AUDITED_FIELDS) {
        assert.ok(field in row, `审计行缺少 ${field}`);
        assert.equal(typeof row[field], 'string', `${field} 必须是标量`);
      }
      assert.equal(row.tokenSubject, 'subject-ai-1');
      assert.equal(row.result, 'applied');
      assert.ok(!lines[0].includes(FAKE_TOKEN), '审计行绝不落凭据');
      assert.ok(!lines[0].includes('Bearer'), '审计行不落 Authorization 原文');
    }],

    ['审计文件落盘可读，且只回显调用者自己（subject + 指纹）的行', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-authoring-audit-'));
      const file = path.join(dir, 'authoring.jsonl');
      try {
        withEnv({ BOX_CREATOR_AUTHORING_AUDIT_PATH: file }, () => {
          captureAuditLinesSync(() => {
            writeAuthoringAudit({ tokenSubject: 'subject-a', tokenFingerprint: 'aaaa11112222', projectId: 'map-1', tool: 'terrainApply', revisionBefore: '1', revisionAfter: '2', result: 'applied', statusCode: 200 });
            writeAuthoringAudit({ tokenSubject: 'subject-a', tokenFingerprint: 'bbbb33334444', projectId: 'map-1', tool: 'save', result: 'saved', statusCode: 200 });
            writeAuthoringAudit({ tokenSubject: 'subject-b', tokenFingerprint: 'cccc55556666', projectId: 'map-2', tool: 'terrainApply', result: 'refused', statusCode: 409, code: 'PREVIEW_RUNNING' });
          });
          const mine = readAuthoringAudit({ tokenSubject: 'subject-a', tokenFingerprint: 'aaaa11112222' });
          assert.equal(mine.total, 1, '同账号另一把 token 的行不得可见');
          assert.equal(mine.rows[0].tool, 'terrainApply');
          assert.equal(mine.sink, 'file');
          assert.equal(readAuthoringAudit({ tokenSubject: 'subject-b', tokenFingerprint: 'cccc55556666', projectId: 'map-1' }).total, 0,
            '跨地图过滤必须生效');
          assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3, '三行都落盘');
          assert.equal(readAuthoringAudit({ tokenSubject: 'subject-a', tokenFingerprint: 'aaaa11112222', limit: 999 }).rows.length, 1,
            'limit 有上限，不放大读取面');
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }],

    ['未配置审计文件时读取端如实回答 stdout-only', () => {
      withEnv({ BOX_CREATOR_AUTHORING_AUDIT_PATH: undefined }, () => {
        assert.deepEqual(
          readAuthoringAudit({ tokenSubject: 'subject-a', tokenFingerprint: 'x' }),
          { rows: [], sink: 'stdout-only', total: 0 },
        );
      });
    }],

    ['预览运行判定覆盖运行时两种上报形状', () => {
      assert.equal(isPreviewRunning({ running: true }), true);
      assert.equal(isPreviewRunning({ phase: 'running' }), true);
      assert.equal(isPreviewRunning({ running: false, phase: 'idle' }), false);
      assert.equal(isPreviewRunning({}), false);
      assert.equal(isPreviewRunning(null), false);
      assert.equal(isPreviewRunning('running'), false);
    }],

    ['save：预览在跑即 409 PREVIEW_RUNNING，且完全不触碰保存路由', async () => {
      const stub = stubCaller('demo-map', [
        { match: 'internal/creator-preview-runtime', data: { running: true, phase: 'running' } },
        { match: 'internal/save-local-project', data: { permissionHash: 'abc' } },
      ]);
      const lines = await captureAuditLines(async () => {
        const result = await saveAuthoringProject({
          caller: stub.caller, tokenSubject: 'subject-ai-1', tokenFingerprint: 'ffff00001111', force: false,
        });
        assert.equal(result.status, 409);
        assert.equal((result.body as { code: string }).code, 'PREVIEW_RUNNING');
      });
      assert.equal(stub.calls.filter((call) => call.url.includes('save-local-project')).length, 0,
        '拒绝路径不得已经把脏盘写下去');
      const row = JSON.parse(lines[0]) as Record<string, string>;
      assert.equal(row.result, 'refused');
      assert.equal(row.code, 'PREVIEW_RUNNING');
      assert.match(row.detail, /replica-server\.ts:1600-1602/, '拒绝原因必须带源码依据');
    }],

    ['save：force:true 显式越权，仍然落一行可归因审计并记录 after revision', async () => {
      const stub = stubCaller('demo-map', [
        { match: 'internal/creator-preview-runtime', data: { running: true } },
        { match: 'internal/save-local-project', data: { permissionHash: 'sha256:beef' } },
      ]);
      const lines = await captureAuditLines(async () => {
        const result = await saveAuthoringProject({
          caller: stub.caller, tokenSubject: 'subject-ai-1', tokenFingerprint: 'ffff00001111', force: true,
        });
        assert.equal(result.status, 200);
      });
      const saved = stub.calls.find((call) => call.url.includes('internal/save-local-project'));
      assert.equal(saved?.method, 'POST', 'force 保存必须真的打到运行时');
      const row = JSON.parse(lines[0]) as Record<string, string>;
      assert.equal(row.result, 'saved');
      assert.equal(row.revisionAfter, 'sha256:beef', '保存后的 revision 来自运行时回包');
    }],

    ['save：预览探针挂了不阻断合法保存（由保存自身定性）', async () => {
      const stub = stubCaller('demo-map', [
        { match: 'internal/creator-preview-runtime', throws: true },
        { match: 'internal/save-local-project', data: { permissionHash: 'ok' } },
      ]);
      await captureAuditLines(async () => {
        const result = await saveAuthoringProject({
          caller: stub.caller, tokenSubject: 'subject-ai-1', tokenFingerprint: 'ffff00001111', force: false,
        });
        assert.equal(result.status, 200);
      });
    }],

    ['invoke：没有活体编辑运行时即 409 RUNTIME_NOT_ACTIVE，绝不冷启动编辑器', async () => {
      const stub = stubCaller('demo-map', [
        { match: '__local_runtime/status', data: { pid: undefined } },
        { match: 'internal/ai-tool', data: { tool: 'terrainApply', result: { success: true } } },
      ]);
      const lines = await captureAuditLines(async () => {
        const result = await invokeAuthoringTool({
          caller: stub.caller, tokenSubject: 'subject-ai-1', tokenFingerprint: 'a'.repeat(12),
          tool: 'terrainApply', args: { expectedRevision: 7 },
        });
        assert.equal(result.status, 409);
        assert.equal((result.body as { code: string }).code, 'RUNTIME_NOT_ACTIVE');
      });
      assert.equal(stub.calls.filter((call) => call.url.includes('internal/ai-tool')).length, 0);
      assert.equal(JSON.parse(lines[0]).result, 'refused');
    }],

    ['invoke：status 非 200 也算没有运行时', async () => {
      const stub = stubCaller('demo-map', [{ match: '__local_runtime/status', status: 500, data: {} }]);
      await captureAuditLines(async () => {
        const result = await invokeAuthoringTool({
          caller: stub.caller, tokenSubject: 's', tokenFingerprint: 'b'.repeat(12), tool: 'terrainApply', args: {},
        });
        assert.equal(result.status, 409);
      });
    }],

    ['invoke：引擎内 REVISION_CONFLICT / PREVIEW_RUNNING 原样透传，不重实现语义', async () => {
      for (const code of ['REVISION_CONFLICT', 'PREVIEW_RUNNING']) {
        const stub = stubCaller('demo-map', [
          { match: '__local_runtime/status', data: { pid: 4242, port: 9967 } },
          { match: 'internal/ai-tool', status: 409, data: { tool: 'terrainApply', result: { success: false, code } } },
        ]);
        const lines = await captureAuditLines(async () => {
          const result = await invokeAuthoringTool({
            caller: stub.caller, tokenSubject: 'subject-ai-1', tokenFingerprint: 'c'.repeat(12),
            tool: 'terrainApply', args: { expectedRevision: 41 },
          });
          assert.equal(result.status, 409, `${code} 必须仍是 409`);
        });
        const row = JSON.parse(lines[0]) as Record<string, string>;
        assert.equal(row.result, 'refused', `${code} 审计为 refused`);
        assert.equal(row.code, code);
        assert.equal(row.revisionBefore, '41', '调用方声明的 expectedRevision 必须进审计');
      }
    }],

    ['invoke：成功写回 applied，记录 after revision，且不复制 undoToken 大体内容', async () => {
      const undoToken = 'x'.repeat(5000);
      const stub = stubCaller('demo-map', [
        { match: '__local_runtime/status', data: { pid: 1 } },
        { match: 'internal/ai-tool', data: { tool: 'terrainApply', result: { success: true, revision: '42', undoToken } } },
      ]);
      const lines = await captureAuditLines(async () => {
        const result = await invokeAuthoringTool({
          caller: stub.caller, tokenSubject: 'subject-ai-1', tokenFingerprint: 'd'.repeat(12),
          tool: 'terrainApply', args: { expectedRevision: 41 },
        });
        assert.equal(result.status, 200);
      });
      const row = JSON.parse(lines[0]) as Record<string, string>;
      assert.equal(row.result, 'applied');
      assert.equal(row.revisionBefore, '41');
      assert.equal(row.revisionAfter, '42');
      assert.ok(!lines[0].includes(undoToken), '审计行不得复制 undoToken');
      const call = stub.calls.find((entry) => entry.url.includes('internal/ai-tool'));
      assert.equal((call?.body as { tool: string }).tool, 'terrainApply', '转发体形状 {tool,args}');
      assert.equal((call?.body as { args: { expectedRevision: number } }).args.expectedRevision, 41);
    }],

    ['invoke：缺 tool 名直接 400，且不打运行时', async () => {
      const stub = stubCaller('demo-map', []);
      const result = await invokeAuthoringTool({
        caller: stub.caller, tokenSubject: 's', tokenFingerprint: 'e'.repeat(12), tool: '', args: {},
      });
      assert.equal(result.status, 400);
      assert.equal(stub.calls.length, 0);
    }],

    ['extractRevision 按声明顺序取值且遍历有界', () => {
      assert.equal(extractRevision({ expectedRevision: 7 }), '7');
      assert.equal(extractRevision({ args: { expectedRevision: 'abc' } }), 'abc');
      assert.equal(extractRevision({ result: { headHash: 'hh' } }), 'hh');
      assert.equal(extractRevision({ unrelated: 1 }), '');
      assert.equal(extractRevision(null), '');
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 2000; ++i) wide[`k${i}`] = { [`n${i}`]: 1 };
      assert.equal(extractRevision(wide), '', '大体量 undoToken 不能把审计拖死');
    }],

    ['配额：同一 token+地图超限即 429，换 token / 换地图互不影响', () => {
      withEnv({ BOX_CREATOR_AUTHORING_RATE_LIMIT_MAX: '3', BOX_CREATOR_AUTHORING_RATE_LIMIT_WINDOW_MS: '60000' }, () => {
        resetAuthoringWriteQuota();
        const results = [1, 2, 3, 4].map(() => consumeAuthoringWriteQuota('token-aaa', 'map-1'));
        assert.deepEqual(results.slice(0, 3).map((item) => item.allowed), [true, true, true]);
        assert.equal(results[3].allowed, false);
        assert.ok(results[3].retryAfterSeconds >= 1, '429 必须能算出 Retry-After');
        assert.equal(consumeAuthoringWriteQuota('token-bbb', 'map-1').allowed, true, '另一把 token 不受牵连');
        assert.equal(consumeAuthoringWriteQuota('token-aaa', 'map-2').allowed, true, '另一张地图不受牵连');
        resetAuthoringWriteQuota();
        assert.equal(consumeAuthoringWriteQuota('token-aaa', 'map-1').allowed, true, '窗口重置后恢复');
      });
    }],

    ['配额键只含指纹，绝不含凭据原文', () => {
      resetAuthoringWriteQuota();
      withEnv({ BOX_CREATOR_AUTHORING_RATE_LIMIT_MAX: '5' }, () => {
        consumeAuthoringWriteQuota(tokenFingerprint(FAKE_TOKEN), 'map-1');
        const entries = authoringQuotaEntriesForTests();
        assert.equal(entries.length, 1);
        assert.ok(!entries[0].key.includes('bxc_'), `配额键不得含凭据：${entries[0].key}`);
        assert.ok(entries[0].key.endsWith('|map-1'), '配额按地图分桶');
      });
      resetAuthoringWriteQuota();
    }],

    ['projectId 校验沿用出厂形状', () => {
      assert.equal(isAuthoringProjectId('demo-map'), true);
      assert.equal(isAuthoringProjectId('Demo-Map'), false, '永久地图 ID 是小写');
      assert.equal(isAuthoringProjectId('../etc'), false);
      assert.equal(isAuthoringProjectId(''), false);
      assert.equal(isAuthoringProjectId('a'.repeat(64)), false, '长度上限 63');
    }],

    ['caller 拨号形状与 _guard.ts 一致：回环主机 + 同一端口解析顺序', () => {
      withEnv({ BOX_EDIT_RUNTIME_PORT: '9977', BOX_EDIT_SERVER_PORT: undefined, BOX_EDIT_RUNTIME_HOST: undefined }, () => {
        const stub = stubCaller('demo-map', [{ match: '__local_runtime/status', data: { pid: 1 } }]);
        stub.caller.probeRuntime();
        assert.equal(stub.calls[0].url, 'http://127.0.0.1:9977/demo-map/__local_runtime/status');
        const guard = read('apps/game/pages/api/internal/map-authoring/_guard.ts');
        assert.match(guard, /http:\/\/127\.0\.0\.1:\$\{runtimePort\(\)\}/, '出厂拨号目标仍是回环');
        assert.match(guard, /BOX_EDIT_RUNTIME_PORT/, '出厂端口解析顺序未被改动');
      });
      withEnv({ BOX_EDIT_RUNTIME_PORT: undefined, BOX_EDIT_SERVER_PORT: '9966', BOX_EDIT_RUNTIME_HOST: '0.0.0.0' }, () => {
        const stub = stubCaller('m1', [{ match: '__local_runtime/status', data: { pid: 1 } }]);
        stub.caller.probeRuntime();
        assert.equal(stub.calls[0].url, 'http://127.0.0.1:9966/m1/__local_runtime/status',
          '0.0.0.0 是绑定地址，绝不能当拨号目标');
      });
    }],

    ['preview：start/stop 各落一行审计，转发体只带 action', async () => {
      const stub = stubCaller('demo-map', [
        { match: 'internal/creator-preview-runtime', data: { phase: 'running' } },
      ]);
      const lines = await captureAuditLines(async () => {
        await controlAuthoringPreview({ caller: stub.caller, tokenSubject: 's', tokenFingerprint: 'f'.repeat(12), action: 'stop' });
      });
      assert.equal(JSON.parse(lines[0]).result, 'preview-stopped');      assert.equal(JSON.parse(lines[0]).tool, 'preview.stop');
      assert.equal(stub.calls[0].method, 'POST');
      assert.deepEqual(stub.calls[0].body, { action: 'stop' });
    }],

    ['preview：运行时连接被拒即 409 RUNTIME_NOT_ACTIVE，并审计为 failed', async () => {
      const stub = stubCaller('demo-map', [{ match: 'internal/creator-preview-runtime', throws: true }]);
      const lines = await captureAuditLines(async () => {
        const result = await controlAuthoringPreview({
          caller: stub.caller, tokenSubject: 's', tokenFingerprint: 'a'.repeat(12), action: 'start',
        });
        assert.equal(result.status, 409);
        assert.equal((result.body as { code: string }).code, 'RUNTIME_NOT_ACTIVE');
      });
      assert.equal(JSON.parse(lines[0]).result, 'failed');
    }],

    ['回环门一字未改：_guard.allowLoopback 仍只认 socket 对端，且没有任何密钥分支', () => {
      for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const res = fakeRes();
        assert.equal(allowLoopback(reqWithPeer(peer), res as never), true, `${peer} 必须放行`);
      }
      for (const peer of ['172.18.0.1', '172.19.0.1', '10.0.0.5', '0.0.0.0', '']) {
        const res = fakeRes();
        assert.equal(allowLoopback(reqWithPeer(peer), res as never), false, `${peer} 必须继续 403`);
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, { code: 'FORBIDDEN', message: 'loopback-only internal route' });
      }
      const guard = read('apps/game/pages/api/internal/map-authoring/_guard.ts');
      for (const forbidden of ['authorization', 'token', 'secret', 'bearer', 'fingerprint', 'BOX_AI_AUTHORING']) {
        assert.ok(!new RegExp(forbidden, 'i').test(guard), `_guard.ts 不得出现密钥分支：命中 ${forbidden}`);
      }
      for (const file of ['status.ts', 'tool.ts', 'save.ts', 'preview.ts']) {
        const source = read(`apps/game/pages/api/internal/map-authoring/[projectId]/${file}`);
        assert.match(source, /allowLoopback\(req, res\)/, `${file} 仍是回环门`);
        assert.doesNotMatch(source, /ai-authoring-access/, `${file} 不得引用旁路密钥模块`);
      }
    }],

    ['新路由一律走 CLI Token 门，不复用回环门、不引入共享密钥', () => {
      const routes = [
        'apps/game/pages/api/creator/v1/authoring/[projectId]/tools.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/save.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/preview.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/status.ts',
        'apps/game/pages/api/creator/v1/authoring/audit.ts',
      ];
      for (const route of routes) {
        const source = read(route);
        assert.match(source, /authorizeCreatorCliApi\(req, res, CREATOR_AUTHORING_SCOPE\)/,
          `${route} 必须以 CLI Token + authoring.apply 鉴权`);
        assert.doesNotMatch(source, /allowLoopback/, `${route} 不得改用回环门`);
        assert.doesNotMatch(source, /BOX_AI_AUTHORING_TOKEN/, `${route} 不得引入共享密钥`);
        assert.doesNotMatch(source, /process\.env\.PERMISSION_TOKEN_SECRET/, `${route} 不得自己摸密钥`);
      }
    }],

    ['authoringSurface 自述端点清单与磁盘实现一一对应', () => {
      const surface = authoringSurface('demo-map');
      assert.equal(surface.identity, 'creator-cli-token');
      assert.equal(surface.scope, 'authoring.apply');
      const expected = [
        'apps/game/pages/api/creator/v1/authoring/[projectId]/tools.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/tools.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/save.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/preview.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/preview.ts',
        'apps/game/pages/api/creator/v1/authoring/[projectId]/status.ts',
        'apps/game/pages/api/creator/v1/authoring/audit.ts',
      ];
      assert.equal(surface.endpoints.length, expected.length, '端点清单长度与实现一致');
      surface.endpoints.forEach((endpoint, index) => {
        const pathname = endpoint.split(/\s+/)[1];
        assert.ok(pathname.startsWith('/api/creator/v1/authoring/'), `端点必须在 authoring 族内：${pathname}`);
        assert.ok(fs.existsSync(path.join(repoRoot, expected[index])), `缺少实现文件：${expected[index]}`);
      });
      assert.equal(surface.endpoints.filter((line) => line.includes('demo-map')).length, 6,
        '六个工程内端点带真实 projectId，audit 端点不带');
      assert.match(surface.endpoints[0], /^GET\s+\/api\/creator\/v1\/authoring\/demo-map\/tools$/);
      assert.match(surface.orderingRule, /replica-server\.ts:1600-1602/);
    }],

    ['CLI Bearer 在 authoring 族不被 UI 门误伤：路径前缀判定覆盖新面', () => {
      assert.equal(
        read('apps/game/server/creator-api-security.ts').includes("CREATOR_CLI_API_PATH_PREFIX = '/api/creator/v1'"),
        true, 'CLI 路由族前缀仍为 /api/creator/v1，authoring 天然落在族内',
      );
    }],

    ['authoringBearer 只认 Bearer 前缀', () => {
      assert.equal(authoringBearer({ headers: { authorization: `Bearer ${FAKE_TOKEN}` } } as never), FAKE_TOKEN);
      assert.equal(authoringBearer({ headers: { authorization: '   bearer   abc ' } } as never), 'abc');
      assert.equal(authoringBearer({ headers: { authorization: 'Basic abc' } } as never), '');
      assert.equal(authoringBearer({ headers: {} } as never), '');
    }],
  ];
}

const globals = globalThis as unknown as {
  describe?: (name: string, fn: () => void) => void;
  test?: (name: string, fn: () => void | Promise<void>) => void;
  beforeAll?: (fn: () => void | Promise<void>) => void;
};

if (typeof globals.describe === 'function' && typeof globals.test === 'function') {
  globals.beforeAll?.(loadAll);
  globals.describe('creator authoring bridge: AI 写面必须带身份、带审计、可撤销、可限流', () => {
    for (const [name, run] of buildCases()) globals.test!(async () => { await loadAll(); return run(); });
  });
} else {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith('file:')) {
        const base = new URL(specifier, context.parentURL);
        for (const candidate of [base.href, `${base.href}.ts`, `${base.href}.js`, `${base.href}/index.ts`]) {
          try {
            if (fs.existsSync(new URL(candidate))) return nextResolve(candidate, context);
          } catch { /* 继续下一个候选 */ }
        }
      }
      return nextResolve(specifier, context);
    },
  });
  void (async () => {
    await loadAll();
    const cases = buildCases();
    let failures = 0;
    for (const [name, run] of cases) {
      try {
        await run();
        console.log(`ok - ${name}`);
      } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}`);
        console.error((error as Error).stack || error);
      }
    }
    console.log(`# ${cases.length - failures}/${cases.length} passed`);
    if (failures) process.exitCode = 1;
  })();
}

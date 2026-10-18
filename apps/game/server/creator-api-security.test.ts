/**
 * Dual-mode test for the Creator credential/route gate.
 *
 * Jest mode (`pnpm/jest` in apps/game) registers the cases through the injected
 * `describe`/`test` globals and mocks the `@box/apis` identity client.
 * Standalone mode (no node_modules) installs a Node resolve hook that redirects
 * `@box/apis` and extensionless relative imports, then runs the same cases in
 * process: `node --experimental-strip-types server/creator-api-security.test.ts`.
 *
 * The identity service itself is replaced by a recording stub, so every case
 * asserts which door the request reached and whether the service was called at
 * all — that is exactly the boundary the bypass used to cross.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

type FakeIdentity = {
  subjectId: string;
  username: string;
  creatorAccess: boolean;
  creatorPermissions: string[];
  creatorCliPermissions: string[];
  status: string;
};

type Stub = {
  status: number;
  message: string;
  identity: FakeIdentity | null;
  requests: Array<Record<string, string>>;
};

const stub: Stub = {
  status: 200,
  message: '',
  identity: null,
  requests: [],
};

function baseIdentity(overrides: Partial<FakeIdentity> = {}): FakeIdentity {
  return {
    subjectId: 'subject-creator-1',
    username: 'creator',
    creatorAccess: true,
    // The account holds the full user-level permission set. Before the gate this
    // alone was enough for any Bearer to publish, export or delete.
    creatorPermissions: ['projects.view', 'projects.create', 'projects.edit', 'projects.delete', 'projects.import', 'projects.export', 'models.manage'],
    // …while the token itself is scoped to a single read operation.
    creatorCliPermissions: ['projects.list'],
    status: 'active',
    ...overrides,
  };
}

function resetStub(identity: FakeIdentity | null = baseIdentity()) {
  stub.status = 200;
  stub.message = '';
  stub.identity = identity;
  stub.requests = [];
}

(globalThis as { __boxCreatorIdentityStub?: Stub }).__boxCreatorIdentityStub = stub;

/** Minimal replacement for the generated `@box/apis` client used by player-service-client. */
class StubApiClient {
  private readonly options: { headers?: unknown };

  constructor(options: { headers?: unknown }) {
    this.options = options || {};
  }

  async postApiPlayerInternalRuntimeIdentityRaw() {
    const current = (globalThis as { __boxCreatorIdentityStub?: Stub }).__boxCreatorIdentityStub!;
    const raw = this.options.headers;
    const headers: Record<string, string> = {};
    if (raw instanceof Headers) {
      raw.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    } else if (Array.isArray(raw)) {
      for (const [key, value] of raw) headers[String(key).toLowerCase()] = String(value);
    } else if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    current.requests.push(headers);
    const body = current.status === 200 && current.identity
      ? { identity: current.identity, assertion: 'unit-test-assertion' }
      : { message: current.message || 'AUTH_REQUIRED' };
    return {
      response: new Response(JSON.stringify(body), {
        status: current.status,
        headers: { 'content-type': 'application/json' },
      }),
      data: body,
    };
  }
}

(globalThis as { __boxCreatorStubApiClient?: unknown }).__boxCreatorStubApiClient = StubApiClient;

const trackedEnvKeys = [
  'BOX_DEPLOYMENT_MODE',
  'BOX_CREATOR_ALLOWED_HOSTS',
  'BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES',
  'BOX_PLAYER_SERVICE_INTERNAL_URL',
  'PERMISSION_TOKEN_SECRET',
];

function withEnv<T>(extra: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of trackedEnvKeys) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const key of trackedEnvKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function prepareServiceEnv() {
  process.env.BOX_DEPLOYMENT_MODE = 'creator';
  process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://127.0.0.1:1';
  process.env.PERMISSION_TOKEN_SECRET = 'unit-test-internal-secret';
  delete process.env.BOX_CREATOR_ALLOWED_HOSTS;
  delete process.env.BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES;
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    ended: false,
    body: undefined as unknown,
    setHeader(key: string, value: string) { res.headers[key] = String(value); return res; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    send(body: unknown) { res.body = body; return res; },
    end() { res.ended = true; return res; },
  };
  return res;
}

const CLI_TOKEN = 'Bearer bxc_0123456789abcdef01_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function fakeRequest(options: {
  url: string;
  method?: string;
  authorization?: string;
  cookie?: string;
  headers?: Record<string, string>;
}) {
  return {
    method: options.method || 'GET',
    url: options.url,
    query: {},
    body: {},
    headers: {
      host: 'localhost',
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as never;
}

type Module = typeof import('./creator-api-security');

function buildCases(loadModule: () => Promise<Module>): Array<[string, () => void | Promise<void>]> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['越权面已关闭：只读 scope 的 CLI Bearer 打 publish 直接 403，且不再询问身份服务', async () => {
      resetStub();
      const mod = await loadModule();
      const res = fakeResponse();
      prepareServiceEnv();
      const identity = await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/local-projects/demo-map/publish', method: 'POST', authorization: CLI_TOKEN }),
        res as never,
        'projects.edit',
      );
      assert.equal(identity, undefined);
      assert.equal(res.statusCode, 403);
      assert.equal((res.body as { code: string }).code, 'CREATOR_CLI_ROUTE_DENIED');
      assert.deepEqual(stub.requests, [], '必须在触达身份服务之前就拒绝，避免用账号级权限判定 token');
    }],

    ['五条生命周期写路由全部在拒绝面内', async () => {
      resetStub();
      const mod = await loadModule();
      prepareServiceEnv();
      const routes = [
        '/api/local-projects',
        '/api/local-projects/demo-map/maps',
        '/api/local-projects/demo-map/publish',
        '/api/local-projects/demo-map/export',
        '/api/local-projects/demo-map/package',
        '/api/local-projects/import',
        '/api/local-projects/demo-map',
        '/api/creator-models/import',
        '/api/system/backups',
      ];
      for (const url of routes) {
        resetStub();
        const res = fakeResponse();
        const ok = await mod.allowAuthenticatedCreatorApi(fakeRequest({ url, method: 'POST', authorization: CLI_TOKEN }), res as never, 'projects.export');
        assert.equal(ok, false, `${url} 不应接受 CLI Bearer`);
        assert.equal(res.statusCode, 403, `${url} 应返回 403`);
        assert.equal(stub.requests.length, 0, `${url} 不应触达身份服务`);
      }
    }],

    ['浏览器会话 Cookie 行为逐字不变', async () => {
      resetStub();
      const mod = await loadModule();
      prepareServiceEnv();
      const res = fakeResponse();
      const identity = await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/local-projects/demo-map/publish', method: 'POST', cookie: 'box_local_player_session=abc' }),
        res as never,
        'projects.edit',
      );
      assert.equal(identity?.subjectId, 'subject-creator-1');
      assert.equal(res.statusCode, 0);
      assert.equal(stub.requests.length, 1);
      assert.equal(stub.requests[0].cookie, 'box_local_player_session=abc');
      assert.equal('x-box-creator-authorization' in stub.requests[0], false, '无 Bearer 时不得转发 CLI 凭证');
    }],

    ['CLI 路由族不受影响：/api/creator/v1 场景控制仍按账号 projects.edit 放行', async () => {
      resetStub();
      const mod = await loadModule();
      prepareServiceEnv();
      const res = fakeResponse();
      const identity = await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/creator/v1/projects/demo-map/scene/session', method: 'POST', authorization: CLI_TOKEN }),
        res as never,
        'projects.edit',
      );
      assert.equal(identity?.subjectId, 'subject-creator-1');
      assert.equal(res.statusCode, 0);
      assert.equal(stub.requests.length, 1);
      assert.equal(stub.requests[0]['x-box-creator-authorization'], CLI_TOKEN);
    }],

    ['CLI 门自身语义不变：scope 命中放行、未命中 403', async () => {
      resetStub();
      const mod = await loadModule();
      prepareServiceEnv();
      let res = fakeResponse();
      assert.equal(await mod.allowAuthenticatedCreatorCliApi(
        fakeRequest({ url: '/api/creator/v1/projects', authorization: CLI_TOKEN }), res as never, 'projects.list',
      ), true);
      res = fakeResponse();
      assert.equal(await mod.allowAuthenticatedCreatorCliApi(
        fakeRequest({ url: '/api/creator/v1/projects/demo-map/scripts', authorization: CLI_TOKEN }), res as never, 'scripts.read',
      ), false);
      assert.equal(res.statusCode, 403);
      assert.equal((res.body as { code: string }).code, 'CREATOR_CLI_PERMISSION_DENIED');
    }],

    ['鉴权失败与权限不足的既有序列化结果不变', async () => {
      const mod = await loadModule();
      prepareServiceEnv();
      resetStub(baseIdentity({ creatorAccess: false }));
      let res = fakeResponse();
      assert.equal(await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/local-projects', cookie: 'box_local_player_session=abc' }), res as never, 'projects.view',
      ), undefined);
      assert.equal(res.statusCode, 403);
      assert.equal((res.body as { code: string }).code, 'CREATOR_ACCESS_REQUIRED');

      resetStub(baseIdentity({ creatorPermissions: ['projects.view'] }));
      res = fakeResponse();
      assert.equal(await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/local-projects/demo-map/export', cookie: 'box_local_player_session=abc' }), res as never, 'projects.export',
      ), undefined);
      assert.equal(res.statusCode, 403);
      assert.equal((res.body as { code: string }).code, 'CREATOR_PERMISSION_DENIED');

      resetStub(null);
      stub.status = 401;
      stub.message = 'AUTH_REQUIRED';
      res = fakeResponse();
      assert.equal(await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/local-projects', cookie: 'box_local_player_session=expired' }), res as never,
      ), undefined);
      assert.equal(res.statusCode, 401);
      assert.equal((res.body as { code: string }).code, 'AUTH_REQUIRED');
    }],

    ['非 Bearer 凭证与 Cookie 并存时不误伤：Authorization: Basic 仍走原路径', async () => {
      resetStub();
      const mod = await loadModule();
      prepareServiceEnv();
      const res = fakeResponse();
      const identity = await mod.authenticatedCreatorIdentity(
        fakeRequest({
          url: '/api/local-projects/demo-map/publish',
          method: 'POST',
          authorization: 'Basic dXNlcjpwYXNz',
          cookie: 'box_local_player_session=abc',
        }),
        res as never,
        'projects.edit',
      );
      assert.equal(identity?.subjectId, 'subject-creator-1');
      assert.equal('x-box-creator-authorization' in stub.requests[0], false);
    }],

    ['路径不可信时 fail closed：编码穿越不接受 Bearer，但 Cookie 照常工作', async () => {
      const mod = await loadModule();
      prepareServiceEnv();
      const traversals = [
        '/api/creator/v1/../../local-projects/demo-map/publish',
        '/api/creator/v1/%2e%2e/local-projects/demo-map/publish',
        '/api/creator/v1/%zz/broken',
      ];
      for (const url of traversals) {
        resetStub();
        const res = fakeResponse();
        assert.equal(await mod.authenticatedCreatorIdentity(
          fakeRequest({ url, method: 'POST', authorization: CLI_TOKEN }), res as never, 'projects.edit',
        ), undefined, `${url} 必须拒绝 Bearer`);
        assert.equal(res.statusCode, 403);
        assert.equal(stub.requests.length, 0);
      }
      resetStub();
      const res = fakeResponse();
      assert.equal((await mod.authenticatedCreatorIdentity(
        fakeRequest({ url: '/api/creator/v1/projects/demo-map/scripts/client/dir%2Fmain.js', authorization: CLI_TOKEN }),
        res as never, 'projects.edit',
      ))?.subjectId, 'subject-creator-1', '合法的百分号编码 CLI 路径不得被误判');
    }],

    ['谓词函数逐条可查', async () => {
      const mod = await loadModule();
      prepareServiceEnv();
      assert.equal(mod.usesCreatorCliBearer({ headers: { authorization: CLI_TOKEN } } as never), true);
      assert.equal(mod.usesCreatorCliBearer({ headers: { authorization: '   bearer bxc_x_y' } } as never), true);
      assert.equal(mod.usesCreatorCliBearer({ headers: { authorization: 'Bearer' } } as never), false);
      assert.equal(mod.usesCreatorCliBearer({ headers: { authorization: 'Bearer    ' } } as never), false);
      assert.equal(mod.usesCreatorCliBearer({ headers: {} } as never), false);
      assert.equal(mod.isCreatorCliApiRoute({ url: '/api/creator/v1/projects' } as never), true);
      assert.equal(mod.isCreatorCliApiRoute({ url: '/api/creator/v1' } as never), true);
      assert.equal(mod.isCreatorCliApiRoute({ url: '/api/creator/v1/projects?id=1' } as never), true);
      assert.equal(mod.isCreatorCliApiRoute({ url: 'http://localhost/api/creator/v1/health' } as never), true);
      assert.equal(mod.isCreatorCliApiRoute({ url: '/api/creator/v1x/projects' } as never), false);
      assert.equal(mod.isCreatorCliApiRoute({ url: '/api/local-projects' } as never), false);
      assert.equal(mod.isCreatorCliApiRoute({ url: '' } as never), false);
      assert.equal(mod.rejectsCreatorCliBearerOnUiRoute({ headers: { authorization: CLI_TOKEN }, url: '/api/local-projects' } as never), true);
      assert.equal(mod.rejectsCreatorCliBearerOnUiRoute({ headers: {}, url: '/api/local-projects' } as never), false);
    }],

    ['一键回退开关恢复旧行为', async () => {
      const mod = await loadModule();
      prepareServiceEnv();
      await withEnv({ BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES: 'true' }, async () => {
        resetStub();
        const res = fakeResponse();
        assert.equal(mod.rejectsCreatorCliBearerOnUiRoute(
          { headers: { authorization: CLI_TOKEN }, url: '/api/local-projects/demo-map/publish' } as never,
        ), false, '开关置为 true 后谓词必须放行（回退到改造前行为）');
        const identity = await mod.authenticatedCreatorIdentity(
          fakeRequest({ url: '/api/local-projects/demo-map/publish', method: 'POST', authorization: CLI_TOKEN }),
          res as never, 'projects.edit',
        );
        assert.equal(identity?.subjectId, 'subject-creator-1', '回退后连真实门都必须恢复改造前的放行结果');
      });
      await withEnv({ BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES: 'TRUE' }, async () => {
        assert.equal(mod.rejectsCreatorCliBearerOnUiRoute(
          { headers: { authorization: CLI_TOKEN }, url: '/api/local-projects' } as never,
        ), true, '只有字面量 true 才是回退开关');
      });
      await withEnv({ BOX_CREATOR_ALLOW_CLI_BEARER_ON_UI_ROUTES: undefined }, async () => {
        assert.equal(mod.rejectsCreatorCliBearerOnUiRoute(
          { headers: { authorization: CLI_TOKEN }, url: '/api/local-projects' } as never,
        ), true, '开关撤销后收紧必须默认生效');
      });
    }],

    ['模式门与主机门优先级不变（非 creator 模式仍然先 404）', async () => {
      const mod = await loadModule();
      prepareServiceEnv();
      resetStub();
      await withEnv({ BOX_DEPLOYMENT_MODE: 'play' }, async () => {
        const res = fakeResponse();
        assert.equal(await mod.authenticatedCreatorIdentity(
          fakeRequest({ url: '/api/local-projects/demo-map/publish', method: 'POST', authorization: CLI_TOKEN }),
          res as never, 'projects.edit',
        ), undefined);
        assert.equal(res.statusCode, 404);
        assert.equal(stub.requests.length, 0);
      });
    }],
  ];
  return cases;
}

const globals = globalThis as unknown as {
  describe?: (name: string, fn: () => void) => void;
  test?: (name: string, fn: () => void | Promise<void>) => void;
  jest?: { doMock?: (moduleName: string, factory: () => unknown) => void };
};

if (typeof globals.describe === 'function' && typeof globals.test === 'function') {
  // Jest mode: the generated identity client is replaced by the recording stub.
  let cached: Module | undefined;
  const load = async (): Promise<Module> => {
    globals.jest?.doMock?.('@box/apis', () => ({ ApiClient: StubApiClient }));
    cached ||= await import('./creator-api-security');
    return cached;
  };
  globals.describe('creator api security: CLI Bearer 与 Creator UI 路由必须分门', () => {
    for (const [name, fn] of buildCases(load)) globals.test!(name, fn);
  });
} else {
  const bootstrap = async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-creator-security-stub-'));
    const stubFile = path.join(directory, 'box-apis-stub.mjs');
    fs.writeFileSync(stubFile, [
      'export class ApiClient {',
      '  constructor(options) { this.inner = new globalThis.__boxCreatorStubApiClient(options); }',
      '  postApiPlayerInternalRuntimeIdentityRaw(init) { return this.inner.postApiPlayerInternalRuntimeIdentityRaw(init); }',
      '}',
    ].join('\n'));
    const stubUrl = pathToFileURL(stubFile).href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@box/apis') return { url: stubUrl, format: 'module', shortCircuit: true };
        if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith('file:')) {
          const base = new URL(specifier, context.parentURL);
          for (const candidate of [base.href, `${base.href}.ts`, `${base.href}.js`, `${base.href}/index.ts`]) {
            try {
              if (fs.existsSync(new URL(candidate))) return nextResolve(candidate, context);
            } catch { /* 继续尝试下一个候选 */ }
          }
        }
        return nextResolve(specifier, context);
      },
    });
    let cached: Module | undefined;
    const cases = buildCases(async () => {
      cached ||= await import('./creator-api-security');
      return cached;
    });
    let failures = 0;
    for (const [name, fn] of cases) {
      try {
        await fn();
        console.log(`ok - ${name}`);
      } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}`);
        console.error((error as Error).stack || error);
      }
    }
    console.log(`# ${cases.length - failures}/${cases.length} passed`);
    fs.rmSync(directory, { recursive: true, force: true });
    if (failures) process.exitCode = 1;
  };
  void bootstrap();
}

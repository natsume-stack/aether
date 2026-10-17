import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  buildPublicPlaySiteConfig,
  defaultPlaySiteConfig,
  getPlaySiteConfig,
  getPublicPlaySiteConfig,
  savePlaySiteConfig,
  siteConfigPath,
  worldMatchesTab,
} from './play-site-config';
import { allowPlayLibraryAdmin } from './play-admin-security';
import { getPlayWorlds } from './play-worlds';
import type { PlayWorld } from './play-worlds';

const trackedEnvKeys = [
  'BOX_PLAY_SITE_CONFIG_PATH',
  'BOX_PLAY_LIBRARY_PATH',
  'BOX_DEPLOYMENT_MODE',
  'BOX_PLAY_ADMIN_TOKEN',
  'BOX_TRUST_PROXY',
];

function withTempSite<T>(run: (directory: string, configPath: string) => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of trackedEnvKeys) previous[key] = process.env[key];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-site-config-'));
  process.env.BOX_PLAY_SITE_CONFIG_PATH = path.join(directory, 'site-config.json');
  try {
    return run(directory, process.env.BOX_PLAY_SITE_CONFIG_PATH);
  } finally {
    for (const key of trackedEnvKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function withTempSiteAsync<T>(run: (directory: string, configPath: string) => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of trackedEnvKeys) previous[key] = process.env[key];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-site-config-'));
  process.env.BOX_PLAY_SITE_CONFIG_PATH = path.join(directory, 'site-config.json');
  try {
    return await run(directory, process.env.BOX_PLAY_SITE_CONFIG_PATH);
  } finally {
    for (const key of trackedEnvKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function installWorldFixture(directory: string, options: {
  id: string;
  permissionHash: string;
  statePermissionHash: string;
  createdAt?: string;
  cover?: string;
  projectName?: string;
}) {
  const worldRoot = path.join(directory, options.id);
  fs.mkdirSync(path.join(worldRoot, 'data', 'blobs'), { recursive: true });
  const manifest: Record<string, unknown> = {
    id: options.id,
    permanentMapId: '20000000000000000099',
    publicId: options.id,
    projectName: options.projectName || options.id,
    author: 'unit-test',
    description: '',
    cover: options.cover || '',
    version: 'v1.0.0',
    permissionHash: options.permissionHash,
    mapGroupId: options.id,
    mapRole: 'main',
    mainProjectId: options.id,
    playEnabled: true,
  };
  if (options.createdAt) manifest.createdAt = options.createdAt;
  fs.writeFileSync(path.join(worldRoot, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(worldRoot, 'data', 'project-state.json'),
    JSON.stringify({ permissionHash: options.statePermissionHash }),
  );
  return worldRoot;
}

function fakeAdminResponse() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
    setHeader(key: string, value: string) { res.headers[key] = String(value); },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
    end() { res.ended = true; return res; },
  };
  return res;
}

function fakeAdminRequest(token: string, remoteAddress: string) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress },
  };
}

const sampleWorld: PlayWorld = {
  id: 'demo-map',
  permanentMapId: '20000000000000000001',
  publicId: 'demo-map',
  name: '演示地图',
  author: '作者',
  description: '',
  cover: '/map-templates/demo.png',
  version: 'v1.0.0',
  mapGroupId: 'demo-map',
  mapRole: 'main',
  mainProjectId: 'demo-map',
  playEnabled: true,
};

const cases: Array<[string, () => void | Promise<void>]> = [
  ['文件缺失时返回结构完整的默认值', () => {
    withTempSite((_directory, _configPath) => {
      const config = getPlaySiteConfig();
      assert.deepEqual(config, defaultPlaySiteConfig());
      assert.equal(config.banner.heightPx, 320);
      assert.equal(config.banner.autoplayMs, 6000);
      assert.deepEqual(config.tabs, [{ key: 'all', label: '地图展厅', match: {} }]);
      assert.equal(siteConfigPath(), _configPath);
    });
  }],

  ['JSON 损坏时降级默认值并记录可诊断日志（非静默）', () => {
    withTempSite((_directory, configPathValue) => {
      fs.writeFileSync(configPathValue, '{ this is not json');
      const captured: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
      try {
        const config = getPlaySiteConfig();
        assert.deepEqual(config, defaultPlaySiteConfig());
      } finally {
        console.error = original;
      }
      assert.equal(captured.length, 1);
      assert.match(captured[0], /\[play-site-config\]/);
      assert.match(captured[0], /不是合法 JSON/);
      assert.match(captured[0], /已降级为默认配置/);
    });
  }],

  ['schema 不匹配时降级默认值并记日志', () => {
    withTempSite((_directory, configPathValue) => {
      fs.writeFileSync(configPathValue, JSON.stringify({ schema: 2, banner: { images: [] } }));
      const captured: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
      try {
        assert.deepEqual(getPlaySiteConfig(), defaultPlaySiteConfig());
      } finally {
        console.warn = original;
      }
      assert.equal(captured.length, 1);
      assert.match(captured[0], /schema=2 不受支持/);
    });
  }],

  ['原子写入：临时文件 + rename，保留上一版 .bak', () => {
    withTempSite((directory, configPathValue) => {
      const first = savePlaySiteConfig({
        banner: { images: [{ src: '/static/a.png' }], heightPx: 400 },
        footer: { text: '第一版' },
      }, { merge: false });
      assert.equal(first.footer.text, '第一版');
      const second = savePlaySiteConfig({ footer: { text: '第二版' } }, { merge: false });
      assert.equal(second.footer.text, '第二版');
      assert.equal(JSON.parse(fs.readFileSync(configPathValue, 'utf8')).footer.text, '第二版');
      assert.equal(JSON.parse(fs.readFileSync(`${configPathValue}.bak`, 'utf8')).footer.text, '第一版');
      const leftovers = fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    });
  }],

  ['PATCH 按区块合并，PUT 全量替换', () => {
    withTempSite(() => {
      savePlaySiteConfig({
        banner: { images: [{ src: '/static/a.png' }], autoplayMs: 8000 },
        announcement: { text: '公告一' },
      }, { merge: false });
      const patched = savePlaySiteConfig({ announcement: { text: '公告二' } }, { merge: true });
      assert.equal(patched.announcement.text, '公告二');
      assert.equal(patched.banner.autoplayMs, 8000);
      assert.equal(patched.banner.images.length, 1);
      const replaced = savePlaySiteConfig({ footer: { text: '只留页脚' } }, { merge: false });
      assert.equal(replaced.announcement.text, '');
      assert.equal(replaced.banner.images.length, 0);
      assert.equal(replaced.banner.heightPx, 320);
    });
  }],

  ['目录穿越与非法图源被拒绝', () => {
    withTempSite(() => {
      const rejected = [
        '../../etc/passwd',
        '/a/../../b.png',
        '//evil.example.com/x.png',
        'http://evil.example.com/x.png',
        'javascript:alert(1)',
        'data:image/png;base64,AAAA',
        'C:\\Windows\\system32\\config',
        '/static/a.png?download=1',
        '/static/%2e%2e/x',
      ];
      for (const src of rejected) {
        assert.throws(
          () => savePlaySiteConfig({ banner: { images: [{ src }] } }, { merge: false }),
          (error: Error) => /banner|站内|HTTPS|越权|协议|非法/.test(error.message),
          `应当拒绝 src=${src}`,
        );
      }
      const accepted = savePlaySiteConfig({
        banner: {
          images: [
            { src: '/map-templates/a.png' },
            { src: 'https://cdn.example.com/banner.jpg', href: 'https://example.com/docs' },
          ],
        },
      }, { merge: false });
      assert.equal(accepted.banner.images.length, 2);
      assert.throws(
        () => savePlaySiteConfig({ banner: { images: [{ worldId: '..bad id..' }] } }, { merge: false }),
        /地图 ID 不合法/,
      );
      assert.throws(
        () => savePlaySiteConfig({ banner: { heightPx: 100_000 } }, { merge: false }),
        /120 到 720/,
      );
      assert.throws(
        () => savePlaySiteConfig({ secretField: 1 }, { merge: false }),
        /不支持的配置字段/,
      );
    });
  }],

  ['并发写入不产生半截文件，终态为其中一版', async () => {
    await withTempSiteAsync(async (directory, configPathValue) => {
      const childPath = path.join(directory, 'writer.mjs');
      // 子进程用 Node 原生 TS 执行；仓库源码 import 无扩展名（jest/webpack 惯例），
      // 这里注册 .ts 解析钩子仅服务于本地直跑验证。
      fs.writeFileSync(childPath, [
        "import { registerHooks } from 'node:module';",
        "import { existsSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        'registerHooks({ resolve(specifier, context, nextResolve) {',
        "  if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith('file:')) {",
        '    const base = new URL(specifier, context.parentURL);',
        '    if (existsSync(fileURLToPath(base))) return nextResolve(base.href, context);',
        "    for (const suffix of ['.ts', '.js', '/index.ts', '/index.js']) {",
        '      const candidate = new URL(base.href + suffix);',
        '      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);',
        '    }',
        '  }',
        '  return nextResolve(specifier, context);',
        '}});',
        'const [moduleUrl, payload] = process.argv.slice(2);',
        'const mod = await import(moduleUrl);',
        'mod.savePlaySiteConfig(JSON.parse(payload), { merge: false });',
      ].join('\n'));
      const moduleUrl = pathToFileURL(path.join(process.cwd(), 'server', 'play-site-config.ts')).href;
      const run = (label: string) => new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [childPath, moduleUrl, JSON.stringify({
          footer: { text: `并发-${label}` },
        })], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.stdout.resume();
        child.on('error', reject);
        child.on('close', (code) => {
          if (code) reject(new Error(`child ${label} exited ${code}: ${stderr}`));
          resolve(code ?? 0);
        });
      });
      const codes = await Promise.all([run('A'), run('B'), run('C')]);
      assert.deepEqual(codes, [0, 0, 0]);
      const final = JSON.parse(fs.readFileSync(configPathValue, 'utf8'));
      assert.match(final.footer.text, /^并发-[ABC]$/);
      const leftovers = fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    });
  }],

  ['worldId 引用解析为地图 cover 与 /p/<publicId>，公开形状符合契约', () => {
    withTempSite(() => {
      const config = savePlaySiteConfig({
        banner: {
          images: [
            { worldId: 'demo-map' },
            { worldId: 'missing-map', src: '' },
            { src: '/static/custom.png', href: '/p/other', title: '自定义标题', subtitle: '副标题' },
          ],
        },
      }, { merge: false });
      const pub = buildPublicPlaySiteConfig(config, [sampleWorld]);
      assert.deepEqual(Object.keys(pub).sort(), ['announcement', 'banner', 'footer', 'schema', 'tabs']);
      assert.equal(pub.banner.images.length, 2, '缺失地图且无 src 的项被丢弃');
      assert.deepEqual(pub.banner.images[0], {
        src: '/map-templates/demo.png',
        href: '/p/demo-map',
        title: '演示地图',
        subtitle: '',
      });
      assert.deepEqual(Object.keys(pub.banner.images[0]).sort(), ['href', 'src', 'subtitle', 'title']);
      assert.deepEqual(pub.banner.images[1], {
        src: '/static/custom.png',
        href: '/p/other',
        title: '自定义标题',
        subtitle: '副标题',
      });
      assert.equal(JSON.stringify(pub).includes('demo-map"'), true);
      assert.equal('worldId' in pub.banner.images[0], false, '公开端点不得泄漏存储字段');
    });
  }],

  ['getPublicPlaySiteConfig 端到端（真实 getPlayWorlds + 缺失文件默认值）', () => {
    withTempSite((directory) => {
      process.env.BOX_PLAY_LIBRARY_PATH = path.join(directory, 'play-worlds');
      installWorldFixture(installWorldFixtureRoot(process.env.BOX_PLAY_LIBRARY_PATH, 'demo-map'), {
        id: 'demo-map',
        permissionHash: 'hash-1',
        statePermissionHash: 'hash-1',
        cover: '/map-templates/demo.png',
      });
      const pub = getPublicPlaySiteConfig();
      assert.deepEqual(pub.banner.images, []);
      assert.deepEqual(pub.tabs, [{ key: 'all', label: '地图展厅', match: {} }]);
      savePlaySiteConfig({ banner: { images: [{ worldId: 'demo-map' }] } }, { merge: false });
      assert.deepEqual(getPublicPlaySiteConfig().banner.images, [{
        src: '/map-templates/demo.png',
        href: '/p/demo-map',
        title: 'demo-map',
        subtitle: '',
      }]);
    });
  }],

  ['默认存储路径推导为地图库目录内，且库内配置文件不会被当作地图', () => {
    const previous = { ...process.env };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-site-derive-'));
    try {
      delete process.env.BOX_PLAY_SITE_CONFIG_PATH;
      delete process.env.BOX_PLAY_LIBRARY_PATH;
      assert.equal(siteConfigPath(), null, '两个环境变量都缺失时应返回 null（读取端仍给默认值）');
      assert.deepEqual(getPlaySiteConfig(), defaultPlaySiteConfig());
      const libraryRoot = path.join(directory, 'play-worlds');
      fs.mkdirSync(libraryRoot, { recursive: true });
      process.env.BOX_PLAY_LIBRARY_PATH = libraryRoot;
      assert.equal(siteConfigPath(), path.join(libraryRoot, 'site-config.json'));
      savePlaySiteConfig({ footer: { text: '默认路径写入' } }, { merge: false });
      assert.ok(fs.existsSync(path.join(libraryRoot, 'site-config.json')));
      assert.deepEqual(getPlayWorlds(), [], '库内的 site-config.json 不得被 getPlayWorlds 当作地图');
    } finally {
      for (const key of trackedEnvKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }],

  ['tab match 语义：空对象命中全部，字段按地图组/角色/公开 ID 过滤', () => {
    const sub: PlayWorld = { ...sampleWorld, id: 'demo-sub', publicId: 'demo-sub', mapRole: 'submap', mapGroupId: 'demo-map' };
    assert.equal(worldMatchesTab(sampleWorld, {}), true);
    assert.equal(worldMatchesTab(sampleWorld, { mapGroupId: 'demo-map' }), true);
    assert.equal(worldMatchesTab(sampleWorld, { mapGroupId: 'other' }), false);
    assert.equal(worldMatchesTab(sampleWorld, { mapRole: 'main' }), true);
    assert.equal(worldMatchesTab(sub, { mapRole: 'main' }), false);
    assert.equal(worldMatchesTab(sub, { publicId: 'demo-sub' }), true);
    assert.equal(worldMatchesTab({ ...sampleWorld, mapGroupId: undefined as unknown as string }, { mapGroupId: 'demo-map' }), true,
      'mapGroupId 缺失时按 mainProjectId/id 兜底，与首页分组规则一致');
  }],

  ['getPlayWorlds 回归：updatedAt 取自 manifest.createdAt，permissionHash 校验未放松', () => {
    withTempSite((directory) => {
      const libraryRoot = path.join(directory, 'play-worlds');
      const worldDirectory = installWorldFixture(libraryRoot, {
        id: 'demo-map',
        permissionHash: 'hash-1',
        statePermissionHash: 'hash-1',
        createdAt: '2026-01-02T03:04:05.000Z',
        cover: '/map-templates/demo.png',
      });
      void worldDirectory;
      process.env.BOX_PLAY_LIBRARY_PATH = libraryRoot;
      const worlds = getPlayWorlds();
      assert.equal(worlds.length, 1);
      const world = worlds[0];
      assert.equal(world.updatedAt, '2026-01-02T03:04:05.000Z');
      assert.equal('browseCount' in world, false, '无计数来源，本轮不提供 browseCount');
      assert.equal(world.name, 'demo-map');
      assert.equal(world.cover, '/map-templates/demo.png');
      installWorldFixture(libraryRoot, {
        id: 'bad-hash',
        permissionHash: 'hash-1',
        statePermissionHash: 'hash-2',
      });
      assert.deepEqual(getPlayWorlds().map((item) => item.id), ['demo-map'], 'permissionHash 不一致必须丢弃');
      const noCreatedAt = installWorldFixture(libraryRoot, {
        id: 'legacy-map',
        permissionHash: 'hash-3',
        statePermissionHash: 'hash-3',
      });
      fs.utimesSync(path.join(noCreatedAt, 'manifest.json'), new Date('2025-05-05T00:00:00Z'), new Date('2025-05-05T00:00:00Z'));
      const legacy = getPlayWorlds().find((item) => item.id === 'legacy-map');
      assert.equal(legacy?.updatedAt, new Date('2025-05-05T00:00:00Z').toISOString(), '缺 createdAt 时回退 manifest mtime');
    });
  }],

  ['鉴权：复用 allowPlayLibraryAdmin，模式不符 404、坏密钥 401、正确密钥放行', () => {
    withTempSite(() => {
      process.env.BOX_PLAY_SITE_CONFIG_PATH = '';
      process.env.BOX_DEPLOYMENT_MODE = 'creator';
      process.env.BOX_PLAY_LIBRARY_PATH = '/tmp/not-used';
      process.env.BOX_PLAY_ADMIN_TOKEN = 'unit-test-admin-token-0123456789';
      let res = fakeAdminResponse();
      assert.equal(allowPlayLibraryAdmin(fakeAdminRequest('unit-test-admin-token-0123456789', '10.0.0.1') as never, res as never), false);
      assert.equal(res.statusCode, 404);

      process.env.BOX_DEPLOYMENT_MODE = 'play';
      res = fakeAdminResponse();
      assert.equal(allowPlayLibraryAdmin(fakeAdminRequest('wrong-token', '10.0.0.2') as never, res as never), false);
      assert.equal(res.statusCode, 401);
      assert.equal((res.body as { message: string }).message, '服主密钥错误');

      res = fakeAdminResponse();
      assert.equal(allowPlayLibraryAdmin(fakeAdminRequest('', '10.0.0.3') as never, res as never), false);
      assert.equal(res.statusCode, 401);

      res = fakeAdminResponse();
      assert.equal(allowPlayLibraryAdmin(fakeAdminRequest('unit-test-admin-token-0123456789', '10.0.0.4') as never, res as never), true);
    });
  }],
];

function installWorldFixtureRoot(libraryRoot: string, id: string) {
  fs.mkdirSync(libraryRoot, { recursive: true });
  return libraryRoot;
}

const jestGlobals = globalThis as unknown as {
  describe?: (name: string, fn: () => void) => void;
  test?: (name: string, fn: () => void | Promise<void>) => void;
};

if (typeof jestGlobals.describe === 'function' && typeof jestGlobals.test === 'function') {
  jestGlobals.describe('play site config', () => {
    for (const [name, fn] of cases) jestGlobals.test!(name, fn);
  });
} else {
  const runStandalone = async () => {
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
    if (failures) process.exitCode = 1;
  };
  void runStandalone();
}

import { fileURLToPath } from 'node:url';
('use strict');

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portalRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(portalRoot, '../..');
// 官方集成检查在引擎仓库里运行；导出的独立模板不依赖父目录。
const integrated = existsSync(path.join(repositoryRoot, 'docker-compose.yml'));
const dockerfile = integrated ? readFileSync(path.join(portalRoot, 'Dockerfile'), 'utf8') : '';
const dockerignore = integrated
    ? readFileSync(path.join(repositoryRoot, '.dockerignore'), 'utf8')
    : '';
const compose = integrated
    ? readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8')
    : '';
const browserApp = readFileSync(path.join(portalRoot, 'public/app.js'), 'utf8');
const readSource = (directory:string):string =>
    readdirSync(directory, { withFileTypes: true })
        .map((entry) =>
            entry.isDirectory()
                ? readSource(path.join(directory, entry.name))
                : /\.(ts|tsx)$/.test(entry.name)
                  ? readFileSync(path.join(directory, entry.name), 'utf8')
                  : '',
        )
        .join('\n');
const browserSource = readSource(path.join(portalRoot, 'src'));
const portalHtml = readFileSync(path.join(portalRoot, 'public/index.html'), 'utf8');

test(
    'official container starts without activation and copies only runtime source',
    { skip: !integrated },
    () => {
        assert.match(
            dockerfile,
            /COPY --from=build --chown=node:node \/build\/build\/server\.cjs \.\/build\/server\.cjs/,
        );
        assert.match(dockerfile, /COPY --from=build --chown=node:node \/build\/public \.\/public/);
        assert.doesNotMatch(dockerfile, /COPY[^\n]*\.env/i);
        assert.match(dockerfile, /USER node/);
        assert.doesNotMatch(dockerfile, /runtime-gate|process-guard|BOX_LICENSE/);
        assert.match(dockerfile, /CMD \["node", "build\/server.cjs"\]/);
        assert.match(dockerignore, /^\.env$/m);
    },
);

test(
    'Compose keeps the auth key server-side and uses Player Service over its internal URL',
    { skip: !integrated },
    () => {
        const service = compose.slice(
            compose.indexOf('  player-auth-portal:'),
            compose.indexOf('\n  server-manager:', compose.indexOf('  player-auth-portal:')),
        );
        assert.match(service, /AUTH_DEMO_API_KEY: \$\{BOX_PLAYER_AUTH_API_KEY:-\}/);
        assert.match(service, /AUTH_DEMO_PLAYER_SERVICE_URL: http:\/\/player-service:3213/);
        assert.match(service, /AUTH_DEMO_HOST: 0\.0\.0\.0/);
        assert.match(service, /read_only: true/);
        assert.match(service, /pull_policy: never/);
        assert.match(service, /tmpfs:\s*\n\s*- \/tmp:mode=1777/);
        assert.match(service, /BOX_PLAYER_AUTH_API_KEY: \$\{BOX_PLAYER_AUTH_API_KEY:-\}/);
        assert.match(service, /BOX_PLAYER_SERVICE_INTERNAL_URL: http:\/\/player-service:3213/);
        assert.doesNotMatch(
            browserSource + browserApp,
            /AUTH_DEMO_API_KEY|BOX_PLAYER_AUTH_API_KEY/,
        );
    },
);

test('standalone image is buildable without engine sources and excludes development mocks and credentials', () => {
    const standalone = readFileSync(path.join(portalRoot, 'Dockerfile.standalone'), 'utf8');
    assert.match(standalone, /npm ci --include=dev --ignore-scripts/);
    assert.match(standalone, /COPY --from=build --chown=node:node \/build\/build\/server\.cjs/);
    assert.match(standalone, /HEALTHCHECK/);
    assert.match(standalone, /USER node/);
    assert.doesNotMatch(
        standalone,
        /COPY[^\n]*(?:\.env|mock-player-service|packages\/license|\. \.|node_modules)/,
    );
    const ignore = readFileSync(path.join(portalRoot, '.dockerignore'), 'utf8');
    assert.ok(ignore.startsWith('*\n'));
    assert.doesNotMatch(ignore, /!\.env/);
});

test('standalone template and image include the MIT permission text', () => {
    const license = readFileSync(path.join(portalRoot, 'LICENSE'), 'utf8');
    assert.match(license, /^MIT License/);
    assert.match(license, /copyright notice and this permission notice/);
    const tasks = readFileSync(path.join(portalRoot, 'scripts/tasks.ts'), 'utf8');
    assert.match(tasks, /'README.md',\s*'LICENSE',/);
    assert.match(readFileSync(path.join(portalRoot, '.dockerignore'), 'utf8'), /^!LICENSE$/m);
    assert.match(
        readFileSync(path.join(portalRoot, 'Dockerfile.standalone'), 'utf8'),
        /COPY --chown=node:node LICENSE \.\/LICENSE/,
    );
});

test('disabled registration removes the redundant authentication tabs', () => {
    assert.match(browserSource, /if \(!this\.state\.registrationEnabled\)/);
    assert.match(browserSource, /this\.renderForm\(\)/);
    assert.match(browserSource, /<Tabs\.Root/);
});

test('browser interface is bundled from React and Radix without a CDN dependency', () => {
    assert.match(browserSource, /from 'react-dom\/client'/);
    assert.match(browserSource, /import \{ Tabs \} from 'radix-ui'/);
    assert.match(portalHtml, /<div id="root"><\/div>/);
    assert.doesNotMatch(portalHtml, /https?:\/\//);
    assert.ok(browserApp.length > 0);
});

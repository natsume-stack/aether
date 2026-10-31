'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { packagingContext } = require('./packaging-context');

const root = path.resolve(__dirname, '..');
const architectureByNode = { x64: 'amd64', arm64: 'arm64' };
const architecture = process.argv[2] || architectureByNode[process.arch];
const local = process.argv.includes('--local');
const selectedService = process.argv[3]?.startsWith('--') ? '' : process.argv[3] || '';
const supportedArchitectures = new Set(['amd64', 'arm64']);
const services = [
    'player-service',
    'player-auth-portal',
    'server-manager',
    'creator',
    'play',
    'voxa',
];

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

if (!supportedArchitectures.has(architecture)) {
    fail('用法: rush package-images --architecture <amd64|arm64> [--service 服务名]');
}
if (selectedService && !services.includes(selectedService)) {
    fail(`未知服务：${selectedService}；可选值：${services.join('、')}`);
}

const { channel, version } = packagingContext(
    process.env,
    require(path.join(root, 'package.json')).version,
);
const tag = `v${version}-linux-${architecture}`;
const outputDirectory =
    local && process.env.BOX_LOCAL_IMAGE_DIRECTORY
        ? path.resolve(process.env.BOX_LOCAL_IMAGE_DIRECTORY)
        : path.join(
              root,
              local ? 'apps/local-engine/dist/local-images' : 'apps/local-engine/dist/images',
          );
const packagedServices = selectedService ? [selectedService] : services;
const output = path.join(
    outputDirectory,
    `box-local-engine-images-${tag}${selectedService ? `-${selectedService}` : ''}.tar.gz`,
);
const environment = {
    ...process.env,
    BOX_IMAGE_TAG: tag,
    BOX_PLAY_PLATFORM: `linux/${architecture}`,
    DOCKER_DEFAULT_PLATFORM: `linux/${architecture}`,
    BOX_BUILD_CHANNEL: channel,
    BOX_BUILD_VERSION: channel === 'dev' ? version : process.env.BOX_BUILD_VERSION || `v${version}`,
    BOX_BUILD_DATE: process.env.BOX_BUILD_DATE || new Date().toISOString(),
    BOX_BUILD_SOURCE: process.env.BOX_BUILD_SOURCE || 'local',
};

for (const service of packagedServices) {
    // `docker compose build` on an ARM desktop may still build the host
    // architecture even when DOCKER_DEFAULT_PLATFORM is set. Bake receives an
    // explicit target platform and loads that single-platform image locally so
    // the exported archive always matches its filename.
    const result = local
        ? { status: 0 }
        : spawnSync(
              'docker',
              [
                  'buildx',
                  'bake',
                  '--load',
                  '--set',
                  `${service}.platform=linux/${architecture}`,
                  service,
              ],
              {
                  cwd: root,
                  env: environment,
                  stdio: 'inherit',
              },
          );
    if (result.status !== 0) {
        fail(`构建 ${service} 镜像失败，退出码 ${result.status ?? 'unknown'}`);
    }

    const image = `box-local-engine-${service}:${tag}`;
    const inspectedArchitecture = spawnSync(
        'docker',
        ['image', 'inspect', image, '--format', '{{.Architecture}}'],
        { cwd: root, env: environment, encoding: 'utf8' },
    );
    if (inspectedArchitecture.status !== 0) {
        fail(`无法检查 ${service} 镜像架构`);
    }
    if (inspectedArchitecture.stdout.trim() !== architecture) {
        fail(
            `${service} 镜像实际为 ${inspectedArchitecture.stdout.trim() || 'unknown'}，期望 ${architecture}；已拒绝导出错误架构的归档`,
        );
    }
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.rmSync(output, { force: true });
const save = spawn(
    'docker',
    ['image', 'save', ...packagedServices.map((service) => `box-local-engine-${service}:${tag}`)],
    {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'pipe', 'inherit'],
    },
);
const outputDescriptor = fs.openSync(output, 'w');
const gzip = spawn('gzip', ['-1'], { stdio: ['pipe', outputDescriptor, 'inherit'] });
save.stdout.pipe(gzip.stdin);

Promise.all([
    new Promise((resolve) => save.once('close', resolve)),
    new Promise((resolve) => gzip.once('close', resolve)),
]).then(([saveStatus, gzipStatus]) => {
    fs.closeSync(outputDescriptor);
    if (saveStatus !== 0 || gzipStatus !== 0) {
        fs.rmSync(output, { force: true });
        fail('导出离线镜像归档失败');
    }
    console.log(`Offline image archive: ${output}`);
});

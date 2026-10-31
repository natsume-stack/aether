'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'distribution/server/.env.example'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'distribution/server/install.sh'), 'utf8');
const bootstrapInstaller = fs.readFileSync(
    path.join(root, 'distribution/server/bootstrap.sh'),
    'utf8',
);

function executable(file, source) {
    fs.writeFileSync(file, source, { mode: 0o755 });
}

function readValue(source, key) {
    return source.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] || '';
}

function runInstaller(existingEnvironment) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-server-install-'));
    const bin = path.join(temporaryRoot, 'bin');
    try {
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(temporaryRoot, '.env.example'), template);
        fs.writeFileSync(
            path.join(temporaryRoot, 'install.sh'),
            installer
                .replace('if [ ! -s /etc/machine-id ]; then', 'if false; then')
                .replaceAll('__MANAGER_IMAGE_ARCHIVE__', 'manager-image.tar.gz'),
            { mode: 0o755 },
        );
        executable(path.join(temporaryRoot, 'verify.sh'), '#!/bin/sh\nexit 0\n');
        const managerArchive = 'manager-image.tar.gz';
        const managerArchiveBytes = 'fixture';
        const managerArchiveSha = crypto
            .createHash('sha256')
            .update(managerArchiveBytes)
            .digest('hex');
        fs.mkdirSync(path.join(temporaryRoot, 'cache/engine-images'), { recursive: true });
        fs.writeFileSync(
            path.join(temporaryRoot, 'cache/engine-images', managerArchive),
            managerArchiveBytes,
        );
        fs.writeFileSync(path.join(temporaryRoot, 'BOX3-IMAGE-CATALOG.json'), '{}');
        fs.writeFileSync(
            path.join(temporaryRoot, 'BOX3-MANAGER-IMAGE.json'),
            `{
  "sha256": "${managerArchiveSha}",
  "size": 7,
  "contentTag": "box-local-engine-server-manager:launcher-content-fixture"
}\n`,
        );
        if (existingEnvironment) {
            fs.writeFileSync(path.join(temporaryRoot, '.env'), existingEnvironment);
        }
        executable(
            path.join(bin, 'docker'),
            `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$*" in
  *'image inspect'*) printf 'amd64\\n' ;;
esac
exit 0
`,
        );
        executable(path.join(bin, 'uname'), '#!/bin/sh\nprintf "x86_64\\n"\n');
        const result = spawnSync('sh', ['./install.sh'], {
            cwd: temporaryRoot,
            env: {
                ...process.env,
                PATH: `${bin}:/usr/bin:/bin`,
                DOCKER_CALL_LOG: path.join(temporaryRoot, 'docker-calls.log'),
            },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const calls = fs.readFileSync(path.join(temporaryRoot, 'docker-calls.log'), 'utf8');
        assert.match(calls, /image rm box-local-engine-server-manager:launcher-content-fixture/);
        assert.ok(
            calls.indexOf('tag box-local-engine-server-manager:launcher-content-fixture') <
                calls.indexOf('image rm box-local-engine-server-manager:launcher-content-fixture'),
        );
        return fs.readFileSync(path.join(temporaryRoot, '.env'), 'utf8');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

for (const [name, existingEnvironment] of [
    ['a new installation', undefined],
    [
        'an upgrade from an environment created before the runtime manager token existed',
        [
            'BOX_IMAGE_TAG=v0.2.0-linux-amd64',
            'BOX_PLAY_PLATFORM=linux/amd64',
            `BOX_SERVER_MANAGER_TOKEN=${'a'.repeat(64)}`,
            'PRESERVED_OPERATOR_SETTING=yes',
            '',
        ].join('\n'),
    ],
]) {
    test(`server installer provisions BOX_RUNTIME_MANAGER_TOKEN for ${name}`, () => {
        const environment = runInstaller(existingEnvironment);
        assert.match(
            readValue(environment, 'BOX_RUNTIME_MANAGER_TOKEN'),
            /^[a-f0-9]{64}$/,
            'the runtime manager token must be a 32-byte secret accepted by server-manager',
        );
        assert.match(readValue(environment, 'BOX_SERVER_MANAGER_TOKEN'), /^[a-f0-9]{64}$/);
        if (existingEnvironment) {
            assert.match(environment, /^PRESERVED_OPERATOR_SETTING=yes$/m);
        }
    });
}

function runDockerBootstrap({
    existing = false,
    composeMissing = false,
    podman = false,
    downloadFails = false,
    installFails = false,
    distribution = 'ubuntu',
    distributionVersion = '24.04',
    distributionCodename = 'noble',
    nativeFails = false,
    architecture = 'amd64',
    nativePackageManager = 'dnf',
    releaseverPlugin = false,
} = {}) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-docker-bootstrap-'));
    try {
        const bin = path.join(temporaryRoot, 'bin');
        const calls = path.join(temporaryRoot, 'calls.log');
        const ready = path.join(temporaryRoot, 'ready');
        const dockerStub = path.join(temporaryRoot, 'docker-stub');
        const keyFixture = path.join(temporaryRoot, 'signing-key');
        fs.writeFileSync(keyFixture, '-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n');
        fs.mkdirSync(bin);
        // CI runners already provide Docker. Expose only the core utilities and
        // our stubs so "missing Docker" never falls through to the host binary.
        for (const command of [
            'cat',
            'chmod',
            'cp',
            'grep',
            'mkdir',
            'mktemp',
            'mv',
            'rm',
            'sed',
            'sh',
            'tail',
            'touch',
            'tr',
        ]) {
            const binary = ['/usr/bin', '/bin']
                .map((directory) => path.join(directory, command))
                .find((file) => fs.existsSync(file));
            assert.ok(binary, `Required bootstrap test utility is missing: ${command}`);
            fs.symlinkSync(binary, path.join(bin, command));
        }
        executable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
        const osRelease = path.join(temporaryRoot, 'os-release');
        fs.writeFileSync(
            osRelease,
            `ID=${distribution}\nVERSION_ID="${distributionVersion}"\nVERSION_CODENAME="${distributionCodename}"\n`,
        );
        executable(
            path.join(bin, nativePackageManager),
            `#!/bin/sh
printf '${nativePackageManager} %s\\n' "$*" >> "$CALL_LOG"
if [ "$RELEASEVER_PLUGIN" = true ]; then
  case " $* " in
    *' --noplugins '*) :;;
    *) printf "KeyError: 'epel'\\n" >&2; exit 1;;
  esac
fi
for argument in "$@"; do
  case "$argument" in
    --setopt=reposdir=*) cat "\${argument#--setopt=reposdir=}"/*.repo >> "$CALL_LOG";;
  esac
done
[ "$NATIVE_FAILS" != true ] || exit 7
cp "$DOCKER_STUB" "$MOCK_BIN/docker"
touch "$READY_FILE"
`,
        );
        fs.writeFileSync(calls, '');
        executable(
            dockerStub,
            `#!/bin/sh
case "$*" in
  --version) [ "$PODMAN" != true ] || { echo 'podman version'; exit 0; }; echo 'Docker version';;
  'compose version') [ "$COMPOSE_MISSING" != true ] || [ -f "$READY_FILE" ];;
  info) exit 0;;
esac
`,
        );
        if (existing) {
            fs.copyFileSync(dockerStub, path.join(bin, 'docker'));
        }
        executable(
            path.join(bin, 'apt-get'),
            `#!/bin/sh
printf 'apt-get %s\\n' "$*" >> "$CALL_LOG"
[ ! -f "$MOCK_APT_DIRECTORY/sources.list.d/docker.list" ] || cat "$MOCK_APT_DIRECTORY/sources.list.d/docker.list" >> "$CALL_LOG"
case "$*" in
  *install*)
    [ "$INSTALL_FAILS" != true ] || exit 7
    cp "$DOCKER_STUB" "$MOCK_BIN/docker"
    touch "$READY_FILE"
    ;;
esac
`,
        );
        executable(
            path.join(bin, 'curl'),
            `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
[ "$DOWNLOAD_FAILS" != true ] || exit 22
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) cp "$KEY_FIXTURE" "$2"; exit 0;;
    *) shift;;
  esac
done
exit 1
`,
        );
        executable(
            path.join(bin, 'systemctl'),
            '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$CALL_LOG"\n',
        );
        const functions = bootstrapInstaller
            .slice(
                bootstrapInstaller.indexOf('install_debian_docker_from_aliyun() {'),
                bootstrapInstaller.indexOf('resolve_version() {'),
            )
            .replaceAll('/etc/apt', path.join(temporaryRoot, 'apt'));
        const script = path.join(temporaryRoot, 'test.sh');
        fs.writeFileSync(
            script,
            `#!/bin/sh
set -eu
info() { :; }
fail() { printf '%s\\n' "$1" >&2; exit 1; }
OS_RELEASE_FILE="$OS_RELEASE_FIXTURE"
architecture="$MOCK_ARCHITECTURE"
${functions}
install_docker
`,
        );
        const result = spawnSync('sh', [script], {
            env: {
                ...process.env,
                PATH: bin,
                TMPDIR: temporaryRoot,
                CALL_LOG: calls,
                READY_FILE: ready,
                DOCKER_STUB: dockerStub,
                MOCK_BIN: bin,
                KEY_FIXTURE: keyFixture,
                MOCK_APT_DIRECTORY: path.join(temporaryRoot, 'apt'),
                PODMAN: String(podman),
                COMPOSE_MISSING: String(composeMissing),
                DOWNLOAD_FAILS: String(downloadFails),
                INSTALL_FAILS: String(installFails),
                NATIVE_FAILS: String(nativeFails),
                RELEASEVER_PLUGIN: String(releaseverPlugin),
                MOCK_ARCHITECTURE: architecture,
                OS_RELEASE_FIXTURE: osRelease,
            },
            encoding: 'utf8',
        });
        assert.deepEqual(
            fs
                .readdirSync(temporaryRoot)
                .filter(
                    (name) =>
                        name.startsWith('box3-docker-key.') ||
                        name.startsWith('box3-docker-repos.'),
                ),
            [],
            'temporary download and repository files must be removed',
        );
        return { ...result, calls: fs.readFileSync(calls, 'utf8') };
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

for (const [name, options] of [
    ['missing Docker', {}],
    ['missing Compose', { existing: true, composeMissing: true }],
]) {
    test(`bootstrap installs ${name} directly through the Aliyun APT repository`, () => {
        const result = runDockerBootstrap(options);
        assert.equal(result.status, 0, result.stderr);
        assert.match(
            result.calls,
            /curl .*https:\/\/mirrors\.aliyun\.com\/docker-ce\/linux\/ubuntu\/gpg/,
        );
        assert.match(
            result.calls,
            /apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin/,
        );
        assert.doesNotMatch(result.calls, /get\.docker\.com|githubusercontent/);
        assert.match(result.calls, /systemctl enable --now docker/);
    });
}

test('bootstrap reuses Docker with Compose already installed', () => {
    const result = runDockerBootstrap({ existing: true });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /curl|official/);
});

for (const [name, options, message] of [
    [
        'mirror signing key download failure',
        { downloadFails: true },
        /无法从阿里云镜像下载 Docker 仓库签名密钥/,
    ],
    ['Aliyun package installation failure', { installFails: true }, /阿里云 Docker CE 安装失败/],
    ['Podman compatibility command', { existing: true, podman: true }, /podman-docker/],
]) {
    test(`bootstrap reports ${name} without a different installation fallback`, () => {
        const result = runDockerBootstrap(options);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, message);
        assert.doesNotMatch(result.calls, /dnf|yum|get\.docker\.com|githubusercontent/);
    });
}

test('bootstrap installer detects a public IPv4 address from the configured endpoints', () => {
    assert.match(bootstrapInstaller, /detect_public_ipv4\(\)/);
    assert.match(bootstrapInstaller, /https:\/\/api-ipv4\.ip\.sb\/ip/);
    assert.match(bootstrapInstaller, /https:\/\/ipv4\.icanhazip\.com/);
    assert.doesNotMatch(bootstrapInstaller, /https:\/\/4\.ipw\.cn/);
    assert.doesNotMatch(bootstrapInstaller, /https:\/\/api\.ipify\.org/);
    assert.match(bootstrapInstaller, /is_ipv4_address/);
    assert.match(bootstrapInstaller, /public_ip=\$\(detect_public_ipv4 \|\| true\)/);
    assert.doesNotMatch(bootstrapInstaller, /<服务器公网 IP>/);
});

test('bootstrap installer starts an already-installed matching version without downloading it again', () => {
    assert.match(bootstrapInstaller, /existing_installation_matches_target\(\)/);
    assert.match(bootstrapInstaller, /BOX_IMAGE_TAG/);
    assert.match(bootstrapInstaller, /BOX_PLAY_PLATFORM/);
    assert.match(
        bootstrapInstaller,
        /docker image inspect "box-local-engine-server-manager:\$\{expected_image_tag\}"/,
    );
    assert.match(bootstrapInstaller, /"\$INSTALL_DIRECTORY\/start\.sh"/);
    assert.ok(
        bootstrapInstaller.indexOf('if existing_installation_matches_target') <
            bootstrapInstaller.indexOf('cp -a "$package_directory"'),
        'matching installations must be detected before replacing installed files',
    );
    assert.match(bootstrapInstaller, /cmp -s .*SHA256SUMS/);
});

test('pasting the bootstrap installer does not close the login shell on failure', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-bootstrap-login-'));
    try {
        executable(path.join(temporaryRoot, 'id'), '#!/bin/sh\necho 1000\n');
        const result = spawnSync('sh', [], {
            input: `${bootstrapInstaller}\nprintf 'LOGIN_SESSION_ALIVE\\n'\n`,
            env: { ...process.env, PATH: `${temporaryRoot}:/usr/bin:/bin` },
            encoding: 'utf8',
        });
        assert.match(result.stderr, /安装失败/);
        assert.match(result.stdout, /LOGIN_SESSION_ALIVE/);
        assert.equal(result.status, 0);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

for (const existing of [false, true]) {
    test(`Alibaba Cloud Linux 4 uses native Docker packages from Aliyun (${existing ? 'missing Compose' : 'new installation'})`, () => {
        const result = runDockerBootstrap({
            distribution: 'alinux',
            distributionVersion: '4.0',
            existing,
            composeMissing: existing,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(
            result.calls,
            /dnf .*install -y docker docker-client containerd docker-compose-plugin/,
        );
        assert.match(result.calls, /mirrors\.aliyun\.com\/alinux\/4\/os\/x86_64\/os\//);
        assert.match(result.calls, /mirrors\.aliyun\.com\/alinux\/4\/updates\/x86_64\/os\//);
        assert.match(result.calls, /gpgcheck=1/);
        assert.doesNotMatch(
            result.calls,
            /get\.docker\.com|official|docker-ce|releasever-adapter|yum-config-manager/,
        );
    });
}

test('Alibaba Cloud Linux 4 package failure does not invoke the unsupported official installer', () => {
    const result = runDockerBootstrap({
        distribution: 'alinux',
        distributionVersion: '4',
        nativeFails: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /阿里云 Linux 4.*安装失败/);
    assert.doesNotMatch(result.calls, /get\.docker\.com|official/);
});

test('Alibaba Cloud Linux 4 ARM64 selects aarch64 native repositories', () => {
    const result = runDockerBootstrap({
        distribution: 'alinux',
        distributionVersion: '4',
        architecture: 'arm64',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /alinux\/4\/os\/aarch64\/os\//);
    assert.doesNotMatch(result.calls, /x86_64|get\.docker\.com/);
});

for (const version of ['2.1903']) {
    test(`Alibaba Cloud Linux ${version} stays on native repositories when packages are unavailable`, () => {
        const result = runDockerBootstrap({
            distribution: 'alinux',
            distributionVersion: version,
            nativeFails: true,
        });
        assert.notEqual(result.status, 0);
        assert.match(
            result.calls,
            /dnf .*install -y docker docker-client containerd docker-compose-plugin/,
        );
        assert.doesNotMatch(result.calls, /get\.docker\.com|official/);
    });
}

test('Alibaba Cloud Linux can use yum without dnf or repository-management plugins', () => {
    const result = runDockerBootstrap({
        distribution: 'alinux',
        distributionVersion: '2.1903',
        nativePackageManager: 'yum',
        nativeFails: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(
        result.calls,
        /yum .*--setopt=reposdir=.*install -y docker docker-client containerd docker-compose-plugin/,
    );
    assert.match(result.calls, /alinux\/2\/os\/x86_64\//);
    assert.doesNotMatch(result.calls, /official|get\.docker\.com|yum-config-manager/);
});

for (const architecture of ['amd64', 'arm64']) {
    test(`Alibaba Cloud Linux 3 installs Aliyun Docker CE without the releasever adapter (${architecture})`, () => {
        const result = runDockerBootstrap({
            distribution: 'alinux',
            distributionVersion: '3.2104',
            architecture,
            releaseverPlugin: true,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(
            result.calls,
            /dnf --noplugins .*install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin/,
        );
        const repoArch = architecture === 'amd64' ? 'x86_64' : 'aarch64';
        assert.ok(
            result.calls.includes(
                `https://mirrors.aliyun.com/docker-ce/linux/centos/8/${repoArch}/stable`,
            ),
        );
        assert.ok(result.calls.includes(`https://mirrors.aliyun.com/alinux/3/os/${repoArch}/`));
        assert.match(result.calls, /gpgcheck=1/);
        assert.doesNotMatch(result.calls, /get\.docker\.com|official|yum-config-manager/);
    });
}

test('Ubuntu 26.04 configures resolute using only Aliyun Docker repositories', () => {
    const result = runDockerBootstrap({
        distributionVersion: '26.04',
        distributionCodename: 'resolute',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.calls,
        /https:\/\/mirrors\.aliyun\.com\/docker-ce\/linux\/ubuntu resolute stable/,
    );
    assert.match(result.calls, /signed-by=.*keyrings\/docker.asc/);
    assert.doesNotMatch(result.calls, /get\.docker\.com|githubusercontent|official/);
});

test('Debian ARM64 configures its own Aliyun repository and architecture', () => {
    const result = runDockerBootstrap({
        distribution: 'debian',
        distributionVersion: '13',
        distributionCodename: 'trixie',
        architecture: 'arm64',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /arch=arm64/);
    assert.match(
        result.calls,
        /https:\/\/mirrors\.aliyun\.com\/docker-ce\/linux\/debian trixie stable/,
    );
    assert.doesNotMatch(result.calls, /get\.docker\.com|githubusercontent|official/);
});

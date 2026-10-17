'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');

test(
    'local export and Web package carry six current images without building or downloading',
    { skip: process.platform === 'win32' },
    () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-local-package-'));
        try {
            const raw = path.join(root, 'fixture.tar');
            const generate = spawnSync(
                'python3',
                [
                    '-c',
                    `
import tarfile,io,json,hashlib,sys
services=['creator','voxa','play','player-service','player-auth-portal','server-manager']
version=sys.argv[2]
with tarfile.open(sys.argv[1],'w') as archive:
    manifest=[]
    for service in services:
        config=json.dumps({'os':'linux','architecture':'arm64','created':'2026-10-12T00:00:00Z','config':{'Labels':{'box.routing.base-path':'runtime-v1','service':service}}}).encode()
        name=hashlib.sha256(config).hexdigest()+'.json'
        entry=tarfile.TarInfo(name);entry.size=len(config);archive.addfile(entry,io.BytesIO(config))
        manifest.append({'Config':name,'RepoTags':['box-local-engine-'+service+':v'+version+'-linux-arm64'],'Layers':[]})
    data=json.dumps(manifest).encode();entry=tarfile.TarInfo('manifest.json');entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
`,
                    raw,
                    require('./packaging-context').versionForChannel(
                        require('../package.json').version,
                        'dev',
                    ),
                ],
                { encoding: 'utf8' },
            );
            assert.equal(generate.status, 0, generate.stderr);
            const bin = path.join(root, 'bin');
            fs.mkdirSync(bin);
            const trace = path.join(root, 'docker-calls.jsonl');
            fs.writeFileSync(
                path.join(bin, 'docker'),
                `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);
fs.appendFileSync(process.env.BOX_FIXTURE_TRACE,JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') console.log('arm64');
else if(args[0]==='image' && args[1]==='save') process.stdout.write(fs.readFileSync(process.env.BOX_FIXTURE_ARCHIVE));
else process.exit(2);
`,
            );
            fs.chmodSync(path.join(bin, 'docker'), 0o755);
            const output = path.join(root, 'images');
            const exported = spawnSync(
                process.execPath,
                ['scripts/package-offline-images.js', 'arm64', '--local'],
                {
                    cwd: repo,
                    env: {
                        ...process.env,
                        GITHUB_ACTIONS: '',
                        PATH: bin + path.delimiter + process.env.PATH,
                        BOX_FIXTURE_TRACE: trace,
                        BOX_FIXTURE_ARCHIVE: raw,
                        BOX_LOCAL_IMAGE_DIRECTORY: output,
                    },
                    encoding: 'utf8',
                },
            );
            assert.equal(exported.status, 0, exported.stderr);
            const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
            assert.equal(calls.filter((args) => args[1] === 'inspect').length, 6);
            assert.equal(calls.filter((args) => args[1] === 'save').length, 1);
            assert.ok(!calls.some((args) => ['buildx', 'pull'].includes(args[0])));
            const archive = path.join(
                output,
                fs.readdirSync(output).find((file) => file.endsWith('.tar.gz')),
            );
            const packages = path.join(root, 'packages');
            const built = spawnSync(
                process.execPath,
                ['scripts/build-headless-server-package.js', 'arm64', archive, '--local'],
                {
                    cwd: repo,
                    env: {
                        ...process.env,
                        GITHUB_ACTIONS: '',
                        BOX_LAUNCHER_OUTPUT_DIRECTORY: packages,
                    },
                    encoding: 'utf8',
                },
            );
            assert.equal(built.status, 0, built.stderr);
            const packageRoot = path.join(
                packages,
                fs
                    .readdirSync(packages)
                    .find((file) => !file.startsWith('.') && !file.endsWith('.zip')),
            );
            assert.equal(
                JSON.parse(fs.readFileSync(path.join(packageRoot, 'BOX3-PACKAGE-MODE.json'))).mode,
                'local',
            );
            assert.equal(fs.readdirSync(path.join(packageRoot, 'cache/engine-images')).length, 6);
            const verified = spawnSync(
                process.execPath,
                ['scripts/verify-headless-server-package.js', packageRoot],
                { cwd: repo, encoding: 'utf8' },
            );
            assert.equal(verified.status, 0, verified.stderr);
            const slimOutput = path.join(root, 'slim');
            const slim = spawnSync(
                process.execPath,
                [
                    'scripts/build-headless-server-package.js',
                    'arm64',
                    '--catalog',
                    path.join(packageRoot, 'BOX3-IMAGE-CATALOG.json'),
                ],
                {
                    cwd: repo,
                    env: {
                        ...process.env,
                        GITHUB_ACTIONS: '',
                        BOX_LAUNCHER_OUTPUT_DIRECTORY: slimOutput,
                    },
                    encoding: 'utf8',
                },
            );
            assert.notEqual(slim.status, 0);
            assert.match(slim.stderr, /开发包需要完整 dev 镜像归档/);
            const mode = JSON.parse(
                fs.readFileSync(path.join(packageRoot, 'BOX3-PACKAGE-MODE.json')),
            );
            assert.equal(mode.channel, 'dev');
            assert.match(mode.version, /-dev$/);
            assert.match(mode.imageTag, /-dev-linux-arm64$/);
            assert.ok(path.basename(packageRoot).includes('-dev-'));
            fs.appendFileSync(
                path.join(
                    packageRoot,
                    'cache/engine-images',
                    fs.readdirSync(path.join(packageRoot, 'cache/engine-images'))[0],
                ),
                'corrupted',
            );
            assert.notEqual(
                spawnSync(
                    process.execPath,
                    ['scripts/verify-headless-server-package.js', packageRoot],
                    { encoding: 'utf8' },
                ).status,
                0,
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    },
);

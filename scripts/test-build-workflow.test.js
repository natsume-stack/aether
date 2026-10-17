'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require(
    require.resolve('js-yaml', { paths: [path.join(__dirname, '../tools/repo-tooling')] }),
);
const { stagingContext, validateStagingCatalog } = require('./staging-build-context');
const { validateDesktopCatalog } = require('./build-desktop-offline-installer');
const root = path.resolve(__dirname, '..');
const workflow = yaml.load(
    fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'),
);
const steps = workflow.jobs.images.steps;
const build = steps.find((step) => step.name === 'Build offline images').run;
const probe = steps.find((step) => step.id === 'image-cache').run;
const upload =
    steps.find((step) => step.name === 'Build and upload per-service image downloads').run +
    '\n' +
    steps.find((step) => step.name === 'Upload images to Aliyun OSS').run;

test('staging and production use one workflow and the same engine jobs', () => {
    assert.deepEqual(workflow.on.push.branches, ['staging', 'release/v*']);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/test-build.yml')), false);
    for (const name of ['images', 'desktop', 'headless-server', 'publish']) {
        assert.equal(workflow.jobs[name].if, undefined);
        assert.ok(
            workflow.jobs[name].steps.some(
                (step) => step.run === 'node scripts/release-context.js prepare',
            ),
        );
    }
    const publish = workflow.jobs.publish.steps.find(
        (step) => step.uses === 'softprops/action-gh-release@v3',
    );
    assert.equal(publish.if, "startsWith(github.ref, 'refs/heads/release/v')");
    assert.equal(
        workflow.jobs.publish.env.OSS_SERVER_RELEASE_PREFIX,
        '${{ needs.validate-release.outputs.releasePrefix }}',
    );
});

function run(command, fixture, env) {
    const result = spawnSync(
        'bash',
        [
            '-c',
            'set -euo pipefail\n' +
                command
                    .replaceAll('${{ env.BOX_RELEASE_TAG }}', env.BOX_RELEASE_TAG)
                    .replaceAll('${{ matrix.architecture }}', env.ARCHITECTURE)
                    .replaceAll('${{ github.sha }}', env.GITHUB_SHA),
        ],
        {
            cwd: fixture,
            env,
            encoding: 'utf8',
            timeout: 30_000,
        },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
}

for (const architecture of ['amd64', 'arm64']) {
    test(`staging ${architecture} uses the production cache/build/upload path with commit isolation`, () => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'box-staging-cache-'));
        try {
            const bin = path.join(fixture, 'bin');
            fs.mkdirSync(bin);
            fs.mkdirSync(path.join(fixture, 'scripts'));
            for (const file of [
                'release-context.js',
                'packaging-context.js',
                'staging-build-context.js',
                'build-image-downloads.js',
                'split-image-archive.py',
            ]) {
                fs.copyFileSync(
                    path.join(root, 'scripts', file),
                    path.join(fixture, 'scripts', file),
                );
            }
            fs.writeFileSync(path.join(fixture, 'package.json'), '{"version":"0.3.0"}');
            const context = stagingContext('0.3.0', architecture, 'a'.repeat(40));
            const env = {
                ...process.env,
                GITHUB_ACTIONS: 'true',
                PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                COMMAND_LOG: path.join(fixture, 'commands.jsonl'),
                OSS_STORE: path.join(fixture, 'oss'),
                SAVE_ARCHIVE: path.join(fixture, 'docker.tar'),
                BOX_RELEASE_TAG: context.tag,
                BOX_BUILD_CHANNEL: 'staging',
                GITHUB_SHA: 'a'.repeat(40),
                BOX_IMAGE_TAG: context.imageTag,
                BOX_PLAY_PLATFORM: `linux/${architecture}`,
                BOX_BUILD_COMMIT: 'a'.repeat(40),
                GITHUB_REF: 'refs/heads/staging',
                OSS_BUILD_PREFIX: context.prefix,
                OSS_BUCKET: 'fixture-bucket',
                OSS_ENDPOINT: 'oss.example.test',
                OSS_ACCESS_KEY_ID: 'fixture-id',
                OSS_ACCESS_KEY_SECRET: 'fixture-secret',
                ARCHITECTURE: architecture,
                FORCE_REBUILD: 'false',
                GITHUB_OUTPUT: path.join(fixture, 'outputs'),
            };
            fs.writeFileSync(
                path.join(bin, 'docker'),
                `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({tool:'docker',args})+'\\n');
if(args[0]==='image' && args[1]==='save') process.stdout.write(fs.readFileSync(process.env.SAVE_ARCHIVE));
`,
                { mode: 0o755 },
            );
            fs.writeFileSync(
                path.join(bin, 'ossutil'),
                `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({tool:'ossutil',args})+'\\n');
const remote=value=>path.join(process.env.OSS_STORE,value.replace(/^oss:\\/\\/fixture-bucket\\//,''));
if(args[0]==='stat'){process.exit(fs.existsSync(remote(args[1]))?0:1);}
if(args[0]==='cp'){
 const source=args[1].startsWith('oss://')?remote(args[1]):args[1];
 const target=args[2].startsWith('oss://')?remote(args[2]):args[2];
 if(!fs.existsSync(source))process.exit(1);
 const destination=args[2].endsWith('/')?path.join(target,path.basename(source)):target;
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);
}
`,
                { mode: 0o755 },
            );
            const makeArchive = () => {
                const result = spawnSync(
                    process.platform === 'win32' ? 'python' : 'python3',
                    [
                        '-c',
                        `import io,json,os,tarfile,sys
with tarfile.open(sys.argv[1],'w') as archive:
 manifest=[]
 for service in ['creator','voxa','play','player-service','player-auth-portal','server-manager']:
  name=service+'.json'
  data=json.dumps({'os':'linux','architecture':os.environ['ARCHITECTURE'],'config':{'Labels':{'org.opencontainers.image.revision':os.environ['BOX_BUILD_COMMIT']}}}).encode()
  item=tarfile.TarInfo(name);item.size=len(data);archive.addfile(item,io.BytesIO(data))
  manifest.append({'Config':name,'RepoTags':['box-local-engine-'+service+':'+os.environ['BOX_IMAGE_TAG']],'Layers':[]})
 data=json.dumps(manifest).encode();item=tarfile.TarInfo('manifest.json');item.size=len(data);archive.addfile(item,io.BytesIO(data))
`,
                        env.SAVE_ARCHIVE,
                    ],
                    { env, encoding: 'utf8' },
                );
                assert.equal(result.status, 0, result.stderr);
            };
            makeArchive();
            run(probe, fixture, env);
            assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /cache-hit=false/);
            run(build, fixture, env);
            run(upload, fixture, env);
            const catalogPath = path.join(
                fixture,
                `box-local-engine-images-${context.imageTag}.json`,
            );
            let catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
            validateStagingCatalog(catalog, '0.3.0', architecture);
            validateDesktopCatalog(catalog, context.version, architecture, 'staging');
            assert.throws(
                () => validateDesktopCatalog(catalog, '0.3.0', architecture, 'staging'),
                /staging application version/,
            );
            assert.ok(
                catalog.images.every((image) => image.downloadBaseUrl === context.downloadBaseUrl),
            );
            assert.throws(
                () => validateDesktopCatalog(catalog, '0.3.0', architecture),
                /Staging catalogs/,
            );
            const calls = () =>
                fs.readFileSync(env.COMMAND_LOG, 'utf8').trim().split('\n').map(JSON.parse);
            const builds = () =>
                calls().filter((call) => call.tool === 'docker' && call.args[0] === 'compose')
                    .length;
            assert.equal(builds(), 6);
            fs.writeFileSync(env.GITHUB_OUTPUT, '');
            run(probe, fixture, env);
            assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /cache-hit=true/);
            assert.equal(builds(), 6);
            env.FORCE_REBUILD = 'true';
            fs.writeFileSync(env.GITHUB_OUTPUT, '');
            run(probe, fixture, env);
            assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /cache-hit=false/);
            run(build, fixture, env);
            run(upload, fixture, env);
            assert.equal(builds(), 12);
            env.FORCE_REBUILD = 'false';
            env.GITHUB_SHA = env.BOX_BUILD_COMMIT = 'b'.repeat(40);
            const next = stagingContext('0.3.0', architecture, env.GITHUB_SHA);
            env.OSS_BUILD_PREFIX = next.prefix;
            fs.writeFileSync(env.GITHUB_OUTPUT, '');
            run(probe, fixture, env);
            assert.match(
                fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'),
                /cache-hit=false/,
                'a new commit must not reuse old images',
            );
            makeArchive();
            run(build, fixture, env);
            run(upload, fixture, env);
            catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
            assert.ok(catalog.images.every((image) => image.sourceRevision === env.GITHUB_SHA));
            assert.equal(builds(), 18);
            assert.ok(
                calls()
                    .filter((call) => call.tool === 'ossutil')
                    .every((call) =>
                        call.args.every(
                            (arg) => !arg.startsWith('oss://fixture-bucket/local-engine/'),
                        ),
                    ),
            );
        } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
        }
    });
}

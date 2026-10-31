'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workspaceProjects, developmentBuildPlan } = require('./workspace-projects');

const root = path.resolve(__dirname, '..');
const commands = {
    'dev-admin': ['@box/player-admin', 'dev'],
    'dev-manager': ['@box/deployment-manager', 'dev'],
    'dev-player-launcher': ['@box/player-launcher', 'dev:electron'],
    'api-generate': ['@box/apis', 'generate'],
    'api-check': ['@box/apis', 'check:openapi'],
    'api-build': ['@box/apis', 'build'],
    'api-docs': ['@box/apis', 'docs'],
    'package-player-launcher': ['@box/player-launcher', 'bundle:electron'],
};

function projectCommandPlan(command, input = [], directory = root) {
    const projects = workspaceProjects(directory);
    const option = (name) => {
        const index = input.indexOf(name);
        return index < 0 ? undefined : input[index + 1];
    };
    if (command === 'deploy-service') {
        const service = option('--service');
        if (
            !['creator', 'play', 'voxa', 'player-service', 'player-auth-portal'].includes(service)
        ) {
            throw new Error(
                'deploy-service 必须指定有效的 --service；先配置 .env 和镜像，再启动服务。',
            );
        }
        return { file: 'apps/local-engine/src/deploy.js', args: [`${service}-up`], prepare: [] };
    }
    const nativeManager = command === 'dev-manager' && input.includes('--native');
    const entry = nativeManager ? ['@box/deployment-manager', 'tauri'] : commands[command];
    if (!entry) {
        throw new Error(`Unknown Rush project command: ${command}`);
    }
    const project = projects.find((project) => project.name === entry[0]);
    if (!project?.manifest.scripts?.[entry[1]]) {
        throw new Error(`Missing registered project script: ${entry.join(' ')}`);
    }
    const args = nativeManager ? ['--', 'dev'] : [];
    if (command === 'package-player-launcher' && input.includes('--target')) {
        const target = option('--target');
        const [platform, architecture] = String(target).split('-');
        if (
            !['windows', 'macos', 'linux'].includes(platform) ||
            !['amd64', 'arm64'].includes(architecture) ||
            target !== `${platform}-${architecture}`
        ) {
            throw new Error(`Invalid player launcher target: ${target}`);
        }
        args.push(
            '--',
            { windows: '--win', macos: '--mac', linux: '--linux' }[platform],
            architecture === 'arm64' ? '--arm64' : '--x64',
        );
    }
    return {
        project: project.name,
        folder: project.folder,
        script: entry[1],
        args,
        prepare:
            command.startsWith('dev-') || command === 'package-player-launcher'
                ? developmentBuildPlan(directory, [project.name]).map(
                      (dependency) => dependency.folder,
                  )
                : [],
    };
}

function executeProjectCommand(command, input = []) {
    if (command === 'workspace-check') {
        console.log(
            `Rush workspace passed: ${workspaceProjects(root).length} main projects; names, folders and local dependency graph are consistent.`,
        );
        return;
    }
    const plan = projectCommandPlan(command, input);
    if (input.includes('--dry-run')) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    const run = (executable, args, options) => {
        const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`项目命令失败（${result.signal || result.status}）`);
        }
    };
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const runScript = (folder, script, args = []) =>
        run(npm, ['run', script, ...args], {
            cwd: path.join(root, folder),
            shell: process.platform === 'win32',
        });
    for (const folder of plan.prepare) {
        runScript(folder, 'build');
    }
    if (plan.file) {
        run(process.execPath, [path.join(root, plan.file), ...plan.args], { cwd: root });
    } else {
        runScript(plan.folder, plan.script, plan.args);
    }
}

if (require.main === module) {
    try {
        executeProjectCommand(process.argv[2], process.argv.slice(3));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { projectCommandPlan, executeProjectCommand };

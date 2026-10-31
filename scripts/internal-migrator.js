'use strict';

// Optional local adapter only. Private source is never registered with Rush.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const engineRoot = path.resolve(__dirname, '..');

function contains(parent, child) {
    const relative = path.relative(parent, child);
    return (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
}

function locateTool(repository, configured) {
    if (configured && !path.isAbsolute(configured)) {
        throw new Error('BOX_MIGRATOR_ROOT 必须是绝对路径');
    }
    const candidate = configured
        ? path.resolve(configured)
        : path.join(path.dirname(repository), 'box-local-engine-internal', 'apps', 'migrator');
    if (!fs.existsSync(path.join(candidate, 'package.json'))) {
        throw new Error(
            '本机未安装内部迁移器。设置 BOX_MIGRATOR_ROOT 指向仓库外目录；公开工程不依赖此工具。',
        );
    }
    const real = fs.realpathSync(candidate);
    if (contains(fs.realpathSync(repository), real)) {
        throw new Error('内部迁移器必须放在公开仓库之外');
    }
    if (
        JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')).name !==
        '@box/migrator'
    ) {
        throw new Error('BOX_MIGRATOR_ROOT 不是内部迁移器项目');
    }
    return real;
}

function commonParent(first, second) {
    let parent = path.resolve(first);
    while (!contains(parent, path.resolve(second))) {
        const next = path.dirname(parent);
        if (next === parent) {
            throw new Error('内部工具与引擎必须位于可共同跟踪的文件系统');
        }
        parent = next;
    }
    return parent;
}

function environment(repository, tool, inherited) {
    return {
        ...inherited,
        BOX_MIGRATOR_ENGINE_ROOT: repository,
        BOX_MIGRATOR_TRACE_ROOT: commonParent(repository, tool),
        BOX_MIGRATOR_RUNTIME_TEMPLATE:
            inherited.BOX_MIGRATOR_RUNTIME_TEMPLATE ||
            path.join(repository, 'apps/local-engine/data'),
        BOX_MIGRATOR_CACHE_DIR: inherited.BOX_MIGRATOR_CACHE_DIR || path.join(tool, 'cache'),
    };
}

function scriptPlan(action) {
    if (!['dev', 'build', 'start', 'test', 'typecheck', 'lint'].includes(action)) {
        throw new Error('未知内部工具命令');
    }
    const args = ['run', action];
    if (action === 'dev' || action === 'start') {
        args.push('--', '--hostname', '127.0.0.1');
    }
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

function run(command, args, cwd, env) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`内部工具命令失败（${result.status ?? result.signal}）`);
    }
}

// Registry dependencies are private; public workspace packages stay in the
// engine checkout. This avoids putting the migrator back into public Rush.
function setup(tool, repository, env) {
    const manifest = JSON.parse(fs.readFileSync(path.join(tool, 'package.json'), 'utf8'));
    const registry = {},
        workspace = [];
    const projects = JSON.parse(
        fs.readFileSync(path.join(repository, 'rush.json'), 'utf8'),
    ).projects;
    for (const [name, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
    })) {
        if (version.startsWith('workspace:')) {
            const project = projects.find((item) => item.packageName === name);
            if (!project) {
                throw new Error(`公开工作区缺少依赖 ${name}`);
            }
            workspace.push([name, path.join(repository, project.projectFolder)]);
        } else {
            registry[name] = version;
        }
    }
    registry['react-dom'] ||= registry.react;
    const directory = path.join(tool, '.private-dependencies');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ private: true, dependencies: registry }, null, 2) + '\n',
        { mode: 0o600 },
    );
    run(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '--ignore-scripts'],
        directory,
        env,
    );
    for (const [name, target] of [
        ...Object.keys(registry).map((name) => [name, path.join(directory, 'node_modules', name)]),
        ...workspace,
    ]) {
        const destination = path.join(tool, 'node_modules', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.lstatSync(path.dirname(destination)).isSymbolicLink()) {
            throw new Error('依赖父目录不能是共享目录链接');
        }
        let existing;
        try {
            existing = fs.lstatSync(destination);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        if (existing) {
            if (!existing.isSymbolicLink()) {
                throw new Error(`依赖 ${name} 是实体目录，请先人工核对；未覆盖`);
            }
            fs.unlinkSync(destination);
        }
        fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    console.log('内部依赖已准备。公共共享库如尚未编译，请先运行公开工程的构建命令。');
}

function buildImage(tool, repository, env) {
    const plan = scriptPlan('build');
    run(plan.command, plan.args, tool, env);
    const entry =
        path.relative(env.BOX_MIGRATOR_TRACE_ROOT, tool).split(path.sep).join('/') + '/server.js';
    if (entry.startsWith('../') || !fs.existsSync(path.join(tool, '.next/standalone', entry))) {
        throw new Error('未找到迁移器 standalone 入口');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(tool, 'package.json'), 'utf8'));
    run(
        'docker',
        [
            'build',
            '--build-arg',
            `MIGRATOR_ENTRY=${entry}`,
            '-t',
            env.BOX_MIGRATOR_IMAGE || `box-local-engine-migrator:${manifest.version}`,
            '.',
        ],
        tool,
        env,
    );
}

function main() {
    const tool = locateTool(engineRoot, process.env.BOX_MIGRATOR_ROOT);
    const local = path.join(tool, '.env');
    if (fs.existsSync(local)) {
        process.loadEnvFile(local);
    }
    const env = environment(engineRoot, tool, process.env);
    const action = process.argv[2] || 'dev';
    if (action === 'setup') {
        return setup(tool, engineRoot, env);
    }
    if (action === 'build-image') {
        return buildImage(tool, engineRoot, env);
    }
    if (action === 'check') {
        for (const name of ['typecheck', 'test']) {
            const plan = scriptPlan(name);
            run(plan.command, plan.args, tool, env);
        }
        return;
    }
    const plan = scriptPlan(action);
    run(plan.command, plan.args, tool, env);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = { locateTool, commonParent, environment, scriptPlan };

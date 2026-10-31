import { build, context, type BuildOptions, type BuildContext } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    cpSync,
    lstatSync,
    readFileSync,
    renameSync,
    rmSync,
    readdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

import { PortalConfig, PortalServer } from '../server/index';
import { MockPlayerService } from './mock';
import { prepareStandalone } from './standalone-manifest.cjs';

interface ImageOptions {
    image:string;
    platform:string;
    output:string;
    force:boolean;
}

/** 构建环境：集中目录、版本与子进程错误处理，不向进程传递玩家凭据。 */
export class Project {
    public readonly root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    public readonly version:string = JSON.parse(
        readFileSync(path.join(this.root, 'package.json'), 'utf8'),
    ).version;
    private readonly require = createRequire(import.meta.url);
    public resolve(module:string):string {
        return this.require.resolve(module);
    }
    public run(command:string, args:string[]):void {
        const result = spawnSync(command, args, { cwd: this.root, stdio: 'inherit' });
        if (result.error || result.status !== 0) {
            throw new Error(`${command} 执行失败：${result.error?.message || result.status}`);
        }
    }
    public typescript(args:string[]):void {
        this.run(process.execPath, [this.require.resolve('typescript/bin/tsc'), ...args]);
    }
}

/** 只管理构建与验证，不启动模拟服务，不操作 Docker。 */
export class PortalBuilder {
    private readonly project:Project;
    public constructor(project = new Project()) {
        this.project = project;
    }
    public targets():BuildOptions[] {
        return [
            {
                entryPoints: ['src/main.tsx'],
                outfile: 'public/app.js',
                jsx: 'automatic',
                alias: {
                    'react': path.resolve(
                        this.project.root,
                        this.project.resolve('@box/deployment-routing/react'),
                    ),
                    'react/jsx-runtime': path.resolve(
                        this.project.root,
                        this.project.resolve('@box/deployment-routing/jsx-runtime'),
                    ),
                    '__box_original_react__': path.join(
                        this.project.root,
                        'node_modules/react/index.js',
                    ),
                    '__box_original_jsx_runtime__': path.join(
                        this.project.root,
                        'node_modules/react/jsx-runtime.js',
                    ),
                },
            },
            { entryPoints: ['src/theme-main.ts'], outfile: 'public/theme.js' },
            { entryPoints: ['src/styles/app.css'], outfile: 'public/styles.css' },
            {
                entryPoints: ['server/main.ts'],
                outfile: 'build/server.cjs',
                platform: 'node',
                format: 'cjs',
            },
            {
                entryPoints: ['server/index.ts'],
                outfile: 'build/library.cjs',
                platform: 'node',
                format: 'cjs',
            },
        ].map(
            (target) =>
                ({
                    absWorkingDir: this.project.root,
                    bundle: true,
                    minify: true,
                    target: 'es2022',
                    logLevel: 'info',
                    ...target,
                }) as BuildOptions,
        );
    }
    public async build():Promise<void> {
        await Promise.all(this.targets().map((target) => build(target)));
        this.project.typescript(['-p', 'tsconfig.library.json']);
    }
    public async check():Promise<void> {
        this.project.typescript(['--noEmit']);
        await this.build();
        const tests = readdirSync(path.join(this.project.root, 'test'))
            .filter((name) => name.endsWith('.test.ts'))
            .map((name) => `test/${name}`);
        this.project.run(process.execPath, ['--import', 'tsx', '--test', ...tests]);
    }
    public async testUI(electron:string):Promise<void> {
        await this.build();
        await build({
            absWorkingDir: this.project.root,
            entryPoints: ['scripts/ui-smoke.ts'],
            outfile: 'build/ui-smoke.cjs',
            bundle: true,
            platform: 'node',
            format: 'cjs',
            external: ['electron'],
        });
        this.project.run(electron, [path.join(this.project.root, 'build/ui-smoke.cjs')]);
    }
}

/** 持有开发服务与 watcher 的生命周期，生产入口不会导入这个类。 */
export class PortalDevelopment {
    private readonly project:Project;
    private readonly builder:PortalBuilder;
    private builds:BuildContext[] = [];
    private mock?:MockPlayerService;
    private portal?:PortalServer;
    public constructor(project:Project, builder:PortalBuilder) {
        this.project = project;
        this.builder = builder;
    }
    private async watch():Promise<void> {
        const targets = this.builder
            .targets()
            .filter((target) => target.outfile?.startsWith('public/'));
        this.builds = await Promise.all(targets.map((target) => context(target)));
        await Promise.all(this.builds.map((target) => target.rebuild()));
        await Promise.all(this.builds.map((target) => target.watch()));
    }
    private async config(live:boolean):Promise<PortalConfig> {
        if (live) {
            return PortalConfig.fromEnvironment();
        }
        this.mock = new MockPlayerService();
        await new Promise<void>((resolve) => this.mock!.server.listen(0, '127.0.0.1', resolve));
        const address = this.mock.server.address();
        if (!address || typeof address === 'string') {
            throw new Error('模拟服务端口无效');
        }
        console.log('模拟预览：demo / demo-password-123，数据仅保留到进程退出。');
        return new PortalConfig({
            apiKey: this.mock.key,
            playerServiceURL: new URL(`http://127.0.0.1:${address.port}`),
            host: '127.0.0.1',
            port: Number(process.env.PORTAL_DEV_PORT || 4325),
        });
    }
    public async start(live:boolean):Promise<void> {
        process.chdir(this.project.root);
        if (existsSync('.env')) {
            process.loadEnvFile('.env');
        }
        try {
            const config = await this.config(live);
            await this.watch();
            this.portal = new PortalServer(config);
            await this.portal.listen();
            console.log(
                `页面：http://${config.host}:${config.port}；保存后刷新。${live ? '真实联调，仅用测试账号。' : '不连接引擎。'}`,
            );
            for (const signal of ['SIGINT', 'SIGTERM'] as const) {
                process.once(signal, () => {
                    void this.close().then(() => process.exit(0));
                });
            }
        } catch (error) {
            // 端口冲突或配置错误也必须释放 watcher/模拟器，不能挂着后台进程。
            await this.close();
            throw error;
        }
    }
    public async close():Promise<void> {
        await Promise.all(this.builds.map((target) => target.dispose()));
        this.portal?.server.close();
        this.mock?.server.close();
    }
}

/** Docker 镜像导出：参数、构建、架构检查、归档各有独立方法。 */
export class ImagePackager {
    private readonly project:Project;
    private readonly builder:PortalBuilder;
    public constructor(project = new Project(), builder = new PortalBuilder(project)) {
        this.project = project;
        this.builder = builder;
    }
    private flags(args:string[]):Partial<ImageOptions> {
        const flags:Partial<ImageOptions> = {};
        for (let i = 0; i < args.length; i++) {
            const flag = args[i];
            if (flag === '--force') {
                flags.force = true;
            } else if (
                ['--image', '--platform', '--output'].includes(flag) &&
                args[i + 1] &&
                !args[i + 1].startsWith('--')
            ) {
                flags[flag.slice(2) as 'image' | 'platform' | 'output'] = args[++i];
            } else {
                throw new Error(`未知或缺少参数：${flag}`);
            }
        }
        return flags;
    }
    public options(args:string[], architecture:string = process.arch):ImageOptions {
        const values = this.flags(args);
        const image = values.image || `box3-login-example:${this.project.version}`;
        const platform =
            values.platform ||
            (architecture === 'arm64'
                ? 'linux/arm64'
                : architecture === 'x64'
                  ? 'linux/amd64'
                  : '');
        if (!['linux/amd64', 'linux/arm64'].includes(platform)) {
            throw new Error('平台需为 linux/amd64 或 linux/arm64');
        }
        if (
            !/^[a-z0-9][a-z0-9._:/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(image) ||
            image.includes('://')
        ) {
            throw new Error('镜像名需带版本，例如 my-login:1.0');
        }
        const filename = `${image.replaceAll(/[^A-Za-z0-9_.-]/g, '-')}-${platform.replace('/', '-')}.tar.gz`;
        const output = path.resolve(
            this.project.root,
            values.output || path.join('dist', filename),
        );
        if (!output.endsWith('.tar.gz')) {
            throw new Error('导出文件需以 .tar.gz 结尾');
        }
        return { image, platform, output, force: values.force || false };
    }
    private build(options:ImageOptions):void {
        this.project.run('docker', ['info', '--format', '{{.Architecture}}']);
        this.project.run('docker', [
            'buildx',
            'build',
            '--load',
            '--platform',
            options.platform,
            '-f',
            'Dockerfile.standalone',
            '-t',
            options.image,
            '.',
        ]);
    }
    private verify(options:ImageOptions):void {
        const result = spawnSync(
            'docker',
            ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', options.image],
            { encoding: 'utf8' },
        );
        if (result.status !== 0 || result.stdout.trim() !== options.platform) {
            throw new Error('镜像架构不符');
        }
    }
    private async archive(options:ImageOptions):Promise<void> {
        mkdirSync(path.dirname(options.output), { recursive: true });
        const temporary = `${options.output}.${process.pid}.part`;
        const save = spawn('docker', ['image', 'save', options.image], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        const completed = new Promise<void>((resolve, reject) => {
            save.once('error', reject);
            save.once('exit', (code) =>
                code === 0 ? resolve() : reject(new Error(`导出失败：${code}`)),
            );
        });
        try {
            await Promise.all([
                completed,
                pipeline(
                    save.stdout!,
                    createGzip({ level: 1 }),
                    createWriteStream(temporary, { flags: 'wx' }),
                ),
            ]);
            renameSync(temporary, options.output);
        } catch (error) {
            save.kill();
            rmSync(temporary, { force: true });
            throw error;
        }
    }
    public async export(args:string[]):Promise<void> {
        const options = this.options(args);
        if (existsSync(options.output) && !options.force) {
            throw new Error('归档已存在，使用新版本或明确添加 --force');
        }
        await this.builder.check();
        this.build(options);
        this.verify(options);
        await this.archive(options);
        console.log(
            `镜像归档：${options.output}\n导入：docker load -i "${options.output}"\n启动器填写：${options.image}`,
        );
    }
}

/** 源码模板是明确白名单，而不是把工作目录整体压缩，防止夹带凭据。 */
export class TemplateExporter {
    private readonly project:Project;
    private readonly files = [
        'src',
        'server',
        'scripts',
        'test',
        'docs',
        'examples',
        'public',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tsconfig.library.json',
        'README.md',
        'LICENSE',
        '.env.example',
        '.gitignore',
        '.dockerignore',
        'Dockerfile.standalone',
    ];
    public constructor(project = new Project()) {
        this.project = project;
    }
    private allowed(source:string):boolean {
        if (lstatSync(source).isSymbolicLink()) {
            return false;
        }
        if (source === path.join(this.project.root, '.env.example')) {
            return true;
        }
        const name = path.basename(source);
        return (
            !/^\.env(?:\.|$)/.test(name) &&
            !/\.(pem|key|p12|pfx)$/.test(name) &&
            !['node_modules', 'dist', '.DS_Store'].includes(name)
        );
    }
    private copy(folder:string):void {
        mkdirSync(folder);
        for (const file of this.files) {
            cpSync(path.join(this.project.root, file), path.join(folder, file), {
                recursive: true,
                filter: (source) => this.allowed(source),
            });
        }
    }
    public export(force:boolean):void {
        const name = `box3-login-template-${this.project.version}`;
        const output = path.join(this.project.root, 'dist', `${name}.tar.gz`);
        if (existsSync(output) && !force) {
            throw new Error('模板包已存在，明确使用 --force');
        }
        const temporary = mkdtempSync(path.join(os.tmpdir(), 'box-login-template-'));
        try {
            this.copy(path.join(temporary, name));
            prepareStandalone(
                path.join(temporary, name),
                path.dirname(this.project.resolve('@box/deployment-routing/package.json')),
                path.resolve(path.dirname(this.project.resolve('@box/apis')), '..'),
            );
            mkdirSync(path.dirname(output), { recursive: true });
            this.project.run('tar', ['-czf', output, '-C', temporary, name]);
            console.log(`独立模板：${output}`);
        } finally {
            rmSync(temporary, { recursive: true, force: true });
        }
    }
}

/** CLI 仅选择任务，不承载任务实现。其他开发者可直接复用上面的类。 */
export class PortalTasks {
    private readonly project = new Project();
    private readonly builder = new PortalBuilder(this.project);
    public async execute(command:string, args:string[]):Promise<void> {
        switch (command) {
            case 'build':
                return this.builder.build();
            case 'check':
                return this.builder.check();
            case 'ui': {
                const index = args.indexOf('--electron');
                if (index < 0 || !args[index + 1]) {
                    throw new Error('可选 UI 测试需要 --electron <已有 Electron 可执行文件路径>');
                }
                return this.builder.testUI(args[index + 1]);
            }
            case 'dev':
                return new PortalDevelopment(this.project, this.builder).start(
                    args.includes('--live'),
                );
            case 'package':
                return new ImagePackager(this.project, this.builder).export(args);
            case 'export':
                return new TemplateExporter(this.project).export(args.includes('--force'));
            default:
                throw new Error('命令：build | check | dev | package | export');
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    new PortalTasks().execute(process.argv[2], process.argv.slice(3)).catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}

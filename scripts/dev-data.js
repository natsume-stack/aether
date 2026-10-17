'use strict';

const fs = require('node:fs');
const path = require('node:path');

function developmentDataEnvironment(repoRoot, env) {
    const directory = path.resolve(
        repoRoot,
        env.BOX_DEV_DATA_DIRECTORY || path.join(repoRoot, '.local-data'),
    );
    const engine = path.join(directory, 'apps/local-engine');
    const resolve = (configured, fallback) => path.resolve(repoRoot, configured || fallback);
    const voxa = resolve(
        env.VOXA_DATA_PATH || env.BOX_LOCAL_VOXA_DATA_PATH,
        path.join(directory, 'apps/voxa/data'),
    );
    return {
        BOX_DEV_DATA_DIRECTORY: directory,
        BOX_LOCAL_ENGINE_ROOT: path.join(repoRoot, 'apps/local-engine'),
        BOX_LOCAL_PROJECTS_PATH: resolve(
            env.BOX_LOCAL_PROJECTS_PATH,
            path.join(engine, 'projects'),
        ),
        BOX_PLAY_LIBRARY_PATH: resolve(env.BOX_PLAY_LIBRARY_PATH, path.join(engine, 'play-worlds')),
        BOX_SERVER_DATA_PATH: resolve(env.BOX_SERVER_DATA_PATH, path.join(engine, 'data')),
        BOX_RUNTIME_CACHE_PATH: resolve(
            env.BOX_RUNTIME_CACHE_PATH,
            path.join(engine, 'runtime-cache'),
        ),
        BOX_PROJECT_BACKUP_PATH: resolve(env.BOX_PROJECT_BACKUP_PATH, path.join(engine, 'backups')),
        BOX_LOCAL_DIST_PATH: resolve(env.BOX_LOCAL_DIST_PATH, path.join(engine, 'dist')),
        BOX_MAP_RUNTIME_PROFILES_PATH: resolve(
            env.BOX_MAP_RUNTIME_PROFILES_PATH,
            path.join(engine, 'data/map-runtime-profiles.json'),
        ),
        BOX_LOCAL_TEMPLATE_DATA_PATH: resolve(
            env.BOX_LOCAL_TEMPLATE_DATA_PATH,
            path.join(repoRoot, 'apps/local-engine/data'),
        ),
        BOX_LOCAL_VOXA_DATA_PATH: voxa,
        VOXA_DATA_PATH: voxa,
    };
}

function hasData(directory) {
    return (
        fs.existsSync(directory) && fs.readdirSync(directory).some((entry) => entry !== '.gitkeep')
    );
}

/** Import legacy data once, preserving existing destinations and built-in source assets. */
function prepareDevelopmentData(repoRoot, env, log = console.log) {
    const root = env.BOX_DEV_DATA_DIRECTORY;
    if (path.resolve(root) === path.resolve(repoRoot)) {
        throw new Error(
            'BOX_DEV_DATA_DIRECTORY must be a dedicated data directory, not the source root',
        );
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const marker = path.join(root, '.source-data-import.json');
    const previous = fs.existsSync(marker)
        ? JSON.parse(fs.readFileSync(marker, 'utf8'))
        : { sources: [] };
    if (!Array.isArray(previous.sources)) {
        throw new Error('Invalid development data import record');
    }
    if (previous.sources.includes(repoRoot)) {
        return [];
    }
    const entries = [
        ['apps/local-engine/projects', env.BOX_LOCAL_PROJECTS_PATH],
        ['apps/local-engine/play-worlds', env.BOX_PLAY_LIBRARY_PATH],
        ['apps/local-engine/data', env.BOX_SERVER_DATA_PATH],
        ['apps/local-engine/backups', env.BOX_PROJECT_BACKUP_PATH],
        ['apps/local-engine/runtime-cache', env.BOX_RUNTIME_CACHE_PATH],
        ['apps/voxa/data', env.VOXA_DATA_PATH],
        ['apps/local-engine/dist/projects', path.join(env.BOX_LOCAL_DIST_PATH, 'projects')],
        ['apps/local-engine/dist/releases', path.join(env.BOX_LOCAL_DIST_PATH, 'releases')],
    ];
    const copied = [];
    for (const [legacy, destination] of entries) {
        const source = path.join(repoRoot, legacy);
        if (!hasData(source) || path.resolve(source) === path.resolve(destination)) {
            continue;
        }
        const nested = path.relative(source, destination);
        if (!nested.startsWith(`..${path.sep}`) && nested !== '..' && !path.isAbsolute(nested)) {
            throw new Error(`Development destination overlaps legacy data: ${destination}`);
        }
        if (hasData(destination)) {
            log(`已有独立开发数据，保留原目录且不覆盖：${source}`);
            continue;
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        // Source blobs also contain versioned engine assets, so that directory
        // stays in place. Whole project/model/export directories can move intact.
        if (legacy !== 'apps/local-engine/data') {
            const keep = fs.existsSync(path.join(source, '.gitkeep'));
            try {
                if (fs.existsSync(destination)) {
                    fs.rmdirSync(destination);
                }
                fs.renameSync(source, destination);
                if (keep) {
                    fs.mkdirSync(source, { recursive: true });
                    fs.writeFileSync(path.join(source, '.gitkeep'), '');
                }
                log(`已迁移开发数据：${source} → ${destination}`);
                copied.push({ source, destination, moved: true });
                continue;
            } catch (error) {
                if (error.code !== 'EXDEV') {
                    throw error;
                }
                // A custom data directory on another filesystem uses a safe
                // copy; retain the original rather than removing user content.
            }
        }
        const staging = fs.mkdtempSync(
            path.join(path.dirname(destination), '.source-data-import-'),
        );
        try {
            log(`复制已有开发数据：${source} → ${destination}`);
            fs.cpSync(source, staging, {
                recursive: true,
                mode: fs.constants.COPYFILE_FICLONE,
                preserveTimestamps: true,
                filter: (entry) => {
                    if (fs.lstatSync(entry).isSymbolicLink()) {
                        throw new Error(
                            `Legacy data contains a symbolic link; import it explicitly: ${entry}`,
                        );
                    }
                    return true;
                },
            });
            if (fs.existsSync(destination)) {
                fs.rmdirSync(destination);
            }
            fs.renameSync(staging, destination);
            copied.push({ source, destination });
        } finally {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
    const temporary = `${marker}.${process.pid}.tmp`;
    fs.writeFileSync(
        temporary,
        `${JSON.stringify({ sources: [...previous.sources, repoRoot] }, null, 2)}\n`,
    );
    fs.renameSync(temporary, marker);
    return copied;
}

module.exports = { developmentDataEnvironment, prepareDevelopmentData };

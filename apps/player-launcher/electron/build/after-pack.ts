import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface PackContext {
    appOutDir:string;
    electronPlatformName:string;
    packager:{ appInfo:{ productFilename:string } };
}

// Unpacked electronDist bypasses electron-builder's normal locale filtering.
// Apply the same en-US / zh-CN policy to the generated app, leaving runtime
// libraries, licenses and all player assets intact.
export default async function afterPack(context:PackContext):Promise<void> {
    const mac = context.electronPlatformName === 'darwin';
    const application = mac
        ? path.join(
              context.appOutDir,
              `${context.packager.appInfo.productFilename}.app`,
              'Contents',
          )
        : context.appOutDir;
    const locales = mac
        ? path.join(
              application,
              'Frameworks',
              'Electron Framework.framework',
              'Versions',
              'A',
              'Resources',
          )
        : path.join(application, 'locales');
    const retained = new Set(
        mac ? ['en.lproj', 'en_US.lproj', 'zh_CN.lproj'] : ['en-US.pak', 'zh-CN.pak'],
    );
    for (const entry of await fs.readdir(locales, { withFileTypes: true })) {
        const isLocale = mac
            ? entry.isDirectory() && entry.name.endsWith('.lproj')
            : entry.isFile() && entry.name.endsWith('.pak');
        if (isLocale && !retained.has(entry.name)) {
            await fs.rm(path.join(locales, entry.name), { recursive: true });
        }
    }
    await fs.rm(path.join(application, mac ? 'Resources' : 'resources', 'default_app.asar'), {
        force: true,
    });
}

import fs from 'fs';
import path from 'path';

type NodeProcessWithBuiltinModule = typeof process & {
  getBuiltinModule?: (id: string) => { createRequire(filename: string): NodeRequire };
};

/** Loads the local-only manager without asking webpack to resolve a dynamic path. */
export function getLocalProjectManager() {
  const roots = [
    process.env.BOX_LOCAL_ENGINE_ROOT,
    path.resolve(process.cwd(), '../local-engine'),
    path.resolve(__dirname, '../../local-engine'),
  ].filter((root): root is string => Boolean(root));
  const managerPath = roots
    .map((root) => path.join(root, 'src', 'project-manager.js'))
    .find((candidate) => fs.existsSync(candidate));

  if (!managerPath) {
    throw new Error('未找到 Local Engine 项目管理器。请从项目根目录运行 rush dev。');
  }

  // Node 22 provides this runtime-only builtin lookup. Keeping the require out
  // of webpack prevents it from turning the absolute local path into a module
  // context (the cause of the "Cannot find module" error in dev).
  const nodeModule = (process as NodeProcessWithBuiltinModule).getBuiltinModule?.('module');
  if (!nodeModule) throw new Error('当前 Node.js 版本不支持加载本地项目管理器，请使用 Node.js 20.16 或更高版本。');
  const localRequire = nodeModule.createRequire(__filename);
  const resolvedPath = localRequire.resolve(managerPath);
  if (process.env.NODE_ENV !== 'production') delete localRequire.cache[resolvedPath];
  return localRequire(resolvedPath) as typeof import('../../local-engine/src/project-manager');
}

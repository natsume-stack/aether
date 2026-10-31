import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { scriptRevision } from './script-preview';
import { diagnosticIdentity } from './script-diagnostic-policy';

type Source = { fileId: string; name: string; isClient: boolean; text: string };

export function findAuthoringRoot() {
  if (process.env.BOX_AUTHORING_REPO_ROOT) return path.resolve(process.env.BOX_AUTHORING_REPO_ROOT);
  const packaged = path.resolve(__dirname, '../../../authoring-resources');
  if (fs.existsSync(path.join(packaged, 'packages/script-api/dts/server-api-types.dts'))) return packaged;
  for (const start of [__dirname, process.cwd()]) {
    let current = start;
    while (true) {
      if (fs.existsSync(path.join(current, 'packages/script-api/dts/server-api-types.dts'))) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error('Engine API declarations not found; configure BOX_AUTHORING_REPO_ROOT');
}

export function findAuthoringBindingModule() {
  const root = findAuthoringRoot();
  const bundled = path.join(root, 'ui-binding.mjs');
  return fs.existsSync(bundled) ? bundled : path.join(root, 'tools/box3-map-mcp/src/ui-binding.js');
}

/** Checks a snapshot, never executes author code. Unavailable is a refusal,
 * never an automatic downgrade to a weaker syntax-only check.
 */
export function checkScriptSnapshot(source: Source, files: Source[], content: string) {
  try {
    if (!source.isClient) {
      try { vm.compileFunction(content, [], { filename: source.name }); }
      catch (error) { return { available: true, passed: false, mode: 'syntax', diagnostics: [
        { code: 'CJS_SYNTAX_ERROR', severity: 'error', message: (error as Error).message },
      ] }; }
    }
    const root = findAuthoringRoot();
    const load = createRequire(__filename);
    const ts: typeof import('typescript') = load('typescript');
    const norm = (name: string) => {
      const normalized = name.replace(/\\/g, '/');
      return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    };
    const dir = norm(path.join(root, '__authoring_script_check__'));
    const virtual = new Map<string, string>();
    const originalNames: string[] = [];
    let script = '';
    const scope = files.filter(file => file.isClient === source.isClient).sort((a, b) => a.fileId.localeCompare(b.fileId));
    if (scope.length > 256 || scope.reduce((sum, file) => sum + file.text.length, 0) > 2000000 || content.length > 500000) throw new Error('Script check scope exceeds bounded project budget');
    if (!scope.some(file => file.fileId === source.fileId)) throw new Error('Source missing from project snapshot');
    for (const file of scope) {
      if (path.basename(file.name) !== file.name || !/\.js$/i.test(file.name)
        || file.name.length > 256 || /[\\/\u0000-\u001f:<>"|?*]/.test(file.name)) throw new Error('Unsupported script filename in check scope');
      const name = norm(`${dir}/${file.name}`);
      if (virtual.has(name)) throw new Error('Duplicate script filename in check scope');
      virtual.set(name, file.fileId === source.fileId ? content : file.text);
      originalNames.push(`${dir}/${file.name}`);
      if (file.fileId === source.fileId) script = `${dir}/${file.name}`;
    }
    const wanted = source.isClient ? ['packages/script-api/dts/client-api-types.dts']
      : ['apps/game/src/resource/api-declarations.dts', 'packages/script-api/dts/server-api-types.dts'];
    const declarations = wanted.map(relative => {
      const name = norm(path.join(root, relative));
      const text = fs.readFileSync(name, 'utf8');
      // The engine ships .dts resources for Monaco; TypeScript root files need
      // real .d.ts extensions or the compiler silently lacks the API globals.
      virtual.set(name.replace(/\.dts$/, '.d.ts'), text);
      originalNames.push(name.replace(/\.dts$/, '.d.ts'));
      return [relative, text];
    });
    const dependencyRevision = createHash('sha256').update(JSON.stringify({
      sources: scope.map(file => [file.fileId, scriptRevision(file)]), declarations, compiler: ts.version,
    })).digest('hex');
    const host: import('typescript').LanguageServiceHost = {
      getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs, moduleDetection: ts.ModuleDetectionKind.Force,
        allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true }),
      getScriptFileNames: () => originalNames, getScriptVersion: () => '1',
      getScriptSnapshot: name => {
        const text = virtual.get(norm(name)) ?? ts.sys.readFile(name);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => dir, getDefaultLibFileName: ts.getDefaultLibFilePath,
      // Match the virtual filesystem's identity rules during module resolution.
      // Without this, Windows imports with original casing can load the same
      // lower-cased virtual root twice and manufacture TS1149/TS1261 errors.
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      fileExists: name => virtual.has(norm(name)) || ts.sys.fileExists(name),
      directoryExists: name => norm(name) === dir || ts.sys.directoryExists(name),
      readFile: name => virtual.get(norm(name)) ?? ts.sys.readFile(name), readDirectory: ts.sys.readDirectory,
    };
    const service = ts.createLanguageService(host);
    try {
      const syntaxValid = !service.getSyntacticDiagnostics(script).some(row => row.category === ts.DiagnosticCategory.Error);
      const rawDiagnostics = [...service.getCompilerOptionsDiagnostics(), ...originalNames.filter(name => /\.js$/i.test(name))
        .flatMap(name => [...service.getSyntacticDiagnostics(name), ...service.getSemanticDiagnostics(name)])];
      const errorSignatures = rawDiagnostics.filter(row => row.category === ts.DiagnosticCategory.Error).map(row => diagnosticIdentity({
        file: row.file?.fileName, code: row.code, message: ts.flattenDiagnosticMessageText(row.messageText, '\n'),
        span: row.file?.text.slice(row.start ?? 0, (row.start ?? 0) + (row.length ?? 0)),
      }));
      const diagnostics = rawDiagnostics
        .map(diagnostic => {
          const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
          return { code: `TS${diagnostic.code}`, severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
            file: diagnostic.file?.fileName.split('/').pop(),
            line: position ? position.line + 1 : undefined, column: position ? position.character + 1 : undefined,
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') };
        });
      return { available: true, passed: !diagnostics.some(row => row.severity === 'error'), mode: 'language-service',
        dependencyRevision, resultRevision: scriptRevision({ ...source, text: content }), syntaxValid, errorSignatures, diagnostics: diagnostics.slice(0, 200),
        diagnosticCount: diagnostics.length, diagnosticsTruncated: diagnostics.length > 200,
        coverage: 'Syntax and TypeScript semantics of all same-side project sources with shipped API declarations; UI bindings and runtime behavior require separate checks.' };
    } finally { service.dispose(); }
  } catch (error) {
    return { available: false, passed: false, mode: 'unavailable', code: 'SCRIPT_CHECK_UNAVAILABLE',
      error: (error as Error).message, diagnostics: [] };
  }
}

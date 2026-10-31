import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAuthoringBindingModule } from './script-typecheck';
import type { checkScriptSnapshot } from './script-typecheck';
import type { ScriptCheckPolicy } from './script-diagnostic-policy';

type Check = ReturnType<typeof checkScriptSnapshot> & { bindings?: Record<string, any>; accepted?: boolean; clean?: boolean; policy?: ScriptCheckPolicy; comparison?: Record<string, any> };
const unavailable = (code: string, error: string) => ({ available: false, passed: false, mode: 'unavailable', code, error, diagnostics: [] });
let active = false;

/** At most one bounded compiler per runtime; never block editor/network ticks.
 * The bootstrap loads trusted local checking code. Author source is data only.
 */
export async function checkScriptIsolated(...args: [...Parameters<typeof checkScriptSnapshot>, Record<string, any>?, ScriptCheckPolicy?]): Promise<Check> {
  if (active) return unavailable('SCRIPT_CHECK_BUSY', 'Another check is running; retry this read-only check later');
  const [source, files, content, uiTree, policy = 'strict'] = args;
  if (!['strict', 'no-new-errors'].includes(policy)) return unavailable('SCRIPT_CHECK_POLICY_INVALID', 'Unknown checking policy');
  const scope = files.filter(file => file.isClient === source.isClient);
  if (scope.length > 256 || scope.reduce((sum, file) => sum + file.text.length, 0) > 2000000 || content.length > 500000) {
    return unavailable('SCRIPT_CHECK_BUDGET', 'Script snapshot exceeds checking budget');
  }
  active = true;
  let worker: Worker | undefined;
  try {
    const load = createRequire(path.join(__dirname, 'script-check-worker.js'));
    const entry = load.resolve('./script-typecheck');
    const policyEntry = load.resolve('./script-diagnostic-policy');
    const register = entry.endsWith('.ts') ? load.resolve('@swc-node/register') : '';
    const bindingModule = uiTree === undefined ? '' : pathToFileURL(findAuthoringBindingModule()).href;
    if (uiTree !== undefined && (files.length > 256 || files.reduce((sum, file) => sum + file.text.length, 0) > 2000000
      || Buffer.byteLength(JSON.stringify(uiTree)) > 4 * 1024 * 1024)) return unavailable('SCRIPT_CHECK_BUDGET', 'Binding snapshot exceeds checking budget');
    worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.register) require(workerData.register);
        const { bindingDiagnosticIdentity, compareDiagnosticErrors } = require(workerData.policyEntry);
        const check = require(workerData.entry).checkScriptSnapshot;
        const [source, files, content] = workerData.args;
        let result = check(source, files, content);
        const candidateErrors = [...(result.errorSignatures || [])];
        let baseline;
        let baselineErrors = [];
        if (workerData.policy === 'no-new-errors' && result.available && result.mode === 'language-service') {
          baseline = check(source, files, source.text);
          baselineErrors = [...(baseline.errorSignatures || [])];
        }
        if (workerData.bindingModule) {
          const { validateUiBindings } = await import(workerData.bindingModule);
          const bindings = validateUiBindings({ uiTree: workerData.uiTree, scriptsAreComplete: true,
            scripts: files.map(file => ({ entry: file.name, side: file.isClient ? 'client' : 'server',
              content: file.fileId === source.fileId ? content : file.text })) });
          candidateErrors.push(...bindings.problems.filter(row => row.severity === 'error').map(bindingDiagnosticIdentity));
          if (baseline) {
            const originalBindings = validateUiBindings({ uiTree: workerData.uiTree, scriptsAreComplete: true,
              scripts: files.map(file => ({ entry: file.name, side: file.isClient ? 'client' : 'server', content: file.text })) });
            baselineErrors.push(...originalBindings.problems.filter(row => row.severity === 'error').map(bindingDiagnosticIdentity));
          }
          result = { ...result, passed: result.passed && bindings.ok, bindings: {
            ...bindings, problems: bindings.problems.slice(0, 200), problemsTruncated: bindings.problems.length > 200,
          } };
        }
        const comparison = baseline ? compareDiagnosticErrors(baselineErrors, candidateErrors) : undefined;
        const accepted = !!result.available && (workerData.policy === 'strict' ? result.passed
          : !!baseline?.available && baseline.mode === 'language-service' && result.syntaxValid === true && comparison.introducedErrorCount === 0);
        delete result.errorSignatures;
        result = { ...result, policy: workerData.policy, clean: !!result.passed, accepted, comparison };
        parentPort.postMessage({ result });
      })().catch(error => parentPort.postMessage({ error: String(error.message || error) }));
    `, { eval: true, workerData: { entry, policyEntry, policy, register, bindingModule, uiTree, args: [source, uiTree === undefined ? scope : files, content] }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    const current = worker;
    return await new Promise<Check>(resolve => {
      let settled = false;
      const finish = (result: Check) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(unavailable('SCRIPT_CHECK_TIMEOUT', 'Checking exceeded 15 seconds; no write was performed')), 15000);
      current.once('message', message => finish(message.result || unavailable('SCRIPT_CHECK_UNAVAILABLE', message.error || 'Invalid checker response')));
      current.once('error', error => finish(unavailable('SCRIPT_CHECK_UNAVAILABLE', error.message)));
      current.once('exit', code => finish(unavailable('SCRIPT_CHECK_UNAVAILABLE', `Checker exited before returning a result (${code})`)));
    });
  } catch (error) {
    return unavailable('SCRIPT_CHECK_UNAVAILABLE', (error as Error).message);
  } finally {
    try { await worker?.terminate(); } finally { active = false; }
  }
}

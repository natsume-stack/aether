import { createHash } from 'node:crypto';

export type ScriptCheckPolicy = 'strict' | 'no-new-errors';

export function bindingDiagnosticIdentity(problem: Record<string, any>): string {
  // The shared validator embeds display locations in these two strings.
  // Keep names, script identities, event names and occurrence counts intact.
  return diagnosticIdentity({ ...problem,
    lines: Array.isArray(problem.lines) ? { count: problem.lines.length } : undefined,
    path: problem.path?.replace(/@\d+$/, '@location'),
    message: problem.message?.replace(/第 \d+ 行/g, '第 <location> 行')
      .replace(/（行 [\d, ]+）/g, '（行 <locations>）'),
  });
}

/** Compare complete multisets, before any diagnostic display truncation.
 * Locations are deliberately excluded: inserting a line moves old findings.
 * Compiler identities include the diagnosed source span; UI identities include
 * all semantic context supplied by the existing binding validator.
 */
export function diagnosticIdentity(value: unknown): string {
  const stable = (item: any): any => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort()
      .filter(key => !['line', 'column', 'offset', 'index', 'retryable', 'hint'].includes(key))
      .map(key => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function compareDiagnosticErrors(baseline: string[], candidate: string[]) {
  const remaining = new Map<string, number>();
  for (const key of baseline) remaining.set(key, (remaining.get(key) || 0) + 1);
  let introduced = 0;
  for (const key of candidate) {
    const count = remaining.get(key) || 0;
    if (count) remaining.set(key, count - 1);
    else introduced++;
  }
  return { baselineErrorCount: baseline.length, candidateErrorCount: candidate.length,
    introducedErrorCount: introduced,
    resolvedErrorCount: [...remaining.values()].reduce((sum, count) => sum + count, 0) };
}

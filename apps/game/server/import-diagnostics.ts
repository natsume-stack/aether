export type ImportDiagnosticLevel = 'error' | 'warning';

export type ImportDiagnostic = {
  level: ImportDiagnosticLevel;
  message: string;
  code?: string;
};

export type ImportErrorPayload = {
  message?: unknown;
  details?: unknown;
};

export type DetailedImportError = Error & { details: ImportDiagnostic[] };

type CompatibilityIssue = {
  code?: unknown;
  level?: unknown;
  message?: unknown;
};

type CompatibilityReport = {
  errors?: unknown;
  warnings?: unknown;
};

function cleanText(value: unknown, maximum = 1000) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function diagnosticFromValue(
  value: unknown,
  level: ImportDiagnosticLevel,
): ImportDiagnostic | undefined {
  if (typeof value === 'string') {
    const message = cleanText(value);
    return message ? { level, message } : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const issue = value as CompatibilityIssue;
  const message = cleanText(issue.message);
  if (!message) return undefined;
  const code = cleanText(issue.code, 100);
  const issueLevel = issue.level === 'warning' || issue.level === 'error'
    ? issue.level
    : level;
  return code ? { level: issueLevel, code, message } : { level: issueLevel, message };
}

function diagnosticList(value: unknown, level: ImportDiagnosticLevel) {
  return (Array.isArray(value) ? value : [value])
    .map((entry) => diagnosticFromValue(entry, level))
    .filter((entry): entry is ImportDiagnostic => Boolean(entry));
}

function uniqueDiagnostics(diagnostics: ImportDiagnostic[]) {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.level}:${diagnostic.code || ''}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 200);
}

export function compatibilityDiagnostics(report: CompatibilityReport | undefined) {
  if (!report) return [];
  return uniqueDiagnostics([
    ...diagnosticList(report.errors, 'error'),
    ...diagnosticList(report.warnings, 'warning'),
  ]);
}

export function importResponseError(
  payload: ImportErrorPayload,
  status: number,
  fallback: string,
): DetailedImportError {
  const message = cleanText(payload?.message) || `${fallback}（HTTP ${status}）`;
  const error = new Error(message) as DetailedImportError;
  error.details = uniqueDiagnostics(diagnosticList(payload?.details, 'error'));
  return error;
}

function errorDiagnostics(error: unknown, primaryMessage: string): ImportDiagnostic[] {
  if (!error || typeof error !== 'object') return [];
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    errors?: unknown;
    issues?: unknown;
    cause?: unknown;
  };
  const diagnostics = [
    ...diagnosticList(candidate.details, 'error'),
    ...diagnosticList(candidate.errors, 'error'),
    ...diagnosticList(candidate.issues, 'error'),
  ];
  const nestedMessage = cleanText(candidate.cause && (candidate.cause as { message?: unknown }).message);
  if (nestedMessage && nestedMessage !== primaryMessage) {
    const nestedCode = cleanText(
      candidate.cause && (candidate.cause as { code?: unknown }).code,
      100,
    );
    diagnostics.push({
      level: 'error',
      ...(nestedCode ? { code: nestedCode } : {}),
      message: nestedMessage,
    });
  }
  return diagnostics;
}

export function serializeImportError(error: unknown): {
  message: string;
  details: ImportDiagnostic[];
} {
  const message = cleanText(error && (error as { message?: unknown }).message)
    || '导入失败，服务端未返回错误信息';
  return {
    message,
    details: uniqueDiagnostics(errorDiagnostics(error, message)),
  };
}

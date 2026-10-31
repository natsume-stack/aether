import { createHash } from 'node:crypto';

type Source = { fileId: string; name: string; isClient: boolean; text: string };
type Edit = { index: number; deleteCount: number; text: string };
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

/** Content identity includes execution side and filename, not just script text. */
export function scriptRevision(source: Source): string {
  return createHash('sha256').update(JSON.stringify([source.fileId, source.name, source.isClient, source.text])).digest('hex');
}

export function scriptReviewRevision(files: Source[], uiTree: unknown): string {
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify({
    scripts: files.map(file => [file.fileId, scriptRevision(file)]).sort((a, b) => a[0].localeCompare(b[0])), uiTree: ordered(uiTree),
  })).digest('hex');
}

/** Offsets are UTF-16 positions in the original source (as in Monaco/JS).
 * This produces review data only: no source mutation, dispatch or evaluation.
 */
export function previewScript(source: Source, expectedRevision: string, edits: Edit[]) {
  if (source.text.length > 500000) fail('SCRIPT_TOO_LARGE', 'Source exceeds 500000 UTF-16 code units');
  const revision = scriptRevision(source);
  if (expectedRevision !== revision) fail('REVISION_CONFLICT', 'Script changed after reading; regenerate patch from current source');
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 64) fail('INVALID_SCRIPT_PATCH', 'Supply 1–64 edits');
  const ordered = edits.map(edit => ({ ...edit })).sort((a, b) => a.index - b.index);
  let previous: Edit | undefined;
  let outputLength = source.text.length;
  const splitsSurrogate = (index: number) => index > 0 && index < source.text.length
    && /[\uD800-\uDBFF]/.test(source.text[index - 1]) && /[\uDC00-\uDFFF]/.test(source.text[index]);
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.index) || !Number.isSafeInteger(edit.deleteCount)
      || edit.index < 0 || edit.deleteCount < 0 || edit.index > source.text.length
      || edit.deleteCount > source.text.length - edit.index || typeof edit.text !== 'string') fail('INVALID_SCRIPT_PATCH', 'Invalid source range or replacement');
    if (previous && (edit.index === previous.index || edit.index < previous.index + previous.deleteCount)) fail('OVERLAPPING_SCRIPT_EDITS', 'Edits overlap or share an ambiguous insertion point');
    if (splitsSurrogate(edit.index) || splitsSurrogate(edit.index + edit.deleteCount)) fail('INVALID_SCRIPT_PATCH', 'An edit boundary splits a Unicode surrogate pair');
    outputLength += edit.text.length - edit.deleteCount;
    previous = edit;
  }
  if (outputLength > 500000 || ordered.reduce((sum, edit) => sum + edit.text.length, 0) > 500000) fail('SCRIPT_TOO_LARGE', 'Patch or result exceeds 500000 UTF-16 code units');
  let content = '';
  let cursor = 0;
  const changes = ordered.map(edit => {
    const removed = source.text.slice(edit.index, edit.index + edit.deleteCount);
    content += source.text.slice(cursor, edit.index) + edit.text;
    cursor = edit.index + edit.deleteCount;
    return { ...edit, removed, line: source.text.slice(0, edit.index).split('\n').length };
  });
  content += source.text.slice(cursor);
  return { success: true, fileId: source.fileId, name: source.name, isClient: source.isClient,
    baseRevision: revision, resultRevision: scriptRevision({ ...source, text: content }),
    content, changes, changed: content !== source.text, persisted: false, applied: false,
    validation: 'not-typechecked', note: 'Review only. Typecheck against project APIs and bindings before applying or saving.' };
}

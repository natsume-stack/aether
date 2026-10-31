export function shouldSaveAsMapModel(
  sourceMapId: number,
  embeddedInEngine: boolean,
) {
  if (embeddedInEngine) {
    return Number.isFinite(sourceMapId) && sourceMapId >= 0;
  }
  return sourceMapId > 0;
}

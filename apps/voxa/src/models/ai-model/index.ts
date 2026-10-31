type ExecutorResult = { success: true; value?: unknown } | { success: false };

/**
 * Local VOXA deliberately excludes the cloud AI modeler. Keeping this small
 * adapter preserves the editor interface without bundling credentials,
 * analytics, OpenAI clients, or remote generation dependencies.
 */
export class AIModel {
  public abort() {}
  public clearGeneratedRecord() {}
  public removeGenerated() {}

  public async generateShapEModel(): Promise<ExecutorResult> {
    return { success: false };
  }
}

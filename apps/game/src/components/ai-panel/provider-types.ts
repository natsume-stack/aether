export type AiProviderProtocol = 'chat-completions' | 'responses' | 'anthropic-messages';
export type AiAutonomyMode = 'review' | 'autonomous';

export type AiProviderModel = { id: string; name?: string };
export type AiProviderView = {
  id: string;
  owner: 'user' | 'admin';
  name: string;
  protocol: AiProviderProtocol;
  baseUrl: string;
  keyHint: string;
  defaultModel: string;
  models: AiProviderModel[];
  headers: Record<string, string>;
  capabilities: { tools: boolean; vision: boolean; json: boolean };
  enabled: boolean;
  isDefault: boolean;
  lastTestedAt: string | null;
  lastTestStatus: string;
};
export type AiPreferenceView = {
  workflow: string;
  providerId: string | null;
  model: string;
  autonomy: AiAutonomyMode;
};
export type AiSelection = {
  providerId: string;
  model: string;
  autonomy: AiAutonomyMode;
};

export const PROTOCOL_LABELS: Record<AiProviderProtocol, string> = {
  'chat-completions': 'Chat Completions（OpenAI 兼容）',
  responses: 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

export const PROTOCOL_PLACEHOLDERS: Record<AiProviderProtocol, string> = {
  'chat-completions': 'https://api.openai.com/v1',
  responses: 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
};

export const WORKFLOW_ID = 'map.coauthor';

export function providerModelOptions(providers: AiProviderView[]) {
  return providers.filter(provider => provider.enabled).flatMap((provider) => {
    const models = provider.models.length
      ? provider.models
      : provider.defaultModel
        ? [{ id: provider.defaultModel }]
        : [];
    const withDefault = provider.defaultModel && !models.some((model) => model.id === provider.defaultModel)
      ? [{ id: provider.defaultModel }, ...models]
      : models;
    return withDefault.map((model) => ({
      key: `${provider.id}:${model.id}`,
      provider,
      model,
    }));
  });
}

export function findModel(providers: AiProviderView[], providerId: string, modelId: string) {
  const provider = providers.find((item) => item.id === providerId);
  return {
    provider,
    model: provider?.models.find((item) => item.id === modelId),
  };
}

export function defaultSelection(
  providers: AiProviderView[],
  preference?: Partial<AiPreferenceView> | null,
): AiSelection {
  providers = providers.filter(provider => provider.enabled);
  const savedProvider = providers.find((provider) => provider.id === preference?.providerId);
  const provider = savedProvider || providers[0];
  if (!provider) return { providerId: '', model: 'FAST', autonomy: preference?.autonomy || 'review' };
  const savedModel = provider.models.find((model) => model.id === preference?.model)?.id;
  return {
    providerId: provider.id,
    model: savedModel || provider.defaultModel || provider.models[0]?.id || '',
    autonomy: preference?.autonomy || 'review',
  };
}

/** The wire keeps `model` as MuUTF8; JSON is the new panel's selection envelope. */
export function encodeSelection(selection: AiSelection) {
  if (!selection.providerId) return 'FAST';
  return JSON.stringify({
    providerId: selection.providerId,
    model: selection.model,
    autonomy: selection.autonomy,
  });
}

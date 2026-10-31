import { MuRemoteClient, MuServer, MuServerProtocol } from '@box/mudb/server';
import { AiProtocol } from '@box/schema/ai/ai-protocol.schema';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { FeatureFlag } from '@box/env/constants';
import {
  streamText,
  convertToModelMessages,
  ModelMessage,
  stepCountIs,
  UIMessage,
} from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'pino';
import { CodeEditorServerController } from '../code-editor/code-editor-server-controller';
import { EditServerState } from '../edit-server-schema';
import { EditReplicaServer } from '../replica/replica-server';
import { createEntityTools, createScriptTools } from './entity-tools';
import { createMapAuthoringTools } from './map-authoring-tools';
import { coordinateAuthoring } from './authoring-tools';
import { executionTools, type ExecutionMode } from './execution-policy';
import { assertAiExecutionAllowed } from './provider-gateway';
import {
  parseModelSelection,
  providerLanguageModel,
  resolveUserProvider,
} from './provider-gateway';

/**
 * LLM 生成选项
 */
export interface LlmGenerateOptions {
  /** 模型名称，如不指定则使用默认模型 */
  model: string;
  /** 最大 token 数，控制生成内容的长度上限 */
  maxTokens?: number;
}

/**
 * AI 服务器类
 * 负责处理通过 MuDB 协议的 AI 对话请求，集成 Vercel AI SDK
 * 参考 DebuggerServer 的设计模式，提供实时的 LLM 交互能力
 */
export class AiServer {
  private logger: Logger;
  private protocol: MuServerProtocol<typeof AiProtocol>;
  private state: EditServerState;
  private replica: EditReplicaServer;
  private tools: ReturnType<typeof createEntityTools> &
    ReturnType<typeof createScriptTools> &
    ReturnType<typeof createMapAuthoringTools>;
  private abortControllers = new Map<string, AbortController>();

  private requestKey(sessionId: string, requestId: string) {
    return JSON.stringify([sessionId, requestId]);
  }
  private openRouter: ReturnType<typeof createOpenRouter>;
  /**
   * 临时处理
   */
  private openAiRouter: any;
  private featureFlags?: string[];

  private apiContext: string;
  private modelMapping: Record<string, string[]>;
  private gameId: number;

  private getSystemPrompt(mapSize: { x: number; y: number; z: number }) {
    return `
You are an expert game developer using the Box Engine. Box Engine is a Minecraft-like game engine where terrain can be edited via voxels.
Here are the API definitions you can use in scripts:
\`\`\`typescript
${this.apiContext}
\`\`\`

Game System Mechanics:
- Map Size: ${mapSize.x}x${mapSize.y}x${mapSize.z}
- Coordinate System: Origin (0, 0, 0) is at the bottom-left corner.
- Default Ground Height: 8
- Basic Controls: The engine automatically handles player movement, jumping, and physics. You do not need to implement these. Focus on game logic.

Scripting Rules:
- Server Scripts: Use CommonJS format. The entry file is 'index.js'.
- Client Scripts: The entry file is 'clientIndex.js'. Do NOT generate client scripts. The client API is currently not supported.
- Models: You must only use models that are already added to the project.
- Public Models: Before using a public model, you must add it to the project first.

When writing scripts, strictly follow these API definitions.
`;
  }

  /**
   * 检查用户是否有权限使用 AI 功能
   */
  private canUseAI(sessionId: string): boolean {
    const permissions = this.state.replica.sessionPermission[sessionId];
    return !!(permissions && permissions.owner);
  }

  /**
   * 使用 Vercel AI SDK 执行 LLM 调用 (流式)
   * @param messages 客户端发送过来的完整对话
   */
  private async generateStream(
    client: MuRemoteClient<typeof AiProtocol.client>,
    requestId: string,
    messages: ModelMessage[],
    candidateModels: string[],
    options: LlmGenerateOptions,
    modelFactory?: (model: string) => ReturnType<typeof providerLanguageModel>,
    providerLabel?: string,
    mode: ExecutionMode = 'review',
  ): Promise<void> {
    const sessionId = client.sessionId;
    const abortController = new AbortController();
    const requestKey = this.requestKey(sessionId, requestId);
    if (this.abortControllers.has(requestKey)) {
      client.message.error({ requestId, message: 'AI request is already running' });
      return;
    }
    this.abortControllers.set(requestKey, abortController);
    const timeout = setTimeout(() => abortController.abort(), 180_000);
    let outputStarted = false;
    let toolStarted = false;
    try {

    let lastError: any;

    // Check if silconFlow feature flag is enabled before selecting provider
    const useSilconFlow = this.featureFlags?.includes(FeatureFlag.SilconFlow);

    for (const model of candidateModels) {
      try {
        if (abortController.signal.aborted) return;

        const aiModel = modelFactory
          ? modelFactory(model)
          : useSilconFlow
            ? this.openAiRouter
            : this.openRouter.chat(model, {
                reasoning: { enabled: true, effort: 'medium' },
              });

        this.logger.debug(
          {
            sessionId,
            model,
            provider: providerLabel || (useSilconFlow ? 'siliconflow' : 'openrouter'),
          },
          'Selected AI provider and model',
        );

        this.logger.info(
          { sessionId, messageCount: messages.length, model },
          'Sending messages to LLM',
        );

        const shape = this.state.replica.project.voxels.shape;
        const systemPrompt = this.getSystemPrompt(shape) + (mode === 'review'
          ? '\nCreate proposals and plans only. Explain them and wait for the human to approve in the review panel. Do not claim changes have been applied.'
          : '\nUse authoring proposals and apply tools to edit. Writes are snapshotted and saved automatically. Stop after any uncertain result.');

        // 调用 Vercel AI SDK Agent
        const settings = {
          model: aiModel,
          tools: executionTools(this.tools, {
            mode, signal: abortController.signal, maxCalls: 100,
            authorizeWrite: async () => {
              if (!this.canUseAI(sessionId)) throw new Error('AI permission revoked');
              if (this.state.game.state.replica.running) throw new Error('Stop preview before AI writes');
              await assertAiExecutionAllowed(String(this.state.replica.sessionPermission[sessionId]?.userId || ''), String(this.gameId));
              toolStarted = true;
            },
            save: () => this.replica.saveProject(Number(this.state.replica.sessionPermission[sessionId]?.userId || 0)),
            audit: (event) => this.logger.info({sessionId, requestId, mode, ...event}, 'AI execution audit'),
          }),
          system: systemPrompt,
          stopWhen: stepCountIs(20),
          maxOutputTokens: 16384,
        };

        const result = streamText({
          ...settings,
          messages,
          abortSignal: abortController.signal,
          providerOptions: modelFactory || useSilconFlow
            ? undefined
            : {
                openrouter: {
                  reasoning: {
                    max_tokens: 100000,
                  },
                },
              },
        });

        const uiStream = result.toUIMessageStream();

        // 处理流式文本
        for await (const part of uiStream) {


          // Check for error in stream part
          if (part.type === 'error') {
            throw new Error(part.errorText);
          }

          if (abortController.signal.aborted) {
            break;
          }
          outputStarted = true;
          // 发送流式块到客户端
          client.message.streamChunk({
            requestId,
            chunk: JSON.stringify(part),
            done: false,
          });
        }

        if (abortController.signal.aborted) {
          this.logger.info({ sessionId, requestId }, 'AI generation aborted');
          return;
        }

        client.message.streamChunk({
          requestId,
          chunk: '',
          done: true,
        });

        this.logger.info({ sessionId, requestId, model }, 'AI generation completed');

        // Success, return
        return;
      } catch (err: any) {
        lastError = err;
        if (abortController.signal.aborted) return;

        this.logger.error(
          { sessionId, model, errorName: err?.name },
          'Model generation failed, trying next model if available',
        );
        if (outputStarted || toolStarted) break;
        continue;
      }
    }

    // If we exhausted all models or hit a non-retriable error
    if (lastError) {
      if (abortController.signal.aborted) {
        this.logger.info(
          { sessionId, requestId },
          'AI generation aborted (catch)',
        );
      } else {
        this.logger.error(
          { sessionId, errorName: lastError?.name },
          'AI generation failed',
        );

        client.message.error({
          requestId,
          message: `AI generation failed.`,
        });
      }
    }

    } finally {
      clearTimeout(timeout);
      if (abortController.signal.aborted) {
        client.message.streamChunk({ requestId, chunk: '', done: true });
      }
      this.abortControllers.delete(requestKey);
    }
  }

  constructor(spec: {
    server: MuServer;
    state: EditServerState;
    replica: EditReplicaServer;
    logger: Logger;
    gameId: number;
    codeEditorController: CodeEditorServerController;
    openRouterApiKey: string;
    featureFlags?: string[];
    aiModelMapping: Record<string, string[]>;
  }) {
    this.logger = spec.logger;
    this.gameId = spec.gameId;
    this.state = spec.state;
    this.replica = spec.replica;
    this.protocol = spec.server.protocol(AiProtocol);
    this.modelMapping = spec.aiModelMapping;
    this.featureFlags = spec.featureFlags;

    this.openRouter = createOpenRouter({
      apiKey: spec.openRouterApiKey,
    });
    this.openAiRouter = createOpenAICompatible({
      baseURL: 'https://api.siliconflow.cn/v1',
      name: 'silconflow',
      apiKey: spec.openRouterApiKey,
    }).chatModel('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B');

    try {
      this.apiContext = fs.readFileSync(
        path.join(__dirname, 'llm-context.d.ts'),
        'utf-8',
      );
    } catch (error) {
      this.logger.error({ error }, 'Failed to load llm-context.d.ts');
      this.apiContext = '// API definitions not available';
    }

    const entityTools = createEntityTools(
      this.replica,
      this.state,
      spec.gameId,
      this.logger,
    );
    const scriptTools = createScriptTools(
      this.state,
      spec.codeEditorController,
      this.logger,
    );
    const mapAuthoringTools = createMapAuthoringTools(
      this.replica,
      this.state,
      spec.gameId,
      this.logger,
    );

    this.tools = coordinateAuthoring(this.state, {
      ...entityTools,
      ...scriptTools,
      ...mapAuthoringTools,
    }) as typeof this.tools;

    // 配置协议消息处理器
    this.protocol.configure({
      message: {
        sendMessage: async (client, { requestId, messages, model }) => {
          // 验证权限；新面板的渠道必须绑定到当前会话的真实用户
          const sessionPermission = this.state.replica.sessionPermission[client.sessionId];
          if (!this.canUseAI(client.sessionId) || !sessionPermission?.userId) {
            client.message.error({
              requestId,
              message: 'AI 功能未获授权',
            });
            return;
          }

          const sessionId = client.sessionId;
          if ([...this.abortControllers.keys()].some(key => JSON.parse(key)[0] === sessionId)) {
            client.message.error({ requestId, message: 'An AI request is already running; stop it first' });
            return;
          }
          if (messages.length > 2_000_000) {
            client.message.error({ requestId, message: 'AI conversation is too large; start a new chat' });
            return;
          }

          this.logger.info(
            { sessionId, model },
            'Received message from client',
          );

          // 解析消息历史
          let modelMessages: ModelMessage[] = [];
          try {
            const uiMessages: UIMessage[] = JSON.parse(messages);
            modelMessages = convertToModelMessages(uiMessages);
          } catch (e) {
            this.logger.error(
              { sessionId, error: e },
              'Failed to parse messages',
            );
            client.message.error({
              requestId,
              message: '消息格式错误',
            });
            return;
          }

          // 新面板把「渠道 + 模型 + 自主度」编码在 model 字段；旧的 FAST/PRO 仍走环境变量兜底
          const selection = parseModelSelection(model);
          const usesUserProvider = Boolean(selection.providerId) ||
            Boolean(selection.model && !this.modelMapping[selection.model]);
          if (usesUserProvider) {
            try {
              const provider = await resolveUserProvider(
                String(sessionPermission.userId),
                selection.providerId,
                this.logger,
              );
              const selectedModel = selection.model || provider.defaultModel || provider.models[0]?.id || '';
              if (!selectedModel) {
                client.message.error({ requestId, message: '请先为渠道选择模型' });
                return;
              }
              this.logger.info(
                { sessionId, providerId: provider.id, provider: provider.name, model: selectedModel, autonomy: selection.autonomy },
                'Using user provider',
              );
              await this.generateStream(
                client,
                requestId,
                modelMessages,
                [selectedModel],
                { model: selectedModel },
                (requested) => providerLanguageModel(provider, requested),
                `${provider.owner}:${provider.protocol}:${provider.name}`,
                selection.autonomy,
              );
              return;
            } catch (error) {
              this.logger.error({ sessionId, error }, 'User provider request failed');
              client.message.error({
                requestId,
                message: (error as Error).message || 'AI 渠道不可用',
              });
              return;
            }
          }

          let candidateModels: string[] = [];
          if (this.modelMapping[selection.model || model]) {
            candidateModels = this.modelMapping[selection.model || model];
          } else {
            client.message.error({ requestId, message: `Unsupported model selection: ${model}` });
            return;
          }

          const options: LlmGenerateOptions = {
            model: candidateModels[0],
          };

          // 执行 LLM 调用
          await this.generateStream(
            client,
            requestId,
            modelMessages,
            candidateModels,
            options,
          );
        },

        abort: (client, { requestId }) => {
          const controller = this.abortControllers.get(this.requestKey(client.sessionId, requestId));
          if (controller) {
            controller.abort();
            this.logger.info({ requestId }, 'Aborted AI generation');
          }
        },
      },
    });
  }

  /**
   * 清理资源，移除已断开连接的会话
   */
  public cleanup(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
  }
}

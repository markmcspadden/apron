/**
 * Gemini client — wraps @google/genai SDK (hackathon-required package).
 *
 * Uses Vertex AI backend when GOOGLE_CLOUD_PROJECT is set, falls back to
 * a fixture-mode stub otherwise.
 *
 * When an Agento11yClient is attached, every generation is traced via
 * the @grafana/agento11y SDK so telemetry flows to Grafana Cloud.
 */

import { GoogleGenAI } from '@google/genai';

/** Minimal interface for the Agent O11y client — avoids a hard dependency on @grafana/agento11y. */
interface AgentO11yClientLike {
  startGeneration<TResult>(
    start: {
      agentName?: string;
      conversationId?: string;
      model: { provider: string; name: string };
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      tools?: { name: string; description?: string }[];
      tags?: Record<string, string>;
      metadata?: Record<string, unknown>;
    },
    callback: (recorder: {
      setResult(result: {
        input?: { role: string; content?: string }[];
        output?: { role: string; content?: string }[];
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      }): void;
      setCallError(error: unknown): void;
    }) => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

export interface GeminiConfig {
  project: string;
  location: string;
  model?: string;
}

export interface AgentPrompt {
  agent: string;
  systemInstruction: string;
  context: Record<string, unknown>;
  query: string;
  /** Override max output tokens (default 2048). Extraction needs more. */
  maxOutputTokens?: number;
  /** JSON Schema for Gemini Structured Outputs — enforces type-safe keys. */
  responseSchema?: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  metadata: {
    model: string;
    tokensUsed: number;
    latencyMs: number;
  };
}

/** Callbacks for Agent O11y generation tracking. */
interface O11yCallbacks {
  onExported?: () => void;
  onError?: (err: string) => void;
}

export class GeminiClient {
  private client: GoogleGenAI | null;
  private model: string;
  private enabled: boolean;
  private mode: 'vertex' | 'apikey' | 'fixture';
  private o11yClient: AgentO11yClientLike | null = null;
  private o11yToolDefs: (agentName: string) => { name: string; description?: string }[] = () => [];
  private o11yCallbacks: O11yCallbacks = {};

  constructor(config?: Partial<GeminiConfig>) {
    const apiKey = process.env['GEMINI_API_KEY'] ?? '';
    const project = config?.project ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? '';
    const location = config?.location ?? process.env['GOOGLE_CLOUD_LOCATION'] ?? 'us-central1';
    this.model = config?.model ?? 'gemini-2.5-flash';

    if (project) {
      // Vertex AI with ADC — recommended for hackathon / production
      this.client = new GoogleGenAI({
        vertexai: true,
        project,
        location,
      });
      this.enabled = true;
      this.mode = 'vertex';
    } else if (apiKey) {
      // API key fallback — for local testing without a GCP project
      this.client = new GoogleGenAI({ apiKey });
      this.enabled = true;
      this.mode = 'apikey';
    } else {
      this.client = null;
      this.enabled = false;
      this.mode = 'fixture';
    }
  }

  /**
   * Attach an Agent O11y client for generation tracing.
   * Call once after construction, before any prompts.
   */
  attachO11y(
    client: AgentO11yClientLike,
    toolDefsFn: (agentName: string) => { name: string; description?: string }[],
    callbacks?: O11yCallbacks,
  ): void {
    this.o11yClient = client;
    this.o11yToolDefs = toolDefsFn;
    this.o11yCallbacks = callbacks ?? {};
    console.log('[gemini] Agent O11y tracing attached');
  }

  async prompt(request: AgentPrompt): Promise<AgentResponse> {
    if (!this.enabled || !this.client) {
      return {
        text: `[fixture mode] ${request.agent} would process: ${request.query}`,
        metadata: { model: 'fixture', tokensUsed: 0, latencyMs: 0 },
      };
    }

    const start = Date.now();
    const contents = `Context:\n${JSON.stringify(request.context, null, 2)}\n\n${request.query}`;

    // If Agent O11y is attached, wrap the call in a traced generation
    if (this.o11yClient) {
      return this.tracedGeneration(request, contents, async () => {
        const response = await this.client!.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: request.systemInstruction,
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        });

        const text = response.text ?? '';
        const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

        return {
          text,
          tokensUsed,
          inputTokens: response.usageMetadata?.promptTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount,
          latencyMs: Date.now() - start,
        };
      });
    }

    // No O11y — direct call
    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: request.systemInstruction,
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    });

    const text = response.text ?? '';
    const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

    return {
      text,
      metadata: {
        model: this.model,
        tokensUsed,
        latencyMs: Date.now() - start,
      },
    };
  }

  /**
   * Prompt Gemini expecting a JSON response.
   *
   * Uses the native `responseMimeType: 'application/json'` so the model is
   * constrained to output valid JSON — no markdown fences, no preamble.
   * Falls back to manual parsing if the native mode somehow fails.
   */
  async promptJSON<T = Record<string, unknown>>(request: AgentPrompt): Promise<T | null> {
    if (!this.enabled || !this.client) {
      return null;
    }

    const start = Date.now();
    const contents = `Context:\n${JSON.stringify(request.context, null, 2)}\n\n${request.query}`;

    const contextKeys = Object.keys(request.context);
    const contextSizes = contextKeys.map(k => `${k}:${JSON.stringify(request.context[k]).length}`).join(', ');
    console.log(`[gemini] ${request.agent} promptJSON — context: {${contextSizes}}, maxTokens: ${request.maxOutputTokens ?? 2048}`);

    const config: Record<string, unknown> = {
      systemInstruction: request.systemInstruction,
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: request.maxOutputTokens ?? 2048,
    };

    if (request.responseSchema) {
      config['responseSchema'] = request.responseSchema;
    }

    // If Agent O11y is attached, wrap the call in a traced generation
    if (this.o11yClient) {
      const result = await this.tracedGeneration(request, contents, async () => {
        const response = await this.client!.models.generateContent({
          model: this.model,
          contents,
          config,
        });

        const text = response.text ?? '';
        const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

        return {
          text,
          tokensUsed,
          inputTokens: response.usageMetadata?.promptTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount,
          latencyMs: Date.now() - start,
        };
      });

      try {
        return JSON.parse(result.text) as T;
      } catch {
        console.warn(`[gemini] ${request.agent}: JSON parse failed (${result.text.length} chars)`);
        return null;
      }
    }

    // No O11y — direct call
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config,
      });

      const text = response.text ?? '';
      const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;
      const latencyMs = Date.now() - start;

      console.log(`[gemini] ${request.agent} response (${tokensUsed} tokens, ${latencyMs}ms):`, text.slice(0, 300));

      try {
        return JSON.parse(text) as T;
      } catch {
        console.warn(`[gemini] ${request.agent}: JSON parse failed despite responseMimeType (${text.length} chars). Raw head:`, text.replace(/\n/g, '\\n').slice(0, 300));
        return null;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const shortErr = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
      console.warn(`[gemini] ${request.agent} API error:`, shortErr);
      throw err;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getMode(): string {
    return this.mode;
  }

  // ---------------------------------------------------------------------------
  // Agent O11y tracing
  // ---------------------------------------------------------------------------

  private async tracedGeneration(
    request: AgentPrompt,
    contents: string,
    execute: () => Promise<{
      text: string;
      tokensUsed: number;
      inputTokens?: number;
      outputTokens?: number;
      latencyMs: number;
    }>,
  ): Promise<AgentResponse> {
    const agentName = `apron-${request.agent.toLowerCase()}`;
    const tools = this.o11yToolDefs(request.agent);

    return this.o11yClient!.startGeneration(
      {
        agentName,
        model: { provider: 'google', name: this.model },
        systemPrompt: request.systemInstruction,
        temperature: 0.1,
        maxTokens: request.maxOutputTokens ?? 2048,
        tools: tools.length > 0 ? tools : undefined,
        tags: { agent: request.agent },
        metadata: {
          contextKeys: Object.keys(request.context),
        },
      },
      async (recorder) => {
        try {
          const result = await execute();

          recorder.setResult({
            input: [{ role: 'user', content: contents }],
            output: [{ role: 'assistant', content: result.text }],
            usage: {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              totalTokens: result.tokensUsed,
            },
          });

          this.o11yCallbacks.onExported?.();

          return {
            text: result.text,
            metadata: {
              model: this.model,
              tokensUsed: result.tokensUsed,
              latencyMs: result.latencyMs,
            },
          };
        } catch (err) {
          recorder.setCallError(err);
          const errMsg = err instanceof Error ? err.message : String(err);
          this.o11yCallbacks.onError?.(errMsg);
          throw err;
        }
      },
    );
  }
}

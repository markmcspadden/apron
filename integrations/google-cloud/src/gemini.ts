/**
 * Gemini client — wraps @google/genai SDK (hackathon-required package).
 *
 * Uses Vertex AI backend when GOOGLE_CLOUD_PROJECT is set, falls back to
 * a fixture-mode stub otherwise.
 */

import { GoogleGenAI } from '@google/genai';

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

export class GeminiClient {
  private client: GoogleGenAI | null;
  private model: string;
  private enabled: boolean;
  private mode: 'vertex' | 'apikey' | 'fixture';

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

  async prompt(request: AgentPrompt): Promise<AgentResponse> {
    if (!this.enabled || !this.client) {
      return {
        text: `[fixture mode] ${request.agent} would process: ${request.query}`,
        metadata: { model: 'fixture', tokensUsed: 0, latencyMs: 0 },
      };
    }

    const start = Date.now();

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: `Context:\n${JSON.stringify(request.context, null, 2)}\n\n${request.query}`,
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

    const contextKeys = Object.keys(request.context);
    const contextSizes = contextKeys.map(k => `${k}:${JSON.stringify(request.context[k]).length}`).join(', ');
    console.log(`[gemini] ${request.agent} promptJSON — context: {${contextSizes}}, maxTokens: ${request.maxOutputTokens ?? 2048}`);

    try {
      const config: Record<string, unknown> = {
        systemInstruction: request.systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: request.maxOutputTokens ?? 2048,
      };

      // Gemini Structured Outputs — enforces valid JSON matching the schema
      if (request.responseSchema) {
        config['responseSchema'] = request.responseSchema;
      }

      const response = await this.client.models.generateContent({
        model: this.model,
        contents: `Context:\n${JSON.stringify(request.context, null, 2)}\n\n${request.query}`,
        config,
      });

      const text = response.text ?? '';
      const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;
      const latencyMs = Date.now() - start;

      console.log(`[gemini] ${request.agent} response (${tokensUsed} tokens, ${latencyMs}ms):`, text.slice(0, 300));

      try {
        return JSON.parse(text) as T;
      } catch {
        // responseMimeType should prevent this, but guard against it
        console.warn(`[gemini] ${request.agent}: JSON parse failed despite responseMimeType (${text.length} chars). Raw head:`, text.replace(/\n/g, '\\n').slice(0, 300));
        return null;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const shortErr = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
      console.warn(`[gemini] ${request.agent} API error:`, shortErr);
      throw err; // let caller handle
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getMode(): string {
    return this.mode;
  }
}

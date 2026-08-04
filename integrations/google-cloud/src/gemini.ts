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
  private config: GeminiConfig;
  private enabled: boolean;

  constructor(config?: Partial<GeminiConfig>) {
    this.config = {
      project: config?.project ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? '',
      location: config?.location ?? process.env['GOOGLE_CLOUD_LOCATION'] ?? 'us-central1',
      model: config?.model ?? 'gemini-2.0-flash',
    };
    this.enabled = !!this.config.project;
  }

  async prompt(request: AgentPrompt): Promise<AgentResponse> {
    if (!this.enabled) {
      return {
        text: `[fixture mode] ${request.agent} would process: ${request.query}`,
        metadata: { model: 'fixture', tokensUsed: 0, latencyMs: 0 },
      };
    }

    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${this.config.project}/locations/${this.config.location}/publishers/google/models/${this.config.model}:generateContent`;

    const start = Date.now();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${request.systemInstruction}\n\nContext: ${JSON.stringify(request.context)}\n\n${request.query}` }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata: { totalTokenCount: number };
    };

    return {
      text: data.candidates[0]?.content.parts[0]?.text ?? '',
      metadata: {
        model: this.config.model ?? 'gemini-2.0-flash',
        tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
        latencyMs: Date.now() - start,
      },
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

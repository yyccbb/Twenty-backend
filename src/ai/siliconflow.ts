import OpenAI from 'openai';
import type { AiJsonCompletion, AiMessage, AiProvider } from './provider.js';

/** DeepSeek Flash through SiliconFlow's OpenAI-compatible API. */
export class SiliconFlowProvider implements AiProvider {
  readonly name = 'siliconflow';
  private readonly client: OpenAI;

  constructor(
    options: { apiKey: string; baseURL: string; timeoutMs: number },
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, timeout: options.timeoutMs, maxRetries: 1 });
  }

  async completeJson(messages: AiMessage[], options: { signal?: AbortSignal } = {}): Promise<AiJsonCompletion> {
    const res = await this.client.chat.completions.create(
      { model: this.model, messages, response_format: { type: 'json_object' }, temperature: 0.3 },
      { signal: options.signal },
    );
    return {
      content: res.choices[0]?.message?.content ?? '',
      model: res.model || this.model,
      tokensUsed: res.usage?.total_tokens ?? null,
    };
  }
}

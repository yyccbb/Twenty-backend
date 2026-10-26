import OpenAI from 'openai';
import type { AiJsonCompletion, AiMessage, AiProvider } from './provider.js';

/** Qwen through Alibaba Cloud Model Studio's OpenAI-compatible endpoint. */
export class QwenProvider implements AiProvider {
  readonly name = 'qwen';
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

import type { Config } from '../config.js';
import { FakeAiProvider } from './fake.js';
import type { AiProvider } from './provider.js';
import { QwenProvider } from './qwen.js';

export type { AiProvider } from './provider.js';
export { AiOutputError, BREAKDOWN_PROMPT_VERSION, generateBreakdown } from './breakdown.js';

export function createAiProvider(config: Config): AiProvider {
  switch (config.AI_PROVIDER) {
    case 'qwen':
      return new QwenProvider(
        { apiKey: config.QWEN_API_KEY!, baseURL: config.QWEN_BASE_URL, timeoutMs: config.AI_TIMEOUT_MS },
        config.QWEN_MODEL,
      );
    case 'fake':
      return new FakeAiProvider();
  }
}
